import { ChangeDetectorRef } from '@angular/core';
import { Router } from '@angular/router';
import { StateService } from '@app/services/state.service';
import { RelativeUrlPipe } from '@app/shared/pipes/relative-url/relative-url.pipe';
import { Subject } from 'rxjs';
import { PsbtBuildResult } from '../psbt.utils';
import { WalletUtxo, WatchWallet } from '../watch.types';
import { DerivationService } from './derivation.service';
import { WalletSendContext, WalletSendController } from './wallet-send.controller';
import { WalletLocalStateService, WalletStorageService } from './wallet-storage.service';
import { WalletService } from './wallet.service';

const ADDRESS = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const SCRIPT = '0014c0cebcd6c3d3ca8c75dc5ec62ebe55330ef910e2';

function coin(id: string): WalletUtxo {
  return { txid: id.repeat(64), vout: 0, value: 100_000, address: ADDRESS, confirmed: true };
}

function wallet(): WatchWallet {
  return {
    id: 'wallet', label: 'Wallet', descriptor: 'wpkh(test)', source: 'public-key',
    network: 'mainnet', scriptType: 'wpkh', fingerprintIsMaster: true,
    signingOriginsComplete: true, gapLimit: 20, derivedCount: { 0: 1, 1: 1 },
    addresses: [0, 1].map((chain: 0 | 1) => ({ chain, index: 0, address: ADDRESS, scriptPubKey: SCRIPT })),
  };
}

function built(): PsbtBuildResult {
  return {
    base64: 'cHNidP8=', hex: '70736274ff', selected: [], outputs: [],
    changeAddress: ADDRESS, changeValue: 50_000, fee: 100, feeRate: 1,
    requestedFeeRate: 1, vsize: 100,
  };
}

describe('wallet send workflow', () => {
  let send: WalletSendController;
  let context: WalletSendContext;
  let derivation: jasmine.SpyObj<DerivationService>;
  let localState: jasmine.SpyObj<WalletLocalStateService>;
  let amountMode: Subject<'btc' | 'sats'>;
  let frozen: Set<string>;

  beforeEach(() => {
    const current = wallet();
    frozen = new Set();
    context = {
      wallet: current, wallets: [current], network: 'mainnet', utxos: [coin('a')],
      transactions: [], lastUsed: { 0: -1, 1: -1 }, scanning: false, truncated: false,
      descriptorOriginAcknowledged: false, fileStem: 'wallet', graphUtxos: [], graphFrozenOutpoints: new Set(),
      outpoint: (utxo) => `${utxo.txid}:${utxo.vout}`,
      isFrozen: (utxo) => frozen.has(utxo.txid), labelFor: () => '',
    };
    derivation = jasmine.createSpyObj<DerivationService>('derivation', ['buildPsbt', 'estimateTransaction', 'maxSendAmount']);
    derivation.estimateTransaction.and.resolveTo({ fee: 100, vsize: 100, changeValue: 49_900 });
    derivation.maxSendAmount.and.resolveTo({ value: 99_900, fee: 100, vsize: 100 });
    localState = jasmine.createSpyObj<WalletLocalStateService>('localState', ['getChangeIndex', 'setChangeIndex']);
    localState.getChangeIndex.and.returnValue(0);
    amountMode = new Subject();
    send = new WalletSendController(
      context,
      { recommendedFees$: new Subject(), viewAmountMode$: amountMode, network: '' } as unknown as StateService,
      derivation,
      jasmine.createSpyObj<WalletStorageService>('storage', ['save']),
      jasmine.createSpyObj<WalletService>('walletService', ['syncWallets']),
      localState,
      jasmine.createSpyObj<Router>('router', ['navigate']),
      { transform: (path: string) => path } as RelativeUrlPipe,
      jasmine.createSpyObj<ChangeDetectorRef>('cd', ['markForCheck', 'detectChanges']),
    );
    send.initialize();
    send.syncSendCoinSelection();
  });

  afterEach(() => send.destroy());

  it('preserves deselections, selects new coins, and drops frozen coins', () => {
    send.clearSendCoins();
    context.utxos = [...context.utxos, coin('b')];
    send.syncSendCoinSelection();
    expect(send.sendSelectedUtxos.map((utxo) => utxo.txid)).toEqual(['b'.repeat(64)]);
    frozen.add('b'.repeat(64));
    send.syncSendCoinSelection();
    expect(send.sendSelectedUtxos).toEqual([]);
  });

  it('does not publish an in-flight draft or reserve change after switching wallets', async () => {
    let finish!: (result: PsbtBuildResult) => void;
    derivation.buildPsbt.and.returnValue(new Promise((resolve) => { finish = resolve; }));
    send.sendRecipients = [{ target: ADDRESS, amountBtc: '0.0005' }];
    const pending = send.buildSendPsbt();
    await Promise.resolve();
    expect(derivation.buildPsbt).toHaveBeenCalled();
    context.wallet = { ...wallet(), id: 'other-wallet' };
    send.resetSendFlow();
    finish(built());
    await pending;
    expect(send.builtPsbt).toBeNull();
    expect(localState.setChangeIndex).not.toHaveBeenCalled();
    expect(send.psbtQrExportVisible).toBeFalse();
  });

  it('blocks construction while refreshing or when history is incomplete', async () => {
    context.scanning = true;
    await send.buildSendPsbt();
    expect(send.psbtError).toContain('refresh');
    context.scanning = false;
    context.truncated = true;
    await send.buildSendPsbt();
    expect(send.psbtError).toContain('truncated');
    expect(derivation.buildPsbt).not.toHaveBeenCalled();
  });

  it('converts entered amounts when display units change and unsubscribes on destroy', () => {
    send.sendRecipients = [{ target: '', amountBtc: '0.00001234', amountBeforeMax: '0.000001' }];
    amountMode.next('sats');
    expect(send.sendRecipients[0].amountBtc).toBe('1234');
    expect(send.sendRecipients[0].amountBeforeMax).toBe('100');
    send.destroy();
    amountMode.next('btc');
    expect(send.sendAmountMode).toBe('sats');
  });

  it('discards signed data and closes QR playback when the draft changes', () => {
    send.builtPsbt = built();
    send.signedPsbtInput = 'signed payload';
    send.psbtQrExportVisible = true;
    send.psbtQrPlaying = true;
    const stop = spyOn(send, 'stopSignedPsbtQrScan').and.callThrough();
    send.invalidateSendDraft();
    expect(send.builtPsbt).toBeNull();
    expect(send.signedPsbtInput).toBe('');
    expect(send.psbtQrExportVisible).toBeFalse();
    expect(send.psbtQrPlaying).toBeFalse();
    expect(stop).toHaveBeenCalled();
  });
});
