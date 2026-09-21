import { WatchWallet } from './watch.types';

export type WalletFileFormat = 'descriptor' | 'sparrow' | 'electrum';

export interface WalletFileImport {
  input: string;
  format: WalletFileFormat;
  label?: string;
  gapLimit?: number;
}

type JsonObject = Record<string, unknown>;
const DESC = /(?:^|[^a-z])(pkh|wpkh|sh|wsh|tr)\s*\(/i;
const XPRV = /(?:xprv|yprv|zprv|tprv|uprv|vprv)[1-9A-HJ-NP-Za-km-z]{80,}/i;
const WIF = /(?:^|[^1-9A-HJ-NP-Za-km-z])(?:[59][1-9A-HJ-NP-Za-km-z]{50}|[KLc][1-9A-HJ-NP-Za-km-z]{51})(?![1-9A-HJ-NP-Za-km-z])/;
const PRIVATE_FIELD = /^(?:seed|mnemonic|xprv|privatekey|masterprivateextendedkey)$/i;

const object = (value: unknown): value is JsonObject =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;
const integer = (value: unknown): number | undefined => {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
};

function assertWatchOnly(value: unknown, raw: string): void {
  if (XPRV.test(raw) || WIF.test(raw)) {
    throw new Error('This file contains a private key. Import a watch-only export instead.');
  }
  if (Array.isArray(value)) {
    value.forEach((child) => assertWatchOnly(child, ''));
  } else if (object(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (PRIVATE_FIELD.test(key.replace(/[_\s-]/g, '')) && child !== null && child !== '' && child !== false) {
        throw new Error('This file contains seed or private-key material. Import a watch-only export instead.');
      }
      assertWatchOnly(child, '');
    }
  }
}

function descriptorFromText(value: string): string | null {
  const found: string[] = [];
  for (const rawLine of value.replace(/\r/g, '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const match = DESC.exec(line);
    if (!match) {
      continue;
    }
    const start = match.index + match[0].length - match[1].length;
    let depth = 0;
    let end = -1;
    for (let i = line.indexOf('(', start); i < line.length; i++) {
      if (line[i] === '(') {
        depth++;
      } else if (line[i] === ')' && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    if (end > start) {
      const checksum = line.slice(end).match(/^#[a-z0-9]{8}/i)?.[0] ?? '';
      found.push(line.slice(start, end) + checksum);
    }
  }
  return found.find((item) => /<\s*0\s*;\s*1\s*>/.test(item)) ?? found[0] ?? null;
}

function descriptorField(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = descriptorField(child);
      if (found) return found;
    }
  } else if (object(value)) {
    for (const name of ['descriptor', 'outputDescriptor', 'output_descriptor', 'recv_descriptor']) {
      const candidate = text(value[name]);
      const found = candidate ? descriptorFromText(candidate) : null;
      if (found) return found;
    }
    for (const child of Object.values(value)) {
      const found = descriptorField(child);
      if (found) return found;
    }
  }
  return null;
}

function originKey(key: string, store: JsonObject): string {
  const derivation = object(store.keyDerivation) ? store.keyDerivation : store;
  const fingerprint = text(derivation.masterFingerprint) ?? text(store.root_fingerprint);
  const path = text(derivation.derivationPath) ?? text(store.derivation);
  if (!fingerprint && !path) return key;
  const clean = path?.replace(/^m\/?/i, '').replace(/h/gi, "'");
  return `[${fingerprint ?? '00000000'}${clean ? '/' + clean : ''}]${key}`;
}

const branches = (key: string): string =>
  /\/\*$/.test(key) ? key : key.replace(/\/$/, '') + '/<0;1>/*';

function single(key: string, type: string): string {
  switch (type.toUpperCase().replace(/-/g, '_')) {
    case 'P2PKH': return `pkh(${branches(key)})`;
    case 'P2SH_P2WPKH': return `sh(wpkh(${branches(key)}))`;
    case 'P2WPKH': return `wpkh(${branches(key)})`;
    case 'P2TR': return `tr(${branches(key)})`;
    default: throw new Error(`Unsupported wallet script type "${type}".`);
  }
}

function multi(keys: string[], threshold: number, type: string): string {
  const policy = `sortedmulti(${threshold},${keys.map(branches).join(',')})`;
  switch (type.toUpperCase().replace(/-/g, '_')) {
    case 'P2WSH': return `wsh(${policy})`;
    case 'P2SH_P2WSH': return `sh(wsh(${policy}))`;
    default: throw new Error(`Unsupported multisig script type "${type}".`);
  }
}

function sparrow(root: JsonObject): WalletFileImport | null {
  const wallet = object(root.wallet) ? root.wallet : root;
  if (!Array.isArray(wallet.keystores) || !wallet.keystores.length || !text(wallet.scriptType)) {
    return null;
  }
  const stores = wallet.keystores.filter(object);
  const keys = stores.map((store) => {
    const key = text(store.extendedPublicKey) ?? text(store.xpub);
    if (!key) throw new Error('This Sparrow wallet is missing an extended public key.');
    return originKey(key, store);
  });
  const type = String(wallet.scriptType);
  const isMulti = String(wallet.policyType ?? '').toUpperCase().includes('MULTI') || keys.length > 1;
  let input: string;
  if (isMulti) {
    const miniscript = object(wallet.defaultPolicy) && object(wallet.defaultPolicy.miniscript)
      ? text(wallet.defaultPolicy.miniscript.script) : undefined;
    const threshold = integer(wallet.numSignaturesRequired) ?? integer(wallet.threshold)
      ?? integer(miniscript?.match(/multi\((\d+)/i)?.[1]);
    if (!threshold || threshold > keys.length) {
      throw new Error('Could not determine the multisig threshold from this Sparrow wallet.');
    }
    input = multi(keys, threshold, type);
  } else {
    input = single(keys[0], type);
  }
  return {
    input,
    format: 'sparrow',
    label: text(wallet.label) ?? text(wallet.name),
    gapLimit: integer(wallet.gapLimit),
  };
}

function electrumType(prefix: string, multisig: boolean): string {
  if (multisig) {
    if (prefix === 'Zpub' || prefix === 'Vpub') return 'P2WSH';
    if (prefix === 'Ypub' || prefix === 'Upub') return 'P2SH_P2WSH';
    throw new Error('This Electrum multisig xpub has an ambiguous script type. Export its descriptor instead.');
  }
  if (prefix === 'zpub' || prefix === 'vpub') return 'P2WPKH';
  if (prefix === 'ypub' || prefix === 'upub') return 'P2SH_P2WPKH';
  if (prefix === 'xpub' || prefix === 'tpub') return 'P2PKH';
  throw new Error(`Unsupported Electrum public-key prefix "${prefix}".`);
}

function electrum(root: JsonObject): WalletFileImport | null {
  const walletType = text(root.wallet_type);
  if (!walletType) return null;
  const entries = Object.entries(root)
    .filter(([name, value]) => (name === 'keystore' || /^x\d+\/$/.test(name)) && object(value))
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  if (!entries.length) throw new Error('This Electrum wallet has no extended public key.');
  const stores = entries.map(([, value]) => value as JsonObject);
  const keys = stores.map((store) => {
    const key = text(store.xpub);
    if (!key) throw new Error('This Electrum wallet is missing an extended public key.');
    return originKey(key, store);
  });
  const policy = walletType.match(/^(\d+)of(\d+)$/i);
  const multisig = !!policy;
  if (!multisig && walletType !== 'standard' && walletType !== 'xpub') {
    throw new Error(`Unsupported Electrum wallet type "${walletType}".`);
  }
  if (policy && Number(policy[2]) !== keys.length) {
    throw new Error('The Electrum policy does not match its number of public keys.');
  }
  const rawKey = text(stores[0].xpub)!;
  const type = electrumType(rawKey.slice(0, 4), multisig);
  const input = policy ? multi(keys, Number(policy[1]), type) : single(keys[0], type);
  return {
    input,
    format: 'electrum',
    label: text(root.label) ?? text(stores[0].label),
    gapLimit: integer(root.gap_limit),
  };
}

export function parseWalletFile(contents: string): WalletFileImport {
  const raw = contents.trim();
  if (!raw) throw new Error('The selected wallet file is empty.');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    assertWatchOnly(null, raw);
    const input = descriptorFromText(raw);
    if (!input) {
      throw new Error('Unrecognised wallet file. Choose a descriptor, Sparrow JSON, or Electrum JSON file.');
    }
    return { input, format: 'descriptor' };
  }
  assertWatchOnly(json, raw);
  if (!object(json)) {
    throw new Error('Unrecognised wallet file. Expected a wallet JSON object.');
  }
  const electrumWallet = electrum(json);
  if (electrumWallet) return electrumWallet;
  const direct = descriptorField(json);
  if (direct) {
    return {
      input: direct,
      format: 'sparrow',
      label: text(json.label) ?? text(json.name),
      gapLimit: integer(json.gapLimit) ?? integer(json.gap_limit),
    };
  }
  const sparrowWallet = sparrow(json);
  if (sparrowWallet) return sparrowWallet;
  throw new Error('Unrecognised wallet file. Choose a descriptor, Sparrow JSON, or Electrum JSON file.');
}

export function sparrowExport(wallet: WatchWallet): string {
  return JSON.stringify({
    label: wallet.label,
    descriptor: wallet.descriptor,
    blockheight: 0,
    gapLimit: wallet.gapLimit,
    network: wallet.network,
    watchOnly: true,
  }, null, 2) + '\n';
}
