/// <reference lib="webworker" />

/**
 * Address derivation worker.
 *
 * This is the ONLY place the btcutil WASM module is loaded. It is ~8.5 MB (2.6 MB gzipped),
 * so it is fetched lazily — the first time a user imports or extends a wallet — and never on
 * an ordinary page view. Everything downstream (balance, history, "is this output mine?"
 * highlighting) works off the derived address strings alone and never touches WASM.
 *
 * Keeping it in a worker also means the WASM compile (which can take a second or more on a
 * low-end phone) never blocks the main thread.
 */

import { init } from 'btcutil-js';
import {
  Base58Codec,
  buildDescriptor,
  btcutilNetwork,
  keyMatchesNetwork,
  looksLikeDescriptor,
  looksLikeExtendedKey,
  normalizeExtendedKey,
  parseKeyOrigin,
  toMultipathDescriptor,
} from './watch-key.utils';
import { ScriptType, WatchNetwork } from './watch.types';
import { buildWatchOnlyPsbt, finalizeExternalPsbt, PsbtBuildRequest } from './psbt.utils';

type Btcutil = Awaited<ReturnType<typeof init>>;

let btcutil: Btcutil | null = null;
let loading: Promise<Btcutil> | null = null;

/** The wasm binary is copied into assets by angular.json. */
const WASM_URL = '/resources/btcutil.wasm';

function getBtcutil(): Promise<Btcutil> {
  if (btcutil) {
    return Promise.resolve(btcutil);
  }
  if (!loading) {
    loading = init(WASM_URL).then((b) => {
      btcutil = b;
      return b;
    });
  }
  return loading;
}

const sha256 = async (data: Uint8Array): Promise<Uint8Array> => {
  const buf = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource);
  return new Uint8Array(buf);
};

const PRIVATE_KEY_RE = /(?:xprv|yprv|zprv|tprv|uprv|vprv)[1-9A-HJ-NP-Za-km-z]{80,}/i;
const WIF_RE = /(?:^|[^1-9A-HJ-NP-Za-km-z])(?:[59][1-9A-HJ-NP-Za-km-z]{50}|[KLc][1-9A-HJ-NP-Za-km-z]{51})(?![1-9A-HJ-NP-Za-km-z])/;
const DESCRIPTOR_XPUB_RE = /(xpub|ypub|zpub|tpub|upub|vpub|Ypub|Zpub|Upub|Vpub)[1-9A-HJ-NP-Za-km-z]{100,112}/g;


async function normalizeDescriptorKeys(descriptor: string, btc: Btcutil, network: WatchNetwork): Promise<string> {
  const keys = descriptor.match(DESCRIPTOR_XPUB_RE) ?? [];
  const b58: Base58Codec = {
    decode: (value) => btc.base58.decode(value),
    encode: (value) => btc.base58.encode(value),
  };
  let normalized = descriptor;
  for (const key of keys) {
    const result = await normalizeExtendedKey(key, b58, sha256);
    if (!keyMatchesNetwork(result.keyNetwork, network)) {
      throw new Error(`This descriptor contains a ${result.keyNetwork} key, but you are on ${network}.`);
    }
    normalized = normalized.replace(key, result.xpub);
  }
  return normalized;
}

/** Descriptors are WASM handles, so they cannot cross the worker boundary. Cache them here. */
const descriptorCache = new Map<string, ReturnType<Btcutil['descriptors']['create']>>();

function getDescriptor(btc: Btcutil, descriptor: string) {
  let desc = descriptorCache.get(descriptor);
  if (!desc) {
    desc = btc.descriptors.create(descriptor);
    descriptorCache.set(descriptor, desc);
  }
  return desc;
}

export interface PrepareRequest {
  id: number;
  cmd: 'prepare';
  input: string;
  network: WatchNetwork;
  /** Override for a bare xpub, whose script type is genuinely ambiguous. */
  scriptTypeHint?: ScriptType;
}

export interface DeriveRequest {
  id: number;
  cmd: 'derive';
  descriptor: string;
  network: WatchNetwork;
  chain: 0 | 1;
  from: number;
  count: number;
}

export interface PsbtBuildWorkerRequest { id: number; cmd: 'psbt-build'; request: PsbtBuildRequest; }
export interface PsbtFinalizeWorkerRequest { id: number; cmd: 'psbt-finalize'; base64: string; }

type Request =
  | PrepareRequest
  | DeriveRequest
  | PsbtBuildWorkerRequest
  | PsbtFinalizeWorkerRequest;

const bytesToHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** A BIP-32 fingerprint is the first 4 bytes of hash160(compressed pubkey). */
function fingerprintOf(btc: Btcutil, publicKey: Uint8Array): string {
  const h = btc.hash.hash160(publicKey);
  return Array.from(h.slice(0, 4)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function handlePrepare(req: PrepareRequest) {
  const btc = await getBtcutil();
  const input = req.input.trim();
  if (PRIVATE_KEY_RE.test(input) || WIF_RE.test(input)) {
    throw new Error('Private keys are not accepted. Import a public descriptor or xpub.');
  }

  let descriptor: string;
  let scriptType: ScriptType | string;
  let fingerprint: string | undefined;
  let fingerprintIsMaster = false;
  let originPath: string | undefined;

  if (looksLikeDescriptor(input)) {
    descriptor = toMultipathDescriptor(await normalizeDescriptorKeys(input, btc, req.network));
    // btcd validates the descriptor for us; an invalid one throws here.
    const desc = getDescriptor(btc, descriptor);
    scriptType = desc.descType();

    // A descriptor's key origin carries the real master fingerprint — the only import path
    // from which we can honestly show one.
    const origin = parseKeyOrigin(input);
    if (origin) {
      fingerprint = origin.masterFingerprint;
      fingerprintIsMaster = true;
      originPath = origin.path;
    }
  } else if (looksLikeExtendedKey(input)) {
    const b58: Base58Codec = {
      decode: (s) => btc.base58.decode(s),
      encode: (b) => btc.base58.encode(b),
    };
    const norm = await normalizeExtendedKey(input, b58, sha256);
    if (!keyMatchesNetwork(norm.keyNetwork, req.network)) {
      throw new Error(
        `This is a ${norm.keyNetwork} key, but you are on ${req.network}. ` +
        `Switch networks, or import the key for this network.`
      );
    }
    scriptType = req.scriptTypeHint ?? norm.scriptType;
    descriptor = buildDescriptor(norm.xpub, scriptType as ScriptType);
    getDescriptor(btc, descriptor); // validate eagerly

    // A bare extended key does not carry the master fingerprint (its parentFingerprint field
    // is its parent's, e.g. m/84'/0'). So we show the *account key's* own fingerprint — a
    // stable identifier, but explicitly not the device XFP. The one exception is a depth-0
    // key, which IS the master.
    const info = btc.hdkeychain.fromString(norm.xpub);
    fingerprint = fingerprintOf(btc, info.publicKey);
    fingerprintIsMaster = info.depth === 0;
  } else {
    throw new Error('Not a recognized extended public key or output descriptor.');
  }

  const desc = getDescriptor(btc, descriptor);
  if (desc.multipathLen() < 2) {
    throw new Error(
      'This descriptor has no change path. Provide a multipath descriptor (…/<0;1>/*) ' +
      'or a plain extended public key.'
    );
  }

  return { descriptor, scriptType, descType: desc.descType(), fingerprint, fingerprintIsMaster, originPath };
}

async function handleDerive(req: DeriveRequest) {
  const btc = await getBtcutil();
  const desc = getDescriptor(btc, req.descriptor);
  const network = btcutilNetwork(req.network);
  const addresses: { address: string; scriptPubKey: string }[] = [];
  for (let i = 0; i < req.count; i++) {
    const address = desc.addressAt(network as never, req.chain, req.from + i);
    addresses.push({
      address,
      scriptPubKey: bytesToHex(btc.txscript.payToAddrScript(address, network as never)),
    });
  }
  return { addresses, chain: req.chain, from: req.from };
}

addEventListener('message', async ({ data }: MessageEvent<Request>) => {
  try {
    let result: unknown;
    switch (data.cmd) {
      case 'prepare':
        result = await handlePrepare(data);
        break;
      case 'derive':
        result = await handleDerive(data);
        break;
      case 'psbt-build':
        result = buildWatchOnlyPsbt(await getBtcutil(), data.request);
        break;
      case 'psbt-finalize':
        result = finalizeExternalPsbt(await getBtcutil(), data.base64);
        break;
    }
    postMessage({ id: data.id, ok: true, result });
  } catch (e) {
    postMessage({ id: data.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
