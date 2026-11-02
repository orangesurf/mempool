/**
 * Output-descriptor parsing and address derivation for watch-only wallets.
 *
 * Built on audited libraries only: @scure/bip32 for public-key derivation and
 * @scure/btc-signer for script and address encoding (both on @noble/curves). No
 * elliptic-curve or BIP-32 maths is implemented here.
 *
 * Supported (BIP-380 subset, public keys only):
 *   pkh(KEY)  sh(wpkh(KEY))  wpkh(KEY)  tr(KEY)
 *   wsh(multi|sortedmulti(k, KEY, ...))  sh(wsh(multi|sortedmulti(k, KEY, ...)))
 * where KEY = [fingerprint/origin/path]xpub/<steps>/<a;b>/<steps>/*  (unhardened steps)
 *
 * Every key must be a canonical xpub/tpub (normalize SLIP-132 keys first), ranged
 * (ending in `*`), and contain at most one multipath element (BIP-389). At least one key
 * must have a multipath element, so the descriptor
 * covers both the receive and change chains. Multisig allows up to 20 keys (BIP-383) and
 * repeated keys, as Bitcoin Core does.
 *
 * Whitespace inside a descriptor is rejected rather than stripped: stripping would turn
 * `/1 0/` into `/10/`, and the stored descriptor text must be exactly what was derived,
 * because the wallet re-derives from that stored text later.
 */

import { HDKey } from '@scure/bip32';
import { hex } from '@scure/base';
import { NETWORK, Script, TEST_NETWORK, p2pkh, p2sh, p2tr, p2wpkh, p2wsh } from '@scure/btc-signer';
import { InputError, InputErrorCode, InputErrorParams } from '@app/watch/derivation.messages';
import { WatchNetwork } from '@app/watch/watch.types';

/** Script type names, kept identical to those stored by earlier versions of the wallet. */
export type DescType = 'Pkh' | 'ShWpkh' | 'Wpkh' | 'Tr' | 'Wsh' | 'ShWsh';

const HARDENED = 0x80000000;
const MAX_MULTISIG_KEYS = 20;
const TPUB_VERSIONS = { private: 0x04358394, public: 0x043587cf };

export interface DescriptorKey {
  /** Master fingerprint from the key origin, lower-case hex, if given. */
  originFingerprint?: string;
  /** Origin path after the fingerprint, e.g. [84 | HARDENED, 0 | HARDENED, 0 | HARDENED]. */
  originPath: number[];
  /** The extended key exactly as written. */
  xpub: string;
  key: HDKey;
  /** Unhardened steps between the xpub and the multipath element (all steps if it has none). */
  prefixSteps: number[];
  /** The `<a;b;…>` values. */
  multipath: number[] | null;
  /** Unhardened steps between the multipath element and the trailing `*`. */
  suffixSteps: number[];
}

export interface ParsedDescriptor {
  descType: DescType;
  keys: DescriptorKey[];
  /** Multisig only. */
  threshold?: number;
  sorted?: boolean;
  multipathLen: number;
}

export interface DerivedAddress {
  address: string;
  scriptPubKey: string;
}

function fail(code: InputErrorCode, params?: InputErrorParams): never {
  throw new InputError(code, params);
}

function parsePathStep(step: string, allowHardened: boolean): number {
  const match = /^(\d+)(['hH]?)$/.exec(step);
  if (!match) {
    fail('descriptor-step-invalid', { step });
  }
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value) || value >= HARDENED) {
    fail('descriptor-step-range', { step });
  }
  if (match[2]) {
    if (!allowHardened) {
      fail('descriptor-hardened-step');
    }
    return value + HARDENED;
  }
  return value;
}

function parseKey(text: string): DescriptorKey {
  let rest = text.trim();
  let originFingerprint: string | undefined;
  const originPath: number[] = [];

  if (rest.startsWith('[')) {
    const end = rest.indexOf(']');
    if (end < 0) {
      fail('descriptor-origin-unclosed');
    }
    const parts = rest.slice(1, end).split('/');
    if (!/^[0-9a-fA-F]{8}$/.test(parts[0])) {
      fail('descriptor-origin-fingerprint');
    }
    originFingerprint = parts[0].toLowerCase();
    for (const step of parts.slice(1)) {
      originPath.push(parsePathStep(step, true));
    }
    rest = rest.slice(end + 1);
  }

  const segments = rest.split('/');
  const xpub = segments[0];
  if (!/^(xpub|tpub)[1-9A-HJ-NP-Za-km-z]+$/.test(xpub)) {
    if (/^(0[23][0-9a-fA-F]{64}|[0-9a-fA-F]{64}|04[0-9a-fA-F]{128})$/.test(xpub)) {
      fail('descriptor-fixed-key');
    }
    fail('descriptor-key-type');
  }
  let key: HDKey;
  try {
    key = HDKey.fromExtendedKey(xpub, xpub.startsWith('tpub') ? TPUB_VERSIONS : undefined);
  } catch (e) {
    fail('descriptor-key-invalid', { reason: e instanceof Error ? e.message : String(e) });
  }
  if (key.privateKey) {
    fail('private-key');
  }

  const steps = segments.slice(1);
  if (steps[steps.length - 1] !== '*') {
    fail('descriptor-key-unranged');
  }
  const body = steps.slice(0, -1);
  if (body.includes('*')) {
    fail('descriptor-wildcard');
  }
  const multipathAt = body.map((s, i) => (s.startsWith('<') ? i : -1)).filter((i) => i >= 0);
  if (multipathAt.length > 1) {
    fail('descriptor-multipath-count');
  }
  if (multipathAt.length === 0) {
    // A key without a multipath element uses the same path on every chain (BIP-389), e.g. one
    // single-path cosigner in an otherwise multipath multisig.
    const prefixSteps = body.map((s) => parsePathStep(s, false));
    return { originFingerprint, originPath, xpub, key, prefixSteps, multipath: null, suffixSteps: [] };
  }
  const multipathMatch = /^<([^<>]+)>$/.exec(body[multipathAt[0]]);
  if (!multipathMatch) {
    fail('descriptor-multipath-invalid', { element: body[multipathAt[0]] });
  }
  const multipath = multipathMatch[1].split(';').map((s) => parsePathStep(s, false));
  if (multipath.length < 2) {
    fail('descriptor-multipath-short');
  }
  if (new Set(multipath).size !== multipath.length) {
    fail('descriptor-multipath-duplicate');
  }
  const prefixSteps = body.slice(0, multipathAt[0]).map((s) => parsePathStep(s, false));
  const suffixSteps = body.slice(multipathAt[0] + 1).map((s) => parsePathStep(s, false));

  return { originFingerprint, originPath, xpub, key, prefixSteps, multipath, suffixSteps };
}

/** Split on commas that are not inside brackets or parentheses. */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
    } else if (c === ',' && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/** `name(inner)` → [name, inner], requiring the parenthesis to close at the very end. */
function unwrap(text: string): [string, string] | null {
  const match = /^([a-z]+)\((.*)\)$/s.exec(text.trim());
  if (!match) {
    return null;
  }
  let depth = 0;
  const inner = match[2];
  for (const c of inner) {
    if (c === '(') {
      depth++;
    } else if (c === ')' && --depth < 0) {
      return null;
    }
  }
  return depth === 0 ? [match[1], inner] : null;
}

function parseMulti(text: string): { keys: DescriptorKey[]; threshold: number; sorted: boolean } {
  const call = unwrap(text);
  if (!call || (call[0] !== 'multi' && call[0] !== 'sortedmulti')) {
    fail('descriptor-wsh-inner');
  }
  const args = splitTopLevel(call[1]);
  if (!/^\d+$/.test(args[0].trim())) {
    fail('descriptor-threshold-number');
  }
  const threshold = Number(args[0].trim());
  const keys = args.slice(1).map(parseKey);
  if (keys.length < 1 || keys.length > MAX_MULTISIG_KEYS) {
    fail('descriptor-multisig-keys', { max: MAX_MULTISIG_KEYS });
  }
  if (threshold < 1 || threshold > keys.length) {
    fail('descriptor-threshold-range');
  }
  return { keys, threshold, sorted: call[0] === 'sortedmulti' };
}

/**
 * Parse a descriptor (without checksum; validate and strip it first).
 * Throws an InputError, worded by input-errors.ts, for anything unsupported.
 */
export function parseDescriptor(descriptor: string): ParsedDescriptor {
  const text = descriptor.trim();
  if (/\s/.test(text)) {
    fail('descriptor-whitespace');
  }
  if (text.includes('#')) {
    fail('descriptor-checksum-present');
  }
  const outer = unwrap(text);
  if (!outer) {
    fail('descriptor-unrecognized');
  }
  const [fn, inner] = outer;

  let result: Omit<ParsedDescriptor, 'multipathLen'>;
  switch (fn) {
    case 'pkh':
      result = { descType: 'Pkh', keys: [parseKey(inner)] };
      break;
    case 'wpkh':
      result = { descType: 'Wpkh', keys: [parseKey(inner)] };
      break;
    case 'tr':
      if (splitTopLevel(inner).length > 1) {
        fail('descriptor-taproot-script');
      }
      result = { descType: 'Tr', keys: [parseKey(inner)] };
      break;
    case 'wsh':
      result = { descType: 'Wsh', ...parseMulti(inner) };
      break;
    case 'sh': {
      const nested = unwrap(inner);
      if (nested?.[0] === 'wpkh') {
        result = { descType: 'ShWpkh', keys: [parseKey(nested[1])] };
      } else if (nested?.[0] === 'wsh') {
        result = { descType: 'ShWsh', ...parseMulti(nested[1]) };
      } else {
        fail('descriptor-sh-inner');
      }
      break;
    }
    default:
      fail('descriptor-function', { fn });
  }

  const lengths = new Set(result.keys.filter((k) => k.multipath).map((k) => k.multipath!.length));
  if (lengths.size === 0) {
    fail('descriptor-no-multipath');
  }
  if (lengths.size > 1) {
    fail('descriptor-multipath-lengths');
  }
  return { ...result, multipathLen: [...lengths][0] };
}

function btcNetwork(network: WatchNetwork): typeof NETWORK {
  return network === 'mainnet' ? NETWORK : TEST_NETWORK;
}

/** True if the extended keys belong to the network's family (xpub on mainnet, tpub elsewhere). */
export function descriptorMatchesNetwork(desc: ParsedDescriptor, network: WatchNetwork): boolean {
  const want = network === 'mainnet' ? 'xpub' : 'tpub';
  return desc.keys.every((k) => k.xpub.startsWith(want));
}

/**
 * Derives addresses for one parsed descriptor, caching the per-chain parent key so that
 * each address costs a single child derivation.
 */
export class DescriptorDeriver {
  private chainKeys = new Map<string, HDKey>();

  constructor(readonly desc: ParsedDescriptor) {}

  private chainKey(keyIndex: number, chain: number): HDKey {
    const cacheKey = `${keyIndex}:${chain}`;
    let node = this.chainKeys.get(cacheKey);
    if (!node) {
      const k = this.desc.keys[keyIndex];
      node = k.key;
      for (const step of k.prefixSteps) {
        node = node.deriveChild(step);
      }
      if (k.multipath) {
        node = node.deriveChild(k.multipath[chain]);
      }
      for (const step of k.suffixSteps) {
        node = node.deriveChild(step);
      }
      this.chainKeys.set(cacheKey, node);
    }
    return node;
  }

  /** Compressed public keys for (chain, index), in descriptor order. */
  publicKeysAt(chain: number, index: number): Uint8Array[] {
    if (!Number.isInteger(chain) || chain < 0 || chain >= this.desc.multipathLen) {
      fail('descriptor-chain', { chain });
    }
    if (!Number.isInteger(index) || index < 0 || index >= HARDENED) {
      fail('descriptor-index', { index });
    }
    return this.desc.keys.map((_, i) => {
      const pub = this.chainKey(i, chain).deriveChild(index).publicKey;
      if (!pub) {
        fail('derivation-no-public-key');
      }
      return pub;
    });
  }

  addressAt(network: WatchNetwork, chain: number, index: number): DerivedAddress {
    const net = btcNetwork(network);
    const pubkeys = this.publicKeysAt(chain, index);
    let payment: { address?: string; script: Uint8Array };
    switch (this.desc.descType) {
      case 'Pkh': payment = p2pkh(pubkeys[0], net); break;
      case 'Wpkh': payment = p2wpkh(pubkeys[0], net); break;
      case 'ShWpkh': payment = p2sh(p2wpkh(pubkeys[0], net), net); break;
      case 'Tr': payment = p2tr(pubkeys[0].subarray(1), undefined, net); break;
      case 'Wsh':
      case 'ShWsh': {
        const ordered = this.desc.sorted ? sortPubkeys(pubkeys) : pubkeys;
        // Built directly rather than with p2ms(), which stops at 16 keys and rejects repeated
        // keys; BIP-383 allows up to 20 in P2WSH. Script.encode uses OP_1..OP_16 for small
        // counts and a minimal push above 16, matching Bitcoin Core.
        const witnessScript = Script.encode([this.desc.threshold!, ...ordered, ordered.length, 'CHECKMULTISIG']);
        const witness = p2wsh({ type: 'ms', script: witnessScript }, net, true);
        payment = this.desc.descType === 'Wsh' ? witness : p2sh(witness, net);
        break;
      }
    }
    if (!payment.address) {
      fail('derivation-no-address');
    }
    return { address: payment.address, scriptPubKey: hex.encode(payment.script) };
  }
}

/** BIP-67: lexicographic order of the compressed public keys. */
function sortPubkeys(keys: Uint8Array[]): Uint8Array[] {
  return [...keys].sort((a, b) => {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        return a[i] - b[i];
      }
    }
    return 0;
  });
}

/** BIP-32 key fingerprint (first 4 bytes of hash160(pubkey)) as lower-case hex. */
export function keyFingerprint(key: HDKey): string {
  return key.fingerprint.toString(16).padStart(8, '0');
}
