import type { BtcutilSync, Bip32DerivationInfo, TaprootBip32DerivationInfo } from 'btcutil-js';
import { Chain, WalletUtxo, WatchNetwork } from './watch.types';

export interface PsbtRecipient { address: string; value: number; scriptPubKey: string; }
export interface PsbtBuildUtxo extends WalletUtxo { scriptPubKey: string; chain: Chain; index: number; previousTx?: string; }
export interface PsbtBuildRequest {
  descriptor: string; network: WatchNetwork; utxos: PsbtBuildUtxo[]; recipients: PsbtRecipient[];
  change: { address: string; scriptPubKey: string; chain: 1; index: number };
  feeRate: number; sendMax: boolean; useAllUtxos: boolean; rbf: boolean; locktime: number; opReturn?: string;
}
export interface PsbtBuildResult {
  base64: string; hex: string; selected: PsbtBuildUtxo[]; outputs: PsbtRecipient[];
  changeAddress?: string; changeValue: number; fee: number; feeRate: number; vsize: number;
}
export interface PsbtFinalizedResult { base64: string; rawHex: string; }

const HARDENED = 0x80000000;
const DUST = 546;

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error('Expected even-length hexadecimal data.');
  return Uint8Array.from(hex.match(/../g)!.map((byte) => parseInt(byte, 16)));
}
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
export function normalizePsbtText(text: string): string {
  const compact = text.trim().replace(/\s+/g, '');
  if (!compact) throw new Error('Paste a signed PSBT first.');
  const bytes = /^[0-9a-f]+$/i.test(compact) ? hexToBytes(compact) : base64ToBytes(compact);
  if (bytesToHex(bytes.subarray(0, 5)) !== '70736274ff') throw new Error('This is not a PSBT (missing BIP-174 magic bytes).');
  return bytesToBase64(bytes);
}
export function parseBitcoinRecipient(value: string): { address: string; amount?: number } {
  const trimmed = value.trim();
  if (!/^bitcoin:/i.test(trimmed)) return { address: trimmed };
  const body = trimmed.slice(trimmed.indexOf(':') + 1);
  const separator = body.indexOf('?');
  const address = decodeURIComponent(separator < 0 ? body : body.slice(0, separator));
  const params = new URLSearchParams(separator < 0 ? '' : body.slice(separator + 1));
  let unsupported = '';
  params.forEach((_value, key) => { if (key.toLowerCase().startsWith('req-')) unsupported = key; });
  if (unsupported) throw new Error(`Unsupported required BIP21 parameter: ${unsupported}`);
  const amountText = params.get('amount');
  if (amountText == null) return { address };
  if (!/^(?:\d+)(?:\.\d{1,8})?$/.test(amountText)) throw new Error('The BIP21 amount is invalid.');
  const amount = Math.round(Number(amountText) * 100_000_000);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('The BIP21 amount must be positive.');
  return { address, amount };
}

function parsePath(path: string): number[] {
  if (!path) return [];
  return path.replace(/^\//, '').split('/').filter(Boolean).map((part) => {
    const hardened = /['h]$/i.test(part);
    const index = Number(part.replace(/['h]$/i, ''));
    if (!Number.isInteger(index) || index < 0 || index >= HARDENED) throw new Error(`Invalid derivation path element: ${part}`);
    return index + (hardened ? HARDENED : 0);
  });
}
interface DerivedKey { pubKey: Uint8Array; fingerprint: string; path: number[]; }
function descriptorKeyParts(key: string): { fingerprint?: string; origin: number[]; xpub: string; suffix: string[] } {
  const match = key.match(/^(?:\[([0-9a-fA-F]{8})((?:\/\d+['h]?)+)?\])?((?:xpub|tpub)[1-9A-HJ-NP-Za-km-z]+)(.*)$/);
  if (!match) throw new Error('The descriptor contains a key that cannot be represented in a PSBT derivation.');
  return { fingerprint: match[1]?.toLowerCase(), origin: parsePath(match[2] ?? ''), xpub: match[3], suffix: match[4].split('/').filter(Boolean) };
}
function deriveKeys(btc: BtcutilSync, descriptor: string, chain: Chain, index: number): DerivedKey[] {
  return btc.descriptors.create(descriptor).keys().map((key) => {
    const parts = descriptorKeyParts(key);
    let child = parts.xpub;
    const suffixPath: number[] = [];
    for (const element of parts.suffix) {
      let childIndex: number;
      if (element === '*') childIndex = index;
      else if (/^<\d+;\d+>$/.test(element)) childIndex = element.slice(1, -1).split(';').map(Number)[chain];
      else childIndex = parsePath(element)[0];
      if (childIndex >= HARDENED) throw new Error('A public descriptor cannot derive a hardened child.');
      child = btc.hdkeychain.derive(child, childIndex);
      suffixPath.push(childIndex);
    }
    const pubKey = btc.hdkeychain.publicKey(child);
    const fingerprint = parts.fingerprint ?? bytesToHex(btc.hash.hash160(btc.hdkeychain.publicKey(parts.xpub)).slice(0, 4));
    return { pubKey, fingerprint, path: [...parts.origin, ...suffixPath] };
  });
}
function fingerprintNumber(hex: string): number {
  return parseInt((hex.match(/../g) ?? []).reverse().join(''), 16);
}

function bip32(keys: DerivedKey[]): Bip32DerivationInfo[] {
  return keys.map((key) => ({ pubKey: key.pubKey, masterKeyFingerprint: key.fingerprint, path: key.path }));
}
function tapBip32(keys: DerivedKey[]): TaprootBip32DerivationInfo[] {
  return keys.map((key) => ({ xOnlyPubKey: key.pubKey.slice(1), leafHashes: [], masterKeyFingerprint: key.fingerprint, path: key.path }));
}
function opReturnScript(text: string): Uint8Array {
  const data = new TextEncoder().encode(text);
  if (data.length > 80) throw new Error('OP_RETURN data is limited to 80 bytes.');
  return data.length <= 75 ? Uint8Array.from([0x6a, data.length, ...data]) : Uint8Array.from([0x6a, 0x4c, data.length, ...data]);
}
function estimateVsize(inputCount: number, outputScripts: Uint8Array[], satisfactionWeight: number, segwit: boolean): number {
  const varInt = (value: number) => value < 0xfd ? 1 : value <= 0xffff ? 3 : 5;
  const base = 4 + varInt(inputCount) + inputCount * 41 + varInt(outputScripts.length)
    + outputScripts.reduce((sum, script) => sum + 8 + varInt(script.length) + script.length, 0) + 4;
  return Math.ceil((base * 4 + inputCount * satisfactionWeight + (segwit ? 2 : 0)) / 4);
}
function scriptsForType(btc: BtcutilSync, descriptor: string, chain: Chain, index: number) {
  const desc = btc.descriptors.create(descriptor);
  const type = desc.descType();
  const keys = deriveKeys(btc, descriptor, chain, index);
  if (type === 'ShWpkh') return { type, keys, redeemScript: Uint8Array.from([0x00, 0x14, ...btc.hash.hash160(keys[0].pubKey)]), witnessScript: undefined };
  if (type === 'Wsh' || type === 'ShWsh') {
    const witnessScript = desc.scriptCodeAt(chain, index);
    if (type === 'Wsh') return { type, keys, witnessScript, redeemScript: undefined };
    return { type, keys, witnessScript, redeemScript: Uint8Array.from([0x00, 0x20, ...btc.chainhash.hash(witnessScript)]) };
  }
  return { type, keys, redeemScript: undefined, witnessScript: undefined };
}

/** Build a BIP-174 packet from public descriptor data only. There is deliberately no signing path. */
export function buildWatchOnlyPsbt(btc: BtcutilSync, request: PsbtBuildRequest): PsbtBuildResult {
  if (!request.utxos.length) throw new Error('No spendable UTXOs are available.');
  if (!Number.isFinite(request.feeRate) || request.feeRate <= 0) throw new Error('Fee rate must be greater than zero.');
  if (!request.recipients.length) throw new Error('Add at least one recipient.');
  const desc = btc.descriptors.create(request.descriptor);
  const descType = desc.descType();
  const segwit = descType !== 'Pkh';
  const recipientScripts = request.recipients.map((recipient) => hexToBytes(recipient.scriptPubKey));
  const extraScripts = request.opReturn ? [opReturnScript(request.opReturn)] : [];
  const changeScript = hexToBytes(request.change.scriptPubKey);
  const wanted = request.recipients.reduce((sum, recipient) => sum + recipient.value, 0);
  const sorted = [...request.utxos].sort((a, b) => b.value - a.value || a.txid.localeCompare(b.txid) || a.vout - b.vout);
  const selected: PsbtBuildUtxo[] = [];
  let total = 0;
  let fee = 0;
  let vsize = 0;
  for (const utxo of sorted) {
    selected.push(utxo);
    total += utxo.value;
    vsize = estimateVsize(selected.length, [...recipientScripts, ...extraScripts, changeScript], desc.maxWeightToSatisfy(), segwit);
    fee = Math.ceil(vsize * request.feeRate);
    if (!request.sendMax && !request.useAllUtxos && total >= wanted + fee) break;
  }
  if (!request.sendMax && total < wanted + fee) throw new Error('Selected coins do not cover the recipients and fee.');
  const outputs = request.recipients.map((recipient) => ({ ...recipient }));
  let changeValue = 0;
  if (request.sendMax) {
    if (outputs.length !== 1) throw new Error('Max is available only with one recipient.');
    vsize = estimateVsize(selected.length, [...recipientScripts, ...extraScripts], desc.maxWeightToSatisfy(), segwit);
    fee = Math.ceil(vsize * request.feeRate);
    outputs[0].value = total - fee;
    if (outputs[0].value <= DUST) throw new Error('The maximum amount would be dust after fees.');
  } else {
    changeValue = total - wanted - fee;
    if (changeValue <= DUST) {
      vsize = estimateVsize(selected.length, [...recipientScripts, ...extraScripts], desc.maxWeightToSatisfy(), segwit);
      fee = total - wanted;
      changeValue = 0;
    }
  }
  const txOutputs = outputs.map((output) => ({ value: output.value, script: hexToBytes(output.scriptPubKey) }));
  for (const script of extraScripts) txOutputs.push({ value: 0, script });
  const changeIndex = changeValue ? txOutputs.length : -1;
  if (changeValue) txOutputs.push({ value: changeValue, script: changeScript });
  let base64 = btc.psbt.create(
    selected.map((utxo) => ({ txid: utxo.txid, vout: utxo.vout, sequence: request.rbf ? 0xfffffffd : 0xfffffffe })),
    txOutputs, 2, request.locktime,
  );
  selected.forEach((utxo, inputIndex) => {
    const info = scriptsForType(btc, request.descriptor, utxo.chain, utxo.index);
    if (info.type === 'Pkh') {
      if (!utxo.previousTx) throw new Error('A legacy input requires its full previous transaction.');
      base64 = btc.psbt.addInNonWitnessUtxo(base64, inputIndex, hexToBytes(utxo.previousTx));
    } else {
      base64 = btc.psbt.addInWitnessUtxo(base64, inputIndex, utxo.value, hexToBytes(utxo.scriptPubKey));
    }
    if (info.redeemScript) base64 = btc.psbt.addInRedeemScript(base64, inputIndex, info.redeemScript);
    if (info.witnessScript) base64 = btc.psbt.addInWitnessScript(base64, inputIndex, info.witnessScript);
    if (info.type !== 'Tr') {
      for (const key of info.keys) base64 = btc.psbt.addInBip32Derivation(base64, inputIndex, fingerprintNumber(key.fingerprint), key.path, key.pubKey);
    }
  });
  if (changeIndex >= 0) {
    const info = scriptsForType(btc, request.descriptor, 1, request.change.index);
    if (info.redeemScript) base64 = btc.psbt.addOutRedeemScript(base64, changeIndex, info.redeemScript);
    if (info.witnessScript) base64 = btc.psbt.addOutWitnessScript(base64, changeIndex, info.witnessScript);
    if (info.type !== 'Tr') {
      for (const key of info.keys) base64 = btc.psbt.addOutBip32Derivation(base64, changeIndex, fingerprintNumber(key.fingerprint), key.path, key.pubKey);
    }
  }
  // BIP-371 taproot fields are added through btcutil's structured PSBT codec.
  if (descType === 'Tr') {
    const packet = btc.psbt.decode(base64);
    selected.forEach((utxo, inputIndex) => {
      const keys = deriveKeys(btc, request.descriptor, utxo.chain, utxo.index);
      packet.inputs[inputIndex].taprootInternalKey = keys[0].pubKey.slice(1);
      packet.inputs[inputIndex].taprootBip32Derivation = tapBip32(keys);
    });
    if (changeIndex >= 0) {
      const keys = deriveKeys(btc, request.descriptor, 1, request.change.index);
      packet.outputs[changeIndex].taprootInternalKey = keys[0].pubKey.slice(1);
      packet.outputs[changeIndex].taprootBip32Derivation = tapBip32(keys);
    }
    base64 = btc.psbt.encode(packet);
  }
  btc.psbt.sanityCheck(base64);
  btc.psbt.inputsReadyToSign(base64);
  return {
    base64, hex: bytesToHex(btc.psbt.fromBase64(base64)), selected, outputs,
    changeAddress: changeValue ? request.change.address : undefined,
    changeValue, fee, feeRate: request.feeRate, vsize,
  };
}

/** Finalize signatures supplied by an external signer and extract the raw transaction. */
export function finalizeExternalPsbt(btc: BtcutilSync, base64: string): PsbtFinalizedResult {
  btc.psbt.sanityCheck(base64);
  const finalized = btc.psbt.maybeFinalizeAll(base64);
  if (!btc.psbt.isComplete(finalized)) throw new Error('The PSBT is not fully signed. Finish signing it externally and import it again.');
  return { base64: finalized, rawHex: bytesToHex(btc.psbt.extract(finalized)) };
}
