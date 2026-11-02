/**
 * Pure wallet computation: UTXO set, balance, net-value-per-tx, gap-limit bookkeeping.
 *
 * Deliberately free of Angular so it can be exercised directly against real chain data.
 * Every number the user sees comes from here.
 *
 * Note the UTXO set is *derived*, not fetched. There is no batch UTXO endpoint, and asking
 * per-address would be one request per address — but the full transaction history already
 * says which of our outputs were never spent.
 */

import { AddressTxSummary, Transaction } from '@interfaces/electrs.interface';
import { describeScriptType } from '@app/watch/watch-key.utils';
import { Chain, DerivedAddress, DescriptorWallet, WalletBalance, WalletUtxo, WatchWallet } from '@app/watch/watch.types';

export type AddressMap = Map<string, DerivedAddress>;

export function addressMapOf(wallet: WatchWallet): AddressMap {
  return new Map(wallet.addresses.map((a) => [a.address, a]));
}

/** Unconfirmed transactions first, then confirmed ones from the newest block down. */
export function sortNewestFirst(txs: Transaction[]): Transaction[] {
  const height = (tx: Transaction): number => (tx.status?.confirmed ? tx.status.block_height : Number.MAX_SAFE_INTEGER);
  return [...txs].sort((a, b) => height(b) - height(a));
}

/**
 * Apply one live websocket update to a wallet's transaction history.
 *
 * `removed` are transactions that left the mempool (replaced, evicted or expired); `added`
 * are new or newly confirmed ones. An unconfirmed transaction spending an outpoint that an
 * added one also spends lost the race and goes too, as does any unconfirmed transaction
 * spending an output of one that went: neither can confirm now. Confirmed history is never
 * removed here; the next full scan is authoritative for it.
 *
 * Returns the new history, newest first, or null when the update changes nothing.
 */
export function applyLiveUpdate(txs: Transaction[], added: Transaction[], removed: Transaction[]): Transaction[] | null {
  const byId = new Map(txs.map((tx) => [tx.txid, tx]));
  const gone = new Set<string>();
  const drop = (txid: string): void => {
    const tx = byId.get(txid);
    if (tx && !tx.status?.confirmed) {
      byId.delete(txid);
      gone.add(txid);
    }
  };
  const outpoints = (tx: Transaction): string[] => (tx.vin || []).map((vin) => `${vin.txid}:${vin.vout}`);

  const arriving = new Set(added.map((tx) => tx.txid));
  for (const tx of removed) {
    if (!arriving.has(tx.txid)) {
      drop(tx.txid);
    }
  }

  let changed = gone.size > 0;
  for (const tx of added) {
    const existing = byId.get(tx.txid);
    // A transaction we already have can still change: it confirms.
    if (existing && (existing.status?.confirmed || !tx.status?.confirmed)) {
      continue;
    }
    const spends = new Set(outpoints(tx));
    for (const other of [...byId.values()]) {
      if (other.txid !== tx.txid && outpoints(other).some((outpoint) => spends.has(outpoint))) {
        drop(other.txid);
      }
    }
    byId.set(tx.txid, tx);
    changed = true;
  }

  // Descendants of anything dropped, to any depth.
  for (let grew = gone.size > 0; grew;) {
    grew = false;
    for (const tx of [...byId.values()]) {
      if (!tx.status?.confirmed && (tx.vin || []).some((vin) => gone.has(vin.txid))) {
        drop(tx.txid);
        grew = true;
      }
    }
  }

  return changed ? sortNewestFirst([...byId.values()]) : null;
}

/**
 * Correct regardless of the order transactions arrive in: collect every output paying us,
 * separately collect every outpoint our inputs spend, then subtract.
 */
function computeUtxos(txs: Transaction[], addressMap: AddressMap): WalletUtxo[] {
  const outputs = new Map<string, WalletUtxo>();
  const spent = new Set<string>();

  for (const tx of txs) {
    for (const vin of tx.vin || []) {
      // The outpoint is authoritative. Electrs can omit prevout metadata from an input, but
      // that must never resurrect an output we already know belongs to this wallet.
      spent.add(`${vin.txid}:${vin.vout}`);
    }
    (tx.vout || []).forEach((vout, index) => {
      const addr = vout.scriptpubkey_address;
      if (addr && addressMap.has(addr)) {
        outputs.set(`${tx.txid}:${index}`, {
          txid: tx.txid,
          vout: index,
          value: vout.value,
          address: addr,
          confirmed: !!tx.status?.confirmed,
          blockHeight: tx.status?.block_height,
        });
      }
    });
  }

  const utxos: WalletUtxo[] = [];
  for (const [outpoint, utxo] of outputs) {
    if (!spent.has(outpoint)) {
      utxos.push(utxo);
    }
  }
  return utxos.sort((a, b) => (b.blockHeight ?? Infinity) - (a.blockHeight ?? Infinity));
}

/**
 * Net effect of one transaction on the wallet, in sats.
 * Positive = received. Negative = sent — and the fee falls out naturally, since it is the
 * difference between the inputs we funded and the outputs we got back.
 */
export function netValue(tx: Transaction, addressMap: AddressMap): number {
  let received = 0;
  let sent = 0;
  for (const vin of tx.vin || []) {
    const addr = vin.prevout?.scriptpubkey_address;
    if (addr && addressMap.has(addr)) {
      sent += vin.prevout.value || 0;
    }
  }
  for (const vout of tx.vout || []) {
    const addr = vout.scriptpubkey_address;
    if (addr && addressMap.has(addr)) {
      received += vout.value || 0;
    }
  }
  return received - sent;
}

function computeBalance(txs: Transaction[], addressMap: AddressMap): WalletBalance {
  // Confirmed balance is the chain-tip UTXO set before mempool transactions are applied. The
  // final UTXO set cannot be used here: computeUtxos correctly removes a confirmed coin as soon
  // as an unconfirmed transaction spends it, and adding that transaction's negative net value
  // again would count the outgoing payment twice.
  const confirmed = computeUtxos(txs.filter((tx) => tx.status?.confirmed), addressMap)
    .reduce((sum, u) => sum + u.value, 0);

  // Pending is the net effect of everything still in the mempool. It can be negative (an
  // outgoing payment), and must not double-count against the confirmed UTXOs.
  const pending = txs
    .filter((tx) => !tx.status?.confirmed)
    .reduce((sum, tx) => sum + netValue(tx, addressMap), 0);

  return { confirmed, pending, total: confirmed + pending };
}

/** Highest used index per chain, or -1 if that chain has never been used. */
function computeLastUsed(txs: Transaction[], addressMap: AddressMap): Record<Chain, number> {
  const lastUsed: Record<Chain, number> = { 0: -1, 1: -1 };
  const touch = (address: string | undefined): void => {
    if (!address) {
      return;
    }
    const derived = addressMap.get(address);
    if (derived && derived.index > lastUsed[derived.chain]) {
      lastUsed[derived.chain] = derived.index;
    }
  };
  for (const tx of txs) {
    for (const vin of tx.vin || []) {
      touch(vin.prevout?.scriptpubkey_address);
    }
    for (const vout of tx.vout || []) {
      touch(vout.scriptpubkey_address);
    }
  }
  return lastUsed;
}

/** Every address of ours that appears in an input or output of these transactions. */
function computeUsed(txs: Transaction[], addressMap: AddressMap): Set<string> {
  const used = new Set<string>();
  const touch = (address?: string): void => {
    if (address && addressMap.has(address)) {
      used.add(address);
    }
  };
  for (const tx of txs) {
    tx.vin?.forEach((vin) => touch(vin.prevout?.scriptpubkey_address));
    tx.vout?.forEach((vout) => touch(vout.scriptpubkey_address));
  }
  return used;
}

/**
 * One summary per confirmed transaction, valued at its net effect on the wallet, newest
 * first. This is the shape the shared balance-history chart (<app-address-graph>) consumes.
 */
function balanceHistory(txs: Transaction[], addressMap: AddressMap): AddressTxSummary[] {
  return txs
    .filter((tx) => tx.status?.confirmed)
    .map((tx) => ({
      txid: tx.txid,
      value: netValue(tx, addressMap),
      height: tx.status.block_height,
      time: tx.status.block_time,
    }))
    .sort((a, b) => b.height - a.height);
}

/** Everything the wallet views show, computed from the wallet's own addresses. */
export interface WalletView {
  wallet: WatchWallet;
  transactions: Transaction[];
  utxos: WalletUtxo[];
  balance: WalletBalance;
  lastUsed: Record<Chain, number>;
  /** Addresses with any history. */
  used: Set<string>;
  history: AddressTxSummary[];
  /** True when the scan hit its page limit and the history is incomplete. */
  truncated: boolean;
}

export function buildWalletView(wallet: WatchWallet, transactions: Transaction[], truncated: boolean): WalletView {
  const map = addressMapOf(wallet);
  return {
    wallet,
    transactions,
    utxos: computeUtxos(transactions, map),
    balance: computeBalance(transactions, map),
    lastUsed: computeLastUsed(transactions, map),
    used: computeUsed(transactions, map),
    history: balanceHistory(transactions, map),
    truncated,
  };
}

/**
 * The account path: the real one when a descriptor's key origin gave it, otherwise the
 * BIP-standard path for the script type. Multisig descriptors and address lists have none.
 */
export function accountPath(wallet: WatchWallet): string | undefined {
  if (wallet.kind === 'address-list') {
    return undefined;
  }
  if (wallet.originPath) {
    return wallet.originPath;
  }
  const standard = describeScriptType(wallet.scriptType).path;
  // The standard paths are written for mainnet; test networks use coin type 1 (SLIP-44).
  return standard && wallet.network !== 'mainnet' ? standard.replace(/^(m\/\d+')\/0'/, '$1/1\'') : standard;
}

/** Full derivation path of one of the wallet's addresses, e.g. "m/84'/0'/0'/0/7"; empty for an address list. */
export function derivationPath(wallet: WatchWallet, derived: DerivedAddress): string {
  if (wallet.kind === 'address-list') {
    return '';
  }
  const account = accountPath(wallet);
  return account ? `${account}/${derived.chain}/${derived.index}` : `${derived.chain}/${derived.index}`;
}

/** The first receive address at or after both the last used index and the user's cursor. */
export function currentReceiveIndex(wallet: DescriptorWallet, lastUsed: Record<Chain, number>): number {
  return Math.max(lastUsed[0] + 1, wallet.receiveIndex ?? 0);
}

/**
 * The next `count` receive addresses to hand out: from the receive cursor for a descriptor
 * wallet, or the unused listed addresses in list order. Fewer when the wallet runs out.
 */
export function upcomingReceiveAddresses(view: Pick<WalletView, 'wallet' | 'lastUsed' | 'used'>, count: number): DerivedAddress[] {
  const { wallet } = view;
  if (wallet.kind === 'address-list') {
    return wallet.addresses.filter((a) => !view.used.has(a.address)).slice(0, count);
  }
  const from = currentReceiveIndex(wallet, view.lastUsed);
  return wallet.addresses
    .filter((a) => a.chain === 0 && a.index >= from && a.index < from + count)
    .sort((a, b) => a.index - b.index);
}
