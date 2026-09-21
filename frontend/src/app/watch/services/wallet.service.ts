import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { AddressTxSummary, Transaction, Utxo } from '@interfaces/electrs.interface';
import {
  Chain,
  DerivedAddress,
  WalletBalance,
  WalletTx,
  WalletUtxo,
  WatchNetwork,
  WatchWallet,
} from '../watch.types';
import * as walletMath from '../wallet-math';
import { describeScriptType } from '../watch-key.utils';
import { WalletStorageService } from './wallet-storage.service';

/**
 * Root-level wallet state.
 *
 * This is the seam that keeps the WASM off the hot path. It holds nothing but derived
 * *address strings* and the transactions we already fetched — so the transaction page,
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

  private wallet$ = new BehaviorSubject<WatchWallet | null>(null);
  private wallets$ = new BehaviorSubject<WatchWallet[]>([]);
  private transactions$ = new BehaviorSubject<Transaction[]>([]);

  constructor(private storage: WalletStorageService) {}

  /**
   * Rehydrate every saved wallet's address set from localStorage — no WASM, just a JSON parse
   * and Map fills. Cheap enough to call from any page (the nav does, on load). Populates the
   * merged map for site-wide highlighting; does not need the /watch page to be open.
   */
  restore(network: WatchNetwork): void {
    if (this.walletsById.size) {
      return;
    }
    const wallets = this.storage.load(network);
    if (wallets.length) {
      this.syncWallets(wallets);
      // Seed an active wallet so the /watch page's per-wallet views have one to start from.
      this.setActive(wallets[0]);
    }
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
    const active = this.wallet$.value;
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
    } else {
      this.transactions$.next([]);
    }
    this.wallet$.next(wallet);
  }

  /** @deprecated single-wallet shim — kept for callers not yet migrated. */
  setWallet(wallet: WatchWallet | null): void {
    this.setActive(wallet);
  }

  getWallet(): WatchWallet | null {
    return this.wallet$.value;
  }

  getWallet$(): Observable<WatchWallet | null> {
    return this.wallet$.asObservable();
  }

  getWallets$(): Observable<WatchWallet[]> {
    return this.wallets$.asObservable();
  }

  getTransactions$(): Observable<Transaction[]> {
    return this.transactions$.asObservable();
  }

  setTransactions(txs: Transaction[]): void {
    this.transactions$.next(txs);
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

  getAddresses(): string[] {
    return [...this.addressMap.keys()];
  }

  // ── derived views, all delegating to the pure, independently-tested math module ──

  computeUtxos(txs: Transaction[]): WalletUtxo[] {
    return walletMath.computeUtxos(txs, this.addressMap);
  }

  netValue(tx: Transaction): number {
    return walletMath.netValue(tx, this.addressMap);
  }

  computeWalletTxs(txs: Transaction[]): WalletTx[] {
    return walletMath.computeWalletTxs(txs, this.addressMap);
  }

  computeBalance(utxos: WalletUtxo[], txs: Transaction[]): WalletBalance {
    return walletMath.computeBalance(utxos, txs, this.addressMap);
  }

  computeLastUsed(txs: Transaction[]): Record<Chain, number> {
    return walletMath.computeLastUsed(txs, this.addressMap);
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
      balance: walletMath.computeBalance(utxos, txs, map),
      lastUsed: walletMath.computeLastUsed(txs, map),
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
