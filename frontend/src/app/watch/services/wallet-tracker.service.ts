import { Injectable, OnDestroy } from '@angular/core';
import { Subscription } from 'rxjs';
import { WebsocketService } from '@app/services/websocket.service';
import { StateService } from '@app/services/state.service';
import { Transaction } from '@interfaces/electrs.interface';
import { BlockExtended } from '@interfaces/node-api.interface';
import { ChainTip, DerivedAddress, WalletUtxo, WatchWallet } from '@app/watch/watch.types';

/**
 * mempool.space mainnet sets MAX_TRACKED_ADDRESSES to 10, and a websocket request over the
 * cap is not trimmed: the backend tracks nothing for that connection and replies with
 * `track-addresses-error`. A descriptor wallet has 40 or more addresses and an address list
 * up to 1,000, so subscribe to the ten that matter most and let the per-block refresh catch
 * the rest. The real cap is not exposed to the frontend, so stay at the mainnet value and
 * fall back to polling if refused anyway.
 */
const MAX_TRACKED = 10;

/** How many not-yet-used receive addresses to watch for incoming payments. */
export const WATCH_UNUSED_RECEIVE = 3;

/** What the websocket reported for the tracked addresses in one message. */
export interface LiveUpdate {
  /** New mempool transactions and newly confirmed ones. */
  added: Transaction[];
  /** Transactions that left the mempool: replaced, evicted or expired. */
  removed: Transaction[];
}

/** What changed on the chain: a new tip (a new block, or a reorg), or a websocket reconnect. */
export type ChainChange = 'tip' | 'reconnect';

export interface TrackingCallbacks {
  onUpdate: (update: LiveUpdate) => void;
  /** The server refused the subscription; only the per-block refresh remains. */
  onDegraded: () => void;
}

/**
 * The page's link to the websocket: live address tracking for the wallet on screen, and
 * chain changes (a new tip, a reorg, a reconnect) that call for a refresh.
 *
 * The two are separate on purpose. Address tracking follows the wallet shown and restarts
 * whenever the tracked set changes; chain watching runs for the whole page, scans included,
 * so a block found during a scan is not missed.
 */
@Injectable()
export class WalletTrackerService implements OnDestroy {
  private subscription = new Subscription();
  private chainSubscription = new Subscription();
  private tracking = false;
  /** The newest blocks the page holds, newest first; empty until the current network's first blocks arrive. */
  private blocks: BlockExtended[] = [];

  constructor(
    private websocketService: WebsocketService,
    private stateService: StateService,
  ) {}

  /**
   * Choose at most MAX_TRACKED addresses that need to be live. A wallet that small (a short
   * address list) is tracked whole. Otherwise:
   *   - the next few unused receive addresses, so an incoming payment shows at once
   *   - the highest-value funded addresses, so our coins being spent shows at once
   * Events on any other address arrive with the next block instead.
   */
  selectTracked(wallet: WatchWallet, utxos: WalletUtxo[], upcomingReceive: DerivedAddress[]): string[] {
    if (wallet.addresses.length <= MAX_TRACKED) {
      return wallet.addresses.map((a) => a.address);
    }
    const selected = upcomingReceive.slice(0, WATCH_UNUSED_RECEIVE).map((a) => a.address);

    const byValue = new Map<string, number>();
    for (const utxo of utxos) {
      byValue.set(utxo.address, (byValue.get(utxo.address) || 0) + utxo.value);
    }
    const funded = [...byValue.entries()].sort((a, b) => b[1] - a[1]).map(([address]) => address);
    for (const address of funded) {
      if (selected.length >= MAX_TRACKED) {
        break;
      }
      if (!selected.includes(address)) {
        selected.push(address);
      }
    }
    return selected;
  }

  start(wallet: WatchWallet, utxos: WalletUtxo[], upcomingReceive: DerivedAddress[], callbacks: TrackingCallbacks): void {
    this.stop();

    const tracked = this.selectTracked(wallet, utxos, upcomingReceive);
    if (tracked.length) {
      this.tracking = true;
      this.websocketService.startTrackAddresses(tracked);
      this.subscription.add(this.stateService.trackAddressesError$.subscribe(() => {
        this.tracking = false;
        callbacks.onDegraded();
      }));

      const mine = new Set(wallet.addresses.map((a) => a.address));
      this.subscription.add(this.stateService.multiAddressTransactions$.subscribe((message) => {
        const update: LiveUpdate = { added: [], removed: [] };
        for (const address of Object.keys(message)) {
          if (mine.has(address)) {
            const { mempool, confirmed, removed } = message[address];
            update.added.push(...(mempool || []), ...(confirmed || []));
            update.removed.push(...(removed || []));
          }
        }
        if (update.added.length || update.removed.length) {
          callbacks.onUpdate(update);
        }
      }));
    }
  }

  /** Stop tracking addresses. Chain watching carries on. */
  stop(): void {
    if (this.tracking) {
      this.websocketService.stopTrackingAddresses();
      this.tracking = false;
    }
    this.subscription.unsubscribe();
    this.subscription = new Subscription();
  }

  /**
   * Call `onChange` whenever the chain tip changes (a new block, or a different block at the
   * same height after a reorg) and whenever the websocket reconnects, since anything could
   * have happened while it was down.
   */
  watchChain(onChange: (change: ChainChange) => void): void {
    this.chainSubscription.unsubscribe();
    this.chainSubscription = new Subscription();

    // blocks$ replays the current blocks on subscribe; the first emission only sets the baseline.
    this.chainSubscription.add(this.stateService.blocks$.subscribe((blocks) => {
      const before = this.chainTip();
      this.blocks = [...blocks].sort((a, b) => b.height - a.height);
      const after = this.chainTip();
      if (before && after && (before.height !== after.height || before.hash !== after.hash)) {
        onChange('tip');
      }
    }));

    let connected = this.stateService.connectionState$.value === 2;
    this.chainSubscription.add(this.stateService.connectionState$.subscribe((state) => {
      if (state === 2 && !connected) {
        onChange('reconnect');
      }
      connected = state === 2;
    }));
  }

  /** The newest block the page knows of, or null before the first blocks arrive. */
  private chainTip(): ChainTip | null {
    const top = this.blocks[0];
    return top ? { height: top.height, hash: top.id } : null;
  }

  /**
   * Forget the chain after a network change: the next blocks to arrive are the new network's
   * and set a new baseline rather than counting as a change.
   */
  resetChain(): void {
    this.blocks = [];
  }

  ngOnDestroy(): void {
    this.stop();
    this.chainSubscription.unsubscribe();
  }
}
