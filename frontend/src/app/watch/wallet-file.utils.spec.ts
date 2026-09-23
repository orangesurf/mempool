import { parseWalletFile, sparrowExport } from './wallet-file.utils';
import { WatchWallet } from './watch.types';

const XPUB = 'xpub' + 'A'.repeat(107);
const ZPUB = 'Zpub' + 'A'.repeat(107);

describe('wallet-file.utils', () => {
  it('extracts a descriptor text export', () => {
    const descriptor = `wpkh(${XPUB}/<0;1>/*)#abcd1234`;
    const result = parseWalletFile(`# Receive and change descriptor:\n${descriptor}\n`);
    expect(result.format).toBe('descriptor');
    expect(result.input).toBe(descriptor);
  });

  it('extracts Sparrow JSON metadata', () => {
    const result = parseWalletFile(JSON.stringify({
      name: 'Sparrow watch', policyType: 'SINGLE', scriptType: 'P2WPKH', gapLimit: 42,
      keystores: [{ extendedPublicKey: XPUB, keyDerivation: { masterFingerprint: 'aabbccdd', derivationPath: 'm/84h/0h/0h' } }],
    }));
    expect(result.format).toBe('sparrow');
    expect(result.label).toBe('Sparrow watch');
    expect(result.gapLimit).toBe(42);
    expect(result.input).toContain('[aabbccdd/84');
  });

  it('builds Electrum multisig', () => {
    const result = parseWalletFile(JSON.stringify({
      wallet_type: '2of2', gap_limit: 30,
      'x1/': { xpub: ZPUB, derivation: 'm/48h/0h/0h/2h' },
      'x2/': { xpub: ZPUB.replace(/A$/, 'B'), derivation: 'm/48h/0h/0h/2h' },
    }));
    expect(result.format).toBe('electrum');
    expect(result.input.startsWith('wsh(sortedmulti(2,')).toBe(true);
  });

  it('never fabricates a master fingerprint when a wallet file only has a path', () => {
    const result = parseWalletFile(JSON.stringify({
      name: 'Watch only', policyType: 'SINGLE', scriptType: 'P2WPKH',
      keystores: [{ extendedPublicKey: XPUB, keyDerivation: { derivationPath: 'm/84h/0h/0h' } }],
    }));
    expect(result.input.includes('00000000')).toBe(false);
    expect(result.input.includes('[')).toBe(false);
  });

  it('exports native watch-only Sparrow JSON that round-trips through the importer', () => {
    const output = sparrowExport({
      label: 'Wallet', descriptor: `wpkh(${XPUB}/<0;1>/*)`, gapLimit: 20,
      network: 'mainnet', source: XPUB, scriptType: 'wpkh',
    } as WatchWallet);
    const parsed = JSON.parse(output);
    expect(parsed.descriptor).toContain('wpkh(');
    expect(parsed.policyType).toBe('SINGLE');
    expect(parsed.scriptType).toBe('P2WPKH');
    expect(parsed.keystores[0].extendedPublicKey).toBe(XPUB);
    expect(parsed.source).toBeUndefined();
    expect(parsed.watchOnly).toBe(true);
    expect(parseWalletFile(output).format).toBe('sparrow');
  });
  it('refuses seed fields and WIF descriptor keys', () => {
    expect(() => parseWalletFile(JSON.stringify({ descriptor: `wpkh(${XPUB}/0/*)`, master_private_extended_key: 'secret' })))
      .toThrowError(/private-key material/);
    expect(() => parseWalletFile(`wpkh(K${'A'.repeat(51)})`)).toThrowError(/private key/);
  });

});
