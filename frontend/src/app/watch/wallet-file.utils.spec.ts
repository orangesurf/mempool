import { parseWalletFile, sparrowExport } from './wallet-file.utils';
import { WatchWallet } from './watch.types';

const XPUB = 'xpub' + 'A'.repeat(107);
const ZPUB = 'Zpub' + 'A'.repeat(107);

describe('wallet-file.utils', () => {
  it('extracts a descriptor text export', () => {
    const result = parseWalletFile(`wpkh(${XPUB}/<0;1>/*)#abcd1234`);
    expect(result.format).toBe('descriptor');
    expect(result.input).toContain('/<0;1>/*');
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

  it('exports descriptor-only Sparrow JSON', () => {
    const output = sparrowExport({
      label: 'Wallet', descriptor: `wpkh(${XPUB}/<0;1>/*)`, gapLimit: 20,
      network: 'mainnet', source: XPUB,
    } as WatchWallet);
    const parsed = JSON.parse(output);
    expect(parsed.descriptor).toContain('wpkh(');
    expect(parsed.source).toBeUndefined();
    expect(parsed.watchOnly).toBe(true);
  });
  it('refuses seed fields and WIF descriptor keys', () => {
    expect(() => parseWalletFile(JSON.stringify({ descriptor: `wpkh(${XPUB}/0/*)`, master_private_extended_key: 'secret' })))
      .toThrowError(/private-key material/);
    expect(() => parseWalletFile(`wpkh(K${'A'.repeat(51)})`)).toThrowError(/private key/);
  });

});
