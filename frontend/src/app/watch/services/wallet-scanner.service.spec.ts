import { of } from 'rxjs';
import { ElectrsApiService } from '@app/services/electrs-api.service';
import { Chain } from '../watch.types';
import { DerivationService } from './derivation.service';
import { WalletScanRequest, WalletScannerService } from './wallet-scanner.service';

describe('wallet scanner requests', () => {
  it('scans through reserved change and preserves the existing identity', async () => {
    const derivation = jasmine.createSpyObj<DerivationService>('derivation', ['derive']);
    derivation.derive.and.callFake(async (_descriptor, _network, chain: Chain, from, count) =>
      Array.from({ length: count }, (_, offset) => ({ chain, index: from + offset, address: `${chain}/${from + offset}` })),
    );
    const api = jasmine.createSpyObj<ElectrsApiService>('api', ['getAddressesTransactions$']);
    api.getAddressesTransactions$.and.returnValue(of([]));
    const scanner = new WalletScannerService(api, derivation);
    const request: WalletScanRequest = {
      descriptor: 'wpkh(public-key/<0;1>/*)', source: 'public-key', scriptType: 'wpkh',
      network: 'mainnet', gapLimit: 5, label: 'Savings',
      identity: { fingerprint: '12345678', fingerprintIsMaster: true, signingOriginsComplete: true },
      minimumDerived: { 0: 5, 1: 16 }, existingWalletId: 'saved-wallet',
    };
    const result = await scanner.scan(request);
    expect(result.wallet.id).toBe('saved-wallet');
    expect(result.wallet.fingerprint).toBe('12345678');
    expect(result.wallet.signingOriginsComplete).toBeTrue();
    expect(result.wallet.derivedCount).toEqual({ 0: 5, 1: 20 });
    expect(result.truncated).toBeFalse();
    const queried = api.getAddressesTransactions$.calls.allArgs().flatMap(([addresses]) => addresses);
    expect(queried).toContain('1/19');
    expect(new Set(queried).size).toBe(queried.length);
  });
});
