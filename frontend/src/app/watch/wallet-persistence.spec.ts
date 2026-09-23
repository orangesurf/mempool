import { StorageService } from '@app/services/storage.service';
import { WalletLabelsService, WalletLocalStateService } from './services/wallet-storage.service';
import { WatchWallet } from './watch.types';

class MemoryStorage {
  values = new Map<string, string>();

  getValue(key: string): string {
    return this.values.get(key) ?? '';
  }

  setValue(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function wallet(id: string, network: WatchWallet['network'] = 'mainnet'): WatchWallet {
  return {
    id,
    label: id,
    source: 'source-' + id,
    descriptor: 'wpkh(xpub-' + id + '/<0;1>/*)',
    scriptType: 'wpkh',
    fingerprintIsMaster: false,
    network,
    gapLimit: 20,
    derivedCount: { 0: 1, 1: 1 },
    addresses: [],
  };
}

describe('watch wallet persistence', () => {
  let memory: MemoryStorage;

  beforeEach(() => {
    memory = new MemoryStorage();
  });

  it('persists labels across service instances and isolates wallets and networks', () => {
    const first = wallet('first');
    const second = wallet('second');
    const testnet = wallet('first', 'testnet');
    new WalletLabelsService(memory as unknown as StorageService)
      .set(first, 'addr', 'bc1qexample', 'Savings');

    const restored = new WalletLabelsService(memory as unknown as StorageService);
    expect(restored.get(first, 'addr', 'bc1qexample')).toBe('Savings');
    expect(restored.get(second, 'addr', 'bc1qexample')).toBe('');
    expect(restored.get(testnet, 'addr', 'bc1qexample')).toBe('');
  });

  it('persists frozen outpoints and the receive cursor', () => {
    const target = wallet('coin-control');
    const state = new WalletLocalStateService(memory as unknown as StorageService);
    state.setFrozen(target, 'abc:1', true);
    state.setReceiveIndex(target, 7);

    const restored = new WalletLocalStateService(memory as unknown as StorageService);
    expect(restored.isFrozen(target, 'abc:1')).toBe(true);
    expect(restored.getReceiveIndex(target)).toBe(7);
    restored.setFrozen(target, 'abc:1', false);
    expect(restored.isFrozen(target, 'abc:1')).toBe(false);
  });

  it('persists acknowledgement of incomplete signing origins', () => {
    const target = wallet('bare-xpub');
    const state = new WalletLocalStateService(memory as unknown as StorageService);
    expect(state.getDescriptorOriginAcknowledged(target)).toBe(false);

    state.setDescriptorOriginAcknowledged(target, true);

    const restored = new WalletLocalStateService(memory as unknown as StorageService);
    expect(restored.getDescriptorOriginAcknowledged(target)).toBe(true);
  });
});
