/**
 * Pure wallet computation: UTXO set, balance, net-value-per-tx, gap-limit bookkeeping.
 *
 * Deliberately free of Angular so it can be exercised directly against real chain data
 * (see the harness in the watch spec). Every number the user sees comes from here, so it
 * is the part most worth being able to test in isolation.
 *
 * Note the UTXO set is *derived*, not fetched. There is no batch UTXO endpoint, and asking
 * per-address would be one request per address — but the full transaction history already
 * says which of our outputs were never spent.
 */

import { Transaction } from '@interfaces/electrs.interface';
import { Chain, DerivedAddress, WalletBalance, WalletTx, WalletUtxo } from './watch.types';

export type AddressMap = Map<string, DerivedAddress>;

/**
 * Correct regardless of the order transactions arrive in: collect every output paying us,
 * separately collect every outpoint our inputs spend, then subtract.
 */
export function computeUtxos(txs: Transaction[], addressMap: AddressMap): WalletUtxo[] {
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

export function computeWalletTxs(txs: Transaction[], addressMap: AddressMap): WalletTx[] {
  return txs.map((tx) => ({
    txid: tx.txid,
    netValue: netValue(tx, addressMap),
    confirmed: !!tx.status?.confirmed,
    blockHeight: tx.status?.block_height,
    blockTime: tx.status?.block_time,
  }));
}

export function computeBalance(txs: Transaction[], addressMap: AddressMap): WalletBalance {
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
export function computeLastUsed(txs: Transaction[], addressMap: AddressMap): Record<Chain, number> {
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
