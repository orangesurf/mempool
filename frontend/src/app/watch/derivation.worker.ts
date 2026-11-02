/// <reference lib="webworker" />

/**
 * Address derivation worker.
 *
 * Parsing and derivation use @scure/bip32 and @scure/btc-signer (see descriptor.ts), which
 * are pure TypeScript, so the wallet loads no WASM. Running them in a worker keeps large
 * gap-limit scans off the main thread. Pasted address lists are checked
 * here too, since that also needs the library.
 */

import { base58, hex } from '@scure/base';
import { Address, NETWORK, OutScript, TEST_NETWORK } from '@scure/btc-signer';
import { AddressDecoder, parseAddressList } from '@app/watch/address-list';
import { DescriptorDeriver, descriptorMatchesNetwork, keyFingerprint, parseDescriptor } from '@app/watch/descriptor';
import {
  BARE_KEY_SCRIPT_TYPES,
  Base58Codec,
  buildDescriptor,
  keyMatchesNetwork,
  isBareExtendedKey,
  looksLikeDescriptor,
  looksLikeExtendedKey,
  normalizeExtendedKey,
  parseKeyOrigin,
  toMultipathDescriptor,
  validateDescriptorChecksum,
} from '@app/watch/watch-key.utils';
import {
  AddressListRequest,
  AddressListResult,
  DerivationResponse,
  InputError,
  DeriveRequest,
  DeriveResult,
  DerivationRequest,
  PrepareRequest,
  PrepareResult,
  ScriptCandidatesRequest,
  ScriptCandidatesResult,
} from '@app/watch/derivation.messages';
import { ScriptType, WatchNetwork } from '@app/watch/watch.types';

const sha256 = async (data: Uint8Array): Promise<Uint8Array> => {
  const buf = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource);
  return new Uint8Array(buf);
};

const b58: Base58Codec = { decode: (value) => base58.decode(value), encode: (value) => base58.encode(value) };

const PRIVATE_KEY_RE = /(?:xprv|yprv|zprv|tprv|uprv|vprv)[1-9A-HJ-NP-Za-km-z]{80,}/i;
const WIF_RE = /(?:^|[^1-9A-HJ-NP-Za-km-z])(?:[59][1-9A-HJ-NP-Za-km-z]{50}|[KLc][1-9A-HJ-NP-Za-km-z]{51})(?![1-9A-HJ-NP-Za-km-z])/;
const DESCRIPTOR_XPUB_RE = /(xpub|ypub|zpub|tpub|upub|vpub|Ypub|Zpub|Upub|Vpub)[1-9A-HJ-NP-Za-km-z]{100,112}/g;

/** Rewrite every SLIP-132 key inside a descriptor to its canonical xpub/tpub form. */
async function normalizeDescriptorKeys(descriptor: string, network: WatchNetwork): Promise<string> {
  const keys = descriptor.match(DESCRIPTOR_XPUB_RE) ?? [];
  let normalized = descriptor;
  for (const key of keys) {
    const result = await normalizeExtendedKey(key, b58, sha256);
    if (!keyMatchesNetwork(result.keyNetwork, network)) {
      throw new InputError('descriptor-key-network', { keyNetwork: result.keyNetwork, network });
    }
    normalized = normalized.replace(key, result.xpub);
  }
  return normalized;
}

/** Parsed descriptors hold derived parent keys; cache them per descriptor string. */
const derivers = new Map<string, DescriptorDeriver>();

function getDeriver(descriptor: string): DescriptorDeriver {
  let deriver = derivers.get(descriptor);
  if (!deriver) {
    deriver = new DescriptorDeriver(parseDescriptor(descriptor));
    derivers.set(descriptor, deriver);
  }
  return deriver;
}

function rejectPrivateKeys(input: string): void {
  if (PRIVATE_KEY_RE.test(input) || WIF_RE.test(input)) {
    throw new InputError('private-key');
  }
}

async function handlePrepare(req: PrepareRequest): Promise<PrepareResult> {
  const input = req.input.trim();
  rejectPrivateKeys(input);

  let descriptor: string;
  let scriptType: ScriptType | string;
  let fingerprint: string | undefined;
  let fingerprintIsMaster = false;
  let originPath: string | undefined;

  if (looksLikeDescriptor(input)) {
    validateDescriptorChecksum(input);
    const withoutChecksum = input.replace(/#[a-z0-9]{8}$/i, '');
    descriptor = toMultipathDescriptor(await normalizeDescriptorKeys(withoutChecksum, req.network));
    // An unsupported or malformed descriptor throws here with a user-facing message.
    scriptType = getDeriver(descriptor).desc.descType;

    // Only a descriptor's key origin carries the real master fingerprint.
    const origin = parseKeyOrigin(input);
    if (origin) {
      fingerprint = origin.masterFingerprint;
      fingerprintIsMaster = true;
      originPath = origin.path;
    }
  } else if (looksLikeExtendedKey(input)) {
    const norm = await normalizeExtendedKey(input, b58, sha256);
    if (!keyMatchesNetwork(norm.keyNetwork, req.network)) {
      throw new InputError('key-network', { keyNetwork: norm.keyNetwork, network: req.network });
    }
    scriptType = req.scriptTypeHint ?? norm.scriptType;
    descriptor = buildDescriptor(norm.xpub, scriptType as ScriptType);

    // A bare extended key does not carry the master fingerprint (its parentFingerprint
    // field is its parent's, e.g. m/84'/0'). Show the account key's own fingerprint instead,
    // unless the key is depth 0 and therefore is the master.
    const key = getDeriver(descriptor).desc.keys[0].key;
    fingerprint = keyFingerprint(key);
    fingerprintIsMaster = key.depth === 0;
  } else {
    throw new InputError('unrecognized-input');
  }

  const desc = getDeriver(descriptor).desc;
  if (!descriptorMatchesNetwork(desc, req.network)) {
    throw new InputError('descriptor-network', { network: req.network });
  }
  return { descriptor, scriptType, fingerprint, fingerprintIsMaster, originPath };
}

function handleDerive(req: DeriveRequest): DeriveResult {
  const deriver = getDeriver(req.descriptor);
  const addresses: DeriveResult['addresses'] = [];
  for (let i = 0; i < req.count; i++) {
    addresses.push(deriver.addressAt(req.network, req.chain, req.from + i));
  }
  return { addresses };
}

/** Canonical form (lower-case bech32) and locking script, or a throw if invalid for the family. */
const decodeAddress: AddressDecoder = (address, family) => {
  const codec = Address(family === 'mainnet' ? NETWORK : TEST_NETWORK);
  const script = codec.decode(address);
  return { address: codec.encode(script), scriptPubKey: hex.encode(OutScript.encode(script)) };
};

function handleAddressList(req: AddressListRequest): AddressListResult {
  // Checked first because a bad entry is quoted back in the error message.
  rejectPrivateKeys(req.input);
  return { addresses: parseAddressList(req.input, req.network, decodeAddress) };
}

async function handleScriptCandidates(req: ScriptCandidatesRequest): Promise<ScriptCandidatesResult> {
  const input = req.input.trim();
  rejectPrivateKeys(input);
  if (!isBareExtendedKey(input)) {
    return { candidates: [] };
  }
  const norm = await normalizeExtendedKey(input, b58, sha256);
  if (!keyMatchesNetwork(norm.keyNetwork, req.network)) {
    throw new InputError('key-network', { keyNetwork: norm.keyNetwork, network: req.network });
  }
  const candidates = BARE_KEY_SCRIPT_TYPES.map((scriptType) => ({
    scriptType,
    address: getDeriver(buildDescriptor(norm.xpub, scriptType)).addressAt(req.network, 0, 0).address,
  }));
  return { candidates };
}

async function handle(req: DerivationRequest): Promise<PrepareResult | DeriveResult | AddressListResult | ScriptCandidatesResult> {
  switch (req.cmd) {
    case 'prepare': return handlePrepare(req);
    case 'derive': return handleDerive(req);
    case 'address-list': return handleAddressList(req);
    case 'script-candidates': return handleScriptCandidates(req);
  }
}

addEventListener('message', async ({ data }: MessageEvent<DerivationRequest>) => {
  try {
    const result = await handle(data);
    postMessage({ id: data.id, ok: true, result });
  } catch (e) {
    const response: DerivationResponse = e instanceof InputError
      ? { id: data.id, ok: false, code: e.code, params: e.params }
      : { id: data.id, ok: false, error: e instanceof Error ? e.message : String(e) };
    postMessage(response);
  }
});
