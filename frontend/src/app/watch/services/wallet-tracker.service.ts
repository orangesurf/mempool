import { Injectable, OnDestroy } from '@angular/core';
import { Subject, Subscription } from 'rxjs';
import { WebsocketService } from '@app/services/websocket.service';
import { StateService } from '@app/services/state.service';
import { Transaction } from '@interfaces/electrs.interface';
import { WalletUtxo, WatchWallet, Chain } from '../watch.types';
import { WalletService } from './wallet.service';

/**
 * Production mainnet sets MAX_TRACKED_ADDRESSES to 10
 * (production/mempool-config.mainnet.json). A BIP-44 wallet needs 40+ addresses, so we
 * cannot simply subscribe to the whole wallet — and going over the cap does not degrade,
 * it makes the backend track *nothing* (websocket-handler.ts:286-288).
 *
 * So we track only what genuinely needs to be live, and let the per-block refresh catch the
 * rest. The number is not knowable from the frontend, so we stay conservatively at the
 * mainnet value and fall back to polling if the server rejects us anyway.
 */
const MAX_TRACKED = 10;

/** How many not-yet-used receive addresses to watch for incoming payments. */
const WATCH_UNUSED_RECEIVE = 3;

@Injectable()
export class WalletTrackerService implements OnDestroy {
  /** Emits whenever live tracking sees something that changes the wallet. */
  walletUpdated$ = new Subject<void>();

  /** True when the websocket subscription was refused and we are polling only. */
  degraded = false;

  private subscription = new Subscription();
  private tracking = false;

  constructor(
    private websocketService: WebsocketService,
    private stateService: StateService,
    private walletService: WalletService,
  ) {}

  /**
   * Choose the ≤ MAX_TRACKED addresses that actually need to be live:
   *   - the next few *unused* receive addresses  → an incoming payment shows up instantly
   *   - the highest-value addresses holding UTXOs → our coins being spent shows up instantly
   *
   * Everything else is caught by the per-block refresh. Exact for the common case (a wallet
   * whose funds sit on a handful of addresses); for a wallet with more funded addresses than
   * we can watch, the missed events simply arrive one block later rather than being wrong.
   */
  selectTracked(wallet: WatchWallet, utxos: WalletUtxo[], lastUsed: Record<Chain, number>): string[] {
    const selected: string[] = [];

    const nextReceive = lastUsed[0] + 1;
    for (let i = 0; i < WATCH_UNUSED_RECEIVE; i++) {
      const addr = wallet.addresses.find((a) => a.chain === 0 && a.index === nextReceive + i);
      if (addr) {
        selected.push(addr.address);
      }
    }

    // Highest value first — if we cannot watch every funded address, watch the ones that
    // matter most.
    const byValue = new Map<string, number>();
    for (const utxo of utxos) {
      byValue.set(utxo.address, (byValue.get(utxo.address) || 0) + utxo.value);
    }
    const funded = [...byValue.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([address]) => address);

    for (const address of funded) {
      if (selected.length >= MAX_TRACKED) {
        break;
      }
      if (!selected.includes(address)) {
        selected.push(address);
      }
    }

    return selected.slice(0, MAX_TRACKED);
  }

  /**
   * Start live tracking. `onNewTransactions` is called with transactions the websocket
   * reports for the tracked subset; `onBlock` fires on every new block so the caller can
   * refresh the full address set over REST.
   */
  start(
    wallet: WatchWallet,
    utxos: WalletUtxo[],
    lastUsed: Record<Chain, number>,
    onNewTransactions: (txs: Transaction[]) => void,
    onBlock: () => void,
  ): void {
    this.stop();

    const tracked = this.selectTracked(wallet, utxos, lastUsed);
    if (!tracked.length) {
      return;
    }

    this.degraded = false;
    this.tracking = true;
    this.websocketService.startTrackAddresses(tracked);

    // Without this the failure is silent: the server tracks nothing and we wait forever.
    this.subscription.add(this.stateService.trackAddressesError$.subscribe(() => {
      this.degraded = true;
      this.tracking = false;
      this.walletUpdated$.next();
    }));

    this.subscription.add(this.stateService.multiAddressTransactions$.subscribe((update) => {
      const fresh: Transaction[] = [];
      for (const address of Object.keys(update)) {
        if (!this.walletService.isMine(address)) {
          continue;
        }
        fresh.push(...(update[address].mempool || []), ...(update[address].confirmed || []));
      }
      if (fresh.length) {
        onNewTransactions(fresh);
        this.walletUpdated$.next();
      }
    }));

    // The catch-all: everything outside the tracked subset is picked up on the NEXT block.
    // blocks$ is a BehaviorSubject and replays the current tip the instant we subscribe, so
    // guard on height — otherwise merely starting tracking (which happens on every wallet
    // switch) would fire a full refresh. Only a strictly newer block triggers onBlock.
    let seenHeight = this.stateService.latestBlockHeight;
    this.subscription.add(this.stateService.blocks$.subscribe((blocks) => {
      const height = blocks.reduce((h, b) => Math.max(h, b.height), -1);
      if (height > seenHeight) {
        seenHeight = height;
        onBlock();
      }
    }));
  }

  stop(): void {
    if (this.tracking) {
      this.websocketService.stopTrackingAddresses();
      this.tracking = false;
    }
    this.subscription.unsubscribe();
    this.subscription = new Subscription();
  }

  ngOnDestroy(): void {
    this.stop();
  }
}
