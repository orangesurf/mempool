import { BtcutilSync, init } from 'btcutil-js';
import {
  buildWatchOnlyPsbt,
  bytesToHex,
  calculateWatchOnlyMaxAmount,
  estimateWatchOnlyTransaction,
  finalizeExternalPsbt,
  normalizePsbtText,
  normalizeSignedTransactionText,
  parseBitcoinRecipient,
  PsbtBuildRequest,
} from './psbt.utils';

const XPUB = 'xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V';
const XPUB_2 = 'xpub6DzhyrnFFYQ1HimDiM388xHnDiRPNdZJFBmmxge3Y1WWcHLtMJLfRuhRHqnQCPbTj3fGKTuKFLHzzwpJkp5Dtc3UtLKZKaVZe1yqMBXd6Vk';
const SIGNED_PSBT = 'cHNidP8BAHECAAAAARERERERERERERERERERERERERERERERERERERERERERAAAAAAD9////AkCcAAAAAAAAFgAUnJD5NOpR+g9lBBdwQ+CQjaaSmYNG6QAAAAAAABYAFD40mF3Kb93J+zaZQOTH2OKHP1KcAAAAAAABAR+ghgEAAAAAABYAFMDOvNbD08qMddxexi6+VTMO+RDiIgIDMNVP0N1CCm5fjTYk9fNILK41D3nV8HU79b7vnC2RrzxIMEUCIQD4PXanha+qezOhjAr78JDwpirMecjwsrwz+9dYfWVUlQIgG04xIUL4CXBrLKTVXAZp1+8ZSHxYj2ZKebIbMXZAKAsBIgYDMNVP0N1CCm5fjTYk9fNILK41D3nV8HU79b7vnC2RrzwYc8XaClQAAIAAAACAAAAAgAAAAAAAAAAAAAAiAgMCUySIjkKauOPbrx94AmSLnNAem0GEhcX6TBubVwDhphhzxdoKVAAAgAAAAIAAAACAAQAAAAAAAAAA';
const FINAL_TX = '0200000000010111111111111111111111111111111111111111111111111111111111111111110000000000fdffffff02409c0000000000001600149c90f934ea51fa0f6504177043e0908da692998346e90000000000001600143e34985dca6fddc9fb369940e4c7d8e2873f529c02483045022100f83d76a785afaa7b33a18c0afbf090f0a62acc79c8f0b2bc33fbd7587d65549502201b4e312142f809706b2ca4d55c0669d7ef19487c588f664a79b21b317640280b01210330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c00000000';

describe('watch-only PSBT construction', () => {
  let btc: BtcutilSync;

  beforeAll(async () => {
    const wasm = await fetch('/resources/btcutil.wasm').then((response) => response.arrayBuffer());
    btc = await init(wasm);
  });

  function request(descriptor: string, value = 100_000): PsbtBuildRequest {
    const desc = btc.descriptors.create(descriptor);
    const inputAddress = desc.addressAt('mainnet', 0, 0);
    const recipientAddress = desc.addressAt('mainnet', 0, 1);
    const changeAddress = desc.addressAt('mainnet', 1, 0);
    const script = (address: string) => bytesToHex(btc.txscript.payToAddrScript(address, 'mainnet'));
    return {
      descriptor,
      network: 'mainnet',
      utxos: [{
        txid: '11'.repeat(32), vout: 0, value, address: inputAddress, confirmed: true,
        scriptPubKey: script(inputAddress), chain: 0, index: 0,
      }],
      recipients: [{ address: recipientAddress, value: 40_000, scriptPubKey: script(recipientAddress) }],
      change: { address: changeAddress, scriptPubKey: script(changeAddress), chain: 1, index: 0 },
      feeRate: 2,
      maxRecipientIndex: null,
      useAllUtxos: false,
      version: 2,
      sequence: 0xfffffffd,
      locktime: 0,
    };
  }

  it('builds a signer-ready BIP84 PSBT and round-trips every required field', () => {
    const descriptor = `wpkh([73c5da0a/84h/0h/0h]${XPUB}/<0;1>/*)`;
    const built = buildWatchOnlyPsbt(btc, request(descriptor));
    const decoded = btc.psbt.decode(built.base64);
    expect(decoded.unsignedTx.inputs.length).toBe(1);
    expect(decoded.unsignedTx.outputs.map((output) => output.value)).toEqual([40_000, 59_718]);
    expect(decoded.inputs[0].witnessUtxo?.value).toBe(100_000);
    expect(decoded.inputs[0].nonWitnessUtxo).toBeUndefined();
    expect(decoded.inputs[0].bip32Derivation?.length).toBe(1);
    expect(decoded.inputs[0].bip32Derivation?.[0].masterKeyFingerprint).toBe('73c5da0a');
    expect(decoded.unsignedTx.inputs[0].txid).toBe('11'.repeat(32));
    expect(decoded.unsignedTx.inputs[0].vout).toBe(0);
    expect(bytesToHex(decoded.unsignedTx.outputs[0].scriptPubKey)).toBe(request(descriptor).recipients[0].scriptPubKey);
    expect(bytesToHex(decoded.unsignedTx.outputs[1].scriptPubKey)).toBe(request(descriptor).change.scriptPubKey);
    expect(decoded.inputs[0].bip32Derivation?.[0].pathStr).toBe("m/84'/0'/0'/0/0");
    expect(decoded.outputs[1].bip32Derivation?.[0].pathStr).toBe("m/84'/0'/0'/1/0");
    expect(btc.psbt.decode(btc.psbt.encode(decoded)).inputs[0].witnessUtxo?.value).toBe(100_000);
  });

  it('uses a full non-witness UTXO for a legacy descriptor', () => {
    const descriptor = `pkh([73c5da0a/44h/0h/0h]${XPUB}/<0;1>/*)`;
    const buildRequest = request(descriptor, 120_000);
    const previousTx = btc.tx.encode({
      version: 2, locktime: 0,
      inputs: [{ txid: '00'.repeat(32), vout: 0xffffffff, scriptSig: '00', sequence: 0xffffffff }],
      outputs: [{ value: 120_000, scriptPubKey: buildRequest.utxos[0].scriptPubKey }],
    });
    buildRequest.utxos[0].txid = btc.tx.decode(previousTx).txid;
    buildRequest.utxos[0].previousTx = bytesToHex(previousTx);
    const decoded = btc.psbt.decode(buildWatchOnlyPsbt(btc, buildRequest).base64);
    const nonWitnessUtxo = decoded.inputs[0].nonWitnessUtxo;
    expect(typeof nonWitnessUtxo === 'string' ? nonWitnessUtxo : bytesToHex(nonWitnessUtxo!)).toBe(bytesToHex(previousTx));
    expect(decoded.inputs[0].witnessUtxo).toBeUndefined();
    expect(decoded.inputs[0].bip32Derivation?.[0].pathStr).toBe("m/44'/0'/0'/0/0");
  });

  it('populates both multisig derivations plus redeem and witness scripts', () => {
    const descriptor = `sh(wsh(sortedmulti(2,[73c5da0a/48h/0h/0h/2h]${XPUB}/<0;1>/*,[d34db33f/48h/0h/1h/2h]${XPUB_2}/<0;1>/*)))`;
    const decoded = btc.psbt.decode(buildWatchOnlyPsbt(btc, request(descriptor, 150_000)).base64);
    expect(decoded.inputs[0].witnessUtxo?.value).toBe(150_000);
    expect(decoded.inputs[0].bip32Derivation?.length).toBe(2);
    expect(decoded.inputs[0].redeemScript?.length).toBe(34);
    expect(decoded.inputs[0].witnessScript?.length).toBe(71);
    expect(decoded.outputs[1].bip32Derivation?.length).toBe(2);
    expect(decoded.outputs[1].redeemScript?.length).toBe(34);
    expect(decoded.outputs[1].witnessScript?.length).toBe(71);
  });

  it('finalizes a PSBT signed by an external fixture and extracts the expected transaction', () => {
    expect(finalizeExternalPsbt(btc, SIGNED_PSBT).rawHex).toBe(FINAL_TX);
  });

  it('uses BIP-371 internal-key and derivation fields for taproot', () => {
    const descriptor = `tr([73c5da0a/86h/0h/0h]${XPUB}/<0;1>/*)`;
    const decoded = btc.psbt.decode(buildWatchOnlyPsbt(btc, request(descriptor)).base64);
    expect(decoded.inputs[0].witnessUtxo?.value).toBe(100_000);
    expect(decoded.inputs[0].taprootInternalKey?.length).toBe(32);
    expect(decoded.inputs[0].taprootBip32Derivation?.[0].masterKeyFingerprint).toBe('73c5da0a');
    expect(decoded.inputs[0].taprootBip32Derivation?.[0].pathStr).toBe("m/86'/0'/0'/0/0");
    expect(decoded.outputs[1].taprootInternalKey?.length).toBe(32);
    expect(decoded.outputs[1].taprootBip32Derivation?.[0].pathStr).toBe("m/86'/0'/0'/1/0");
  });

  it('builds a valid no-change transaction when a change output would make it underfunded', () => {
    const descriptor = `wpkh([73c5da0a/84h/0h/0h]${XPUB}/<0;1>/*)`;
    const buildRequest = request(descriptor);
    buildRequest.recipients[0].value = 99_750;
    const built = buildWatchOnlyPsbt(btc, buildRequest);
    expect(btc.psbt.decode(built.base64).unsignedTx.outputs.length).toBe(1);
    expect(built.changeValue).toBe(0);
    expect(built.fee).toBe(250);
    expect(built.feeRate).toBe(built.fee / built.vsize);
  });

  it('calculates the same fee-adjusted Max amount shown before building the sweep PSBT', () => {
    const descriptor = `wpkh([73c5da0a/84h/0h/0h]${XPUB}/<0;1>/*)`;
    const buildRequest = request(descriptor);
    const desc = btc.descriptors.create(descriptor);
    const secondInputAddress = desc.addressAt('mainnet', 0, 1);
    buildRequest.utxos.push({
      txid: '22'.repeat(32), vout: 1, value: 50_000, address: secondInputAddress, confirmed: true,
      scriptPubKey: bytesToHex(btc.txscript.payToAddrScript(secondInputAddress, 'mainnet')), chain: 0, index: 1,
    });
    const fixedAddress = desc.addressAt('mainnet', 0, 2);
    buildRequest.recipients.push({ address: fixedAddress, value: 10_000, scriptPubKey: bytesToHex(btc.txscript.payToAddrScript(fixedAddress, 'mainnet')) });
    buildRequest.maxRecipientIndex = 0;
    buildRequest.useAllUtxos = true;
    buildRequest.opReturn = 'max test';
    const maximum = calculateWatchOnlyMaxAmount(btc, {
      descriptor,
      utxoValues: buildRequest.utxos.map((utxo) => utxo.value),
      recipients: buildRequest.recipients.map((recipient) => ({ scriptPubKey: recipient.scriptPubKey, value: recipient.value })),
      maxRecipientIndex: 0,
      feeRate: buildRequest.feeRate,
      opReturn: buildRequest.opReturn,
    });
    const built = buildWatchOnlyPsbt(btc, buildRequest);
    expect(maximum).toEqual({ value: built.outputs[0].value, fee: built.fee, vsize: built.vsize });
    expect(built.outputs[1].value).toBe(10_000);
  });

  it('estimates the final size and fee without constructing a PSBT', () => {
    const descriptor = `wpkh([73c5da0a/84h/0h/0h]${XPUB}/<0;1>/*)`;
    const buildRequest = request(descriptor);
    buildRequest.useAllUtxos = true;
    buildRequest.opReturn = 'live estimate';
    const estimate = estimateWatchOnlyTransaction(btc, {
      descriptor,
      utxoValues: buildRequest.utxos.map((utxo) => utxo.value),
      recipients: buildRequest.recipients.map(({ scriptPubKey, value }) => ({ scriptPubKey, value })),
      changeScriptPubKey: buildRequest.change.scriptPubKey,
      maxRecipientIndex: null,
      feeRate: buildRequest.feeRate,
      opReturn: buildRequest.opReturn,
    });
    const built = buildWatchOnlyPsbt(btc, buildRequest);

    expect(estimate).toEqual({ fee: built.fee, vsize: built.vsize, changeValue: built.changeValue });
  });

  it('preserves configurable transaction version, locktime, and relative sequence', () => {
    const descriptor = `wpkh([73c5da0a/84h/0h/0h]${XPUB}/<0;1>/*)`;
    const buildRequest = request(descriptor);
    buildRequest.version = 2;
    buildRequest.locktime = 900_000;
    buildRequest.sequence = 144;
    const tx = btc.psbt.decode(buildWatchOnlyPsbt(btc, buildRequest).base64).unsignedTx;
    expect(tx.version).toBe(2);
    expect(tx.locktime).toBe(900_000);
    expect(tx.inputs[0].sequence).toBe(144);
  });

  it('encodes OP_RETURN payloads larger than the former 80-byte policy limit', () => {
    const descriptor = `wpkh([73c5da0a/84h/0h/0h]${XPUB}/<0;1>/*)`;
    const buildRequest = request(descriptor);
    buildRequest.opReturn = 'x'.repeat(256);
    const tx = btc.psbt.decode(buildWatchOnlyPsbt(btc, buildRequest).base64).unsignedTx;
    expect(bytesToHex(tx.outputs[1].scriptPubKey).startsWith('6a4d0001')).toBe(true);
  });

  it('rejects recipient amounts below the address-specific dust threshold', () => {
    const descriptor = `wpkh([73c5da0a/84h/0h/0h]${XPUB}/<0;1>/*)`;
    const buildRequest = request(descriptor);
    buildRequest.recipients[0].value = 100;
    expect(() => buildWatchOnlyPsbt(btc, buildRequest)).toThrowError(/dust threshold/);
  });

  it('accepts base64/hex transport and parses BIP21 amounts without rounding', () => {
    const hex = bytesToHex(btc.psbt.fromBase64(SIGNED_PSBT));
    expect(normalizePsbtText(hex)).toBe(SIGNED_PSBT);
    expect(normalizeSignedTransactionText(FINAL_TX)).toEqual({ kind: 'transaction', rawHex: FINAL_TX });
    expect(parseBitcoinRecipient('bitcoin:bc1qexample?amount=0.00123456')).toEqual({ address: 'bc1qexample', amount: 123_456 });
  });
});
