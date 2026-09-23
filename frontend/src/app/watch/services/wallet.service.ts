import { Injectable } from '@angular/core';
import { AddressTxSummary, Transaction, Utxo } from '@interfaces/electrs.interface';
import { BehaviorSubject, Observable } from 'rxjs';
import * as walletMath from '../wallet-math';
import { describeScriptType } from '../watch-key.utils';
import { Chain, DerivedAddress, WalletBalance, WalletUtxo, WatchNetwork, WatchWallet } from '../watch.types';
import { WalletLabelsService, WalletStorageService } from './wallet-storage.service';

/**
 * Root-level wallet state.
 *
 * This is the seam that keeps the WASM off the hot path. It holds the wallets and their derived
 * *address strings* — so the transaction page,
 * block list, address page and nav badge can all answer "is this mine?" with a Map lookup,
 * without ever loading the 8.5 MB derivation engine. Only the lazy /watch module derives.
 *
 * It is provided in root (not in the lazy module) precisely so those pages can inject it.
 * All arithmetic lives in ../wallet-math so it can be tested against real chain data.
 */
@Injectable({ providedIn: 'root' })
export class WalletService {
  /** address -> derivation info. Empty when no wallet is loaded, which is the common case. */
  private addressMap: walletMath.AddressMap = new Map<string, DerivedAddress>();

  /**
   * The site-wide union: every address of EVERY loaded wallet, mapped to its derivation info
   * and the id of the wallet that owns it. This is what makes "is this output mine?"
   * highlighting on the transaction/address/block pages recognise ALL of a user's wallets,
   * not just whichever one the /watch page is currently showing.
   */
  private mergedMap = new Map<string, { derived: DerivedAddress; walletId: string }>();
  private walletsById = new Map<string, WatchWallet>();

  private activeWallet: WatchWallet | null = null;
  private wallets$ = new BehaviorSubject<WatchWallet[]>([]);
  private restoredNetwork: WatchNetwork | null = null;

  constructor(
    private storage: WalletStorageService,
    private labels: WalletLabelsService,
  ) {}

  /**
   * Rehydrate every saved wallet's address set from localStorage — no WASM, just a JSON parse
   * and Map fills. Cheap enough to call from any page (the nav does, on load). Populates the
   * merged map for site-wide highlighting; does not need the /watch page to be open.
   */
  restore(network: WatchNetwork): void {
    if (this.restoredNetwork === network && this.walletsById.size) {
      return;
    }
    this.restoredNetwork = network;
    const wallets = this.storage.load(network);
    this.syncWallets(wallets);
    // Seed an active wallet so the /watch page's per-wallet views have one to start from, and
    // explicitly clear the previous network when this network has no saved wallets.
    this.setActive(wallets[0] ?? null);
  }

  /** Replace the full set of loaded wallets and rebuild the merged highlighting map. */
  syncWallets(wallets: WatchWallet[]): void {
    this.walletsById = new Map(wallets.map((w) => [w.id, w]));
    this.mergedMap.clear();
    for (const wallet of wallets) {
      for (const addr of wallet.addresses) {
        // First writer wins on a shared address — harmless, both wallets own it.
        if (!this.mergedMap.has(addr.address)) {
          this.mergedMap.set(addr.address, { derived: addr, walletId: wallet.id });
        }
      }
    }
    this.wallets$.next(wallets);
    // If the active wallet was removed, drop it.
    const active = this.activeWallet;
    if (active && !this.walletsById.has(active.id)) {
      this.setActive(null);
    }
  }

  /** The wallet whose per-wallet views (balance/UTXOs/history) the /watch page is showing. */
  setActive(wallet: WatchWallet | null): void {
    this.addressMap.clear();
    if (wallet) {
      for (const addr of wallet.addresses) {
        this.addressMap.set(addr.address, addr);
      }
    }
    this.activeWallet = wallet;
  }

  getWallets$(): Observable<WatchWallet[]> {
    return this.wallets$.asObservable();
  }

  /** True when ANY wallet is loaded. Guard every highlighting hot path on this first. */
  get hasWallet(): boolean {
    return this.mergedMap.size > 0;
  }

  /** The whole point of the root service: O(1), no WASM, safe to call per-output. Matches
   *  against every loaded wallet. */
  isMine(address: string | undefined | null): boolean {
    return !!address && this.mergedMap.has(address);
  }

  /** Derivation info for one of our addresses, e.g. to render "0/7". */
  lookup(address: string): DerivedAddress | undefined {
    return this.mergedMap.get(address)?.derived;
  }

  /** Address label from the wallet that owns it, used by site-wide wallet markers. */
  addressLabel(address: string): string {
    const entry = this.mergedMap.get(address);
    const wallet = entry ? this.walletsById.get(entry.walletId) : undefined;
    return wallet ? this.labels.get(wallet, 'addr', address) : '';
  }

  /**
   * Full derivation path for one of our addresses, e.g. "m/84'/0'/0'/0/7".
   *
   * Uses the owning wallet's real account path when a descriptor's key origin gave us one,
   * and otherwise the BIP-standard path for the script type. Falls back to just
   * "chain/index" for script descriptors that have no single standard path.
   */
  derivationPath(address: string): string | null {
    const entry = this.mergedMap.get(address);
    if (!entry) {
      return null;
    }
    const wallet = this.walletsById.get(entry.walletId);
    if (!wallet) {
      return null;
    }
    const account = wallet.originPath ?? describeScriptType(wallet.scriptType).path;
    const { chain, index } = entry.derived;
    return account ? `${account}/${chain}/${index}` : `${chain}/${index}`;
  }

  // ── derived views, all delegating to the pure, independently-tested math module ──

  netValue(tx: Transaction): number {
    return walletMath.netValue(tx, this.addressMap);
  }

  /**
   * One summary per confirmed transaction, its value being the net effect on the wallet — what
   * the balance-history chart consumes, newest-first. Computed against a specific address map so
   * it works both for the active wallet and for aggregating a set of them.
   */
  private summaryFor(txs: Transaction[], map: walletMath.AddressMap): AddressTxSummary[] {
    return txs
      .filter((tx) => tx.status?.confirmed)
      .map((tx) => ({
        txid: tx.txid,
        value: walletMath.netValue(tx, map),
        height: tx.status.block_height,
        time: tx.status.block_time,
      }))
      .sort((a, b) => b.height - a.height);
  }

  /**
   * Everything the /watch dashboard derives for one wallet — utxos, balance, last-used index,
   * and the balance-history summary — computed from that wallet's OWN addresses rather than the
   * currently-active map. This is the single builder the page uses, so a wallet computes the
   * same way whether it is the one on screen or one folded into the "All wallets" total.
   */
  buildView(wallet: WatchWallet, txs: Transaction[]): {
    utxos: WalletUtxo[];
    balance: WalletBalance;
    lastUsed: Record<Chain, number>;
    summary: AddressTxSummary[];
  } {
    const map: walletMath.AddressMap = new Map(wallet.addresses.map((a) => [a.address, a]));
    const utxos = walletMath.computeUtxos(txs, map);
    return {
      utxos,
      balance: walletMath.computeBalance(txs, map),
      lastUsed: walletMath.computeLastUsed(txs, map),
      summary: this.summaryFor(txs, map),
    };
  }

  /** Build the aggregate exactly once against the union of all wallet addresses. This avoids
   * double-counting when two imported descriptors overlap or a transaction moves funds between
   * two of the user's wallets. */
  buildAggregateView(wallets: WatchWallet[], txs: Transaction[]): {
    utxos: WalletUtxo[];
    balance: WalletBalance;
    summary: AddressTxSummary[];
  } {
    const map: walletMath.AddressMap = new Map();
    for (const wallet of wallets) {
      for (const address of wallet.addresses) {
        if (!map.has(address.address)) map.set(address.address, address);
      }
    }
    return {
      utxos: walletMath.computeUtxos(txs, map),
      balance: walletMath.computeBalance(txs, map),
      summary: this.summaryFor(txs, map),
    };
  }

  /**
   * Reshape a wallet's UTXOs into the {@link Utxo} form <app-utxo-graph> consumes — the one
   * place that conversion happens, so every wallet renders the same bubble graph.
   *
   * The graph colours each output by age, which needs a block time. Where we have the funding
   * transaction we take the exact status from it. Otherwise we synthesise a status and estimate
   * the block time from the output's height against the chain tip. An output with neither a tx
   * nor a height keeps an undefined block time; UtxoGraphComponent treats that as unknown age.
   */
  utxosForGraph(utxos: WalletUtxo[], txs: Transaction[], tipHeight: number): Utxo[] {
    const statusByTxid = new Map(txs.map((tx) => [tx.txid, tx.status]));
    const now = Math.floor(Date.now() / 1000);
    return utxos.map((u) => {
      const txStatus = statusByTxid.get(u.txid);
      if (txStatus) {
        // Clone: the graph mutates status (toggles an `accelerated` flag) and must not write
        // back into the shared Transaction objects.
        return { txid: u.txid, vout: u.vout, value: u.value, status: { ...txStatus } };
      }
      const blockTime = (u.confirmed && u.blockHeight && tipHeight)
        ? now - Math.max(0, tipHeight - u.blockHeight) * 600
        : undefined;
      return {
        txid: u.txid,
        vout: u.vout,
        value: u.value,
        status: { confirmed: u.confirmed, block_height: u.blockHeight, block_time: blockTime },
      };
    });
  }
}
