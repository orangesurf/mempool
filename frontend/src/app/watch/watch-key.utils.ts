/**
 * Extended-key normalization and descriptor construction.
 *
 * Kept free of WASM and Angular so it can be unit-tested directly against the
 * published BIP-32/44/49/84 test vectors. The base58 codec and SHA-256 are injected
 * because the only implementations available at runtime live inside the WASM module
 * (base58) and the Web Crypto API (sha256).
 */

import { ScriptType, WatchNetwork } from './watch.types';

export interface Base58Codec {
  decode(str: string): Uint8Array;
  encode(bytes: Uint8Array): string;
}

export type Sha256 = (data: Uint8Array) => Promise<Uint8Array>;

/**
 * SLIP-132 extended-key prefixes.
 *
 * These are NOT understood by btcd or by BIP-380 descriptors — a zpub is simply an
 * xpub with different version bytes, where the version encodes the script type. We
 * rewrite the version bytes back to canonical xpub/tpub and carry the script type
 * across separately.
 */
const SLIP132: Record<string, { version: number; script: ScriptType; network: 'mainnet' | 'testnet' }> = {
  xpub: { version: 0x0488b21e, script: 'pkh',     network: 'mainnet' },
  ypub: { version: 0x049d7cb2, script: 'sh_wpkh', network: 'mainnet' },
  zpub: { version: 0x04b24746, script: 'wpkh',    network: 'mainnet' },
  tpub: { version: 0x043587cf, script: 'pkh',     network: 'testnet' },
  upub: { version: 0x044a5262, script: 'sh_wpkh', network: 'testnet' },
  vpub: { version: 0x045f1cf6, script: 'wpkh',    network: 'testnet' },
  Ypub: { version: 0x0295b43f, script: 'sh_wsh',  network: 'mainnet' },
  Zpub: { version: 0x02aa7ed3, script: 'wsh',     network: 'mainnet' },
  Upub: { version: 0x024289ef, script: 'sh_wsh',  network: 'testnet' },
  Vpub: { version: 0x02575483, script: 'wsh',     network: 'testnet' },
};

/** Canonical BIP-32 version bytes, which is all btcd/BIP-380 will accept. */
const CANONICAL_VERSION = { mainnet: 0x0488b21e, testnet: 0x043587cf };

const EXTENDED_KEY_RE = /^(xpub|ypub|zpub|tpub|upub|vpub|Ypub|Zpub|Upub|Vpub)[1-9A-HJ-NP-Za-km-z]{100,112}$/;

/** True if the input looks like a BIP-380 output descriptor rather than a bare extended key. */
export function looksLikeDescriptor(input: string): boolean {
  return /^(pkh|wpkh|sh|wsh|tr|combo|addr|raw|multi|sortedmulti)\s*\(/.test(input.trim());
}

/** True if the input looks like a SLIP-132 / BIP-32 extended public key. */
export function looksLikeExtendedKey(input: string): boolean {
  return EXTENDED_KEY_RE.test(input.trim());
}

function readUInt32BE(b: Uint8Array, offset: number): number {
  return ((b[offset] << 24) | (b[offset + 1] << 16) | (b[offset + 2] << 8) | b[offset + 3]) >>> 0;
}

function writeUInt32BE(b: Uint8Array, value: number, offset: number): void {
  b[offset] = (value >>> 24) & 0xff;
  b[offset + 1] = (value >>> 16) & 0xff;
  b[offset + 2] = (value >>> 8) & 0xff;
  b[offset + 3] = value & 0xff;
}

export interface NormalizedKey {
  /** Canonical xpub (mainnet) or tpub (testnet-family), safe to feed to a descriptor. */
  xpub: string;
  scriptType: ScriptType;
  /** 'mainnet' or 'testnet' — the *key's* family. testnet4/signet share testnet version bytes. */
  keyNetwork: 'mainnet' | 'testnet';
}

/**
 * Rewrite a SLIP-132 extended key to a canonical xpub/tpub, recovering the script type
 * from the prefix. An xpub/tpub passes through unchanged (but still yields a script type
 * of 'pkh' — a bare xpub is genuinely ambiguous; see WatchComponent for the override).
 */
export async function normalizeExtendedKey(key: string, b58: Base58Codec, sha256: Sha256): Promise<NormalizedKey> {
  const trimmed = key.trim();
  const prefix = trimmed.slice(0, 4);
  const meta = SLIP132[prefix];
  if (!meta) {
    throw new Error(`Unrecognized extended key prefix "${prefix}". Expected one of: ${Object.keys(SLIP132).join(', ')}.`);
  }

  const raw = b58.decode(trimmed);
  if (raw.length !== 82) {
    throw new Error('Malformed extended key: unexpected length.');
  }
  const payload = raw.subarray(0, 78);
  const checksum = raw.subarray(78);

  // Verify the original checksum before we touch anything — a typo'd key must fail here,
  // not silently derive a valid-looking wallet that belongs to nobody.
  const expected = (await sha256(await sha256(payload))).subarray(0, 4);
  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== expected[i]) {
      throw new Error('Invalid extended key: checksum does not match. Check for a typo.');
    }
  }

  if (readUInt32BE(payload, 0) !== meta.version) {
    throw new Error(`Extended key version bytes do not match its "${prefix}" prefix.`);
  }

  const swapped = new Uint8Array(payload);
  writeUInt32BE(swapped, CANONICAL_VERSION[meta.network], 0);

  const newChecksum = (await sha256(await sha256(swapped))).subarray(0, 4);
  const out = new Uint8Array(82);
  out.set(swapped, 0);
  out.set(newChecksum, 78);

  return { xpub: b58.encode(out), scriptType: meta.script, keyNetwork: meta.network };
}

/**
 * Wrap an xpub in a BIP-380 multipath descriptor.
 *
 * `<0;1>` is the multipath element: index 0 is the receive chain, index 1 is change.
 * btcutil exposes these as `addressAt(network, multipathIndex, derivationIndex)`, so a
 * single descriptor covers both chains and there is exactly one derivation code path.
 */
export function buildDescriptor(xpub: string, scriptType: ScriptType): string {
  const inner = `${xpub}/<0;1>/*`;
  switch (scriptType) {
    case 'pkh':     return `pkh(${inner})`;
    case 'sh_wpkh': return `sh(wpkh(${inner}))`;
    case 'wpkh':    return `wpkh(${inner})`;
    case 'tr':      return `tr(${inner})`;
    default:
      throw new Error(`Unsupported script type: ${scriptType}`);
  }
}

/**
 * A user-supplied descriptor may be single-path (`.../0/*`). We need both chains, so
 * rewrite a trailing single-path element into a multipath one. Already-multipath
 * descriptors pass through untouched.
 *
 * Also strips a trailing `#checksum`, which btcd's parser does not accept.
 */
export function toMultipathDescriptor(descriptor: string): string {
  let d = descriptor.trim().replace(/#[a-z0-9]{8}$/i, '');
  if (/<\s*\d+\s*;\s*\d+\s*>/.test(d)) {
    return d; // already multipath
  }
  // Rewrite `/0/*` (or `/1/*`) immediately before the closing parens into `/<0;1>/*`.
  const single = /\/([01])\/\*/g;
  if (single.test(d)) {
    return d.replace(single, '/<0;1>/*');
  }
  return d;
}

/**
 * Human-readable description of a wallet's script type.
 *
 * Normalizes the two vocabularies we end up with: our own ScriptType (from a SLIP-132 prefix,
 * e.g. 'wpkh'/'sh_wpkh') and btcd's DescType (from a parsed descriptor, e.g. 'Wpkh'/'ShWpkh').
 * `path` is the BIP-standard account path, shown only when the real one is not known.
 */
export function describeScriptType(scriptType: string): { name: string; code: string; path?: string } {
  switch ((scriptType || '').toLowerCase()) {
    case 'wpkh':    return { name: 'Native SegWit', code: 'P2WPKH', path: "m/84'/0'/0'" };
    case 'sh_wpkh':
    case 'shwpkh':  return { name: 'Nested SegWit', code: 'P2SH-P2WPKH', path: "m/49'/0'/0'" };
    case 'pkh':     return { name: 'Legacy', code: 'P2PKH', path: "m/44'/0'/0'" };
    case 'tr':      return { name: 'Taproot', code: 'P2TR', path: "m/86'/0'/0'" };
    case 'wsh':     return { name: 'Native SegWit script', code: 'P2WSH' };
    case 'sh_wsh':
    case 'shwsh':   return { name: 'Nested SegWit script', code: 'P2SH-P2WSH' };
    case 'sh':      return { name: 'Legacy script', code: 'P2SH' };
    case 'bare':    return { name: 'Bare script', code: 'Bare' };
    default:        return { name: scriptType, code: scriptType };
  }
}

export interface KeyOrigin {
  /** 8 hex chars: the MASTER key's fingerprint, as hardware wallets display it. */
  masterFingerprint: string;
  /** e.g. "m/84'/0'/0'" */
  path?: string;
}

/**
 * Pull the key-origin info out of a descriptor: `wpkh([73c5da0a/84h/0h/0h]xpub…/<0;1>/*)`.
 *
 * This is the ONLY way to learn the true master fingerprint from a watch-only import. A bare
 * xpub/zpub does not carry it: an account-level key's own fingerprint is its own, and its
 * `parentFingerprint` field is the fingerprint of m/84'/0' — neither is the master, and
 * showing either as "master" would fail to match what the user's hardware wallet displays.
 */
export function parseKeyOrigin(descriptor: string): KeyOrigin | null {
  const match = descriptor.match(/\[\s*([0-9a-fA-F]{8})((?:\/\d+['h]?)*)\s*\]/);
  if (!match) {
    return null;
  }
  const path = match[2] ? `m${match[2].replace(/h/g, "'")}` : undefined;
  return { masterFingerprint: match[1].toLowerCase(), path };
}

/** Which btcutil network string to derive against. testnet4/signet use testnet params. */
export function btcutilNetwork(network: WatchNetwork): string {
  switch (network) {
    case 'mainnet': return 'mainnet';
    case 'testnet': return 'testnet';
    case 'testnet4': return 'testnet4';
    case 'signet': return 'signet';
  }
}

/** Map mempool's network identifier onto ours. Returns null for unsupported networks (e.g. Liquid). */
export function fromMempoolNetwork(network: string): WatchNetwork | null {
  switch (network) {
    case '':
    case 'bitcoin':  return 'mainnet';
    case 'testnet':  return 'testnet';
    case 'testnet4': return 'testnet4';
    case 'signet':   return 'signet';
    default:         return null;
  }
}

/**
 * Guard against importing a mainnet key on a testnet page (and vice versa) — the
 * derivation would "succeed" and produce addresses that simply have no history,
 * which reads to the user as an empty wallet rather than as a mistake.
 */
export function keyMatchesNetwork(keyNetwork: 'mainnet' | 'testnet', network: WatchNetwork): boolean {
  return keyNetwork === (network === 'mainnet' ? 'mainnet' : 'testnet');
}
