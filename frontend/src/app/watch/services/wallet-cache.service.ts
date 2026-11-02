import { Injectable } from '@angular/core';
import { Transaction } from '@interfaces/electrs.interface';
import { ChainTip } from '@app/watch/watch.types';

const DB_NAME = 'mempool-wallet';
const DB_VERSION = 1;
const STORE = 'scans';
/** Bump when the shape of a cached scan changes; records with another schema are ignored and replaced. */
const SCHEMA = 1;
/** Give up on the cache rather than hold the page if the browser never answers the open request. */
const OPEN_TIMEOUT_MS = 3000;

/** A wallet's last scanned history, with the per-block refreshes and live updates since applied. */
export interface CachedScan {
  walletId: string;
  /** Unix time of the scan, in seconds. */
  updatedAt: number;
  truncated: boolean;
  transactions: Transaction[];
  /**
   * The server tip `transactions` are complete up to (WalletScanResult.syncedTip), so the next
   * block's refresh need only read what is newer. Absent when unknown; the next refresh is then
   * a full scan.
   */
  syncedTip?: ChainTip;
}

interface ScanRecord extends CachedScan {
  schema: number;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * True if `tx` has the parts the wallet's views are computed from: its id, its inputs'
 * outpoints and prevouts, its outputs' values and addresses, and its confirmation status.
 * A cached scan is only a convenience, so one that fails this is ignored and rescanned.
 */
function isCachedTransaction(tx: unknown): tx is Transaction {
  if (!isObject(tx) || typeof tx.txid !== 'string' || !Array.isArray(tx.vin) || !Array.isArray(tx.vout) || !isObject(tx.status)) {
    return false;
  }
  const status = tx.status;
  if (typeof status.confirmed !== 'boolean' || (status.confirmed && typeof status.block_height !== 'number')) {
    return false;
  }
  const isPrevout = (prevout: unknown): boolean => prevout === null || prevout === undefined || isOutput(prevout);
  return tx.vin.every((vin: unknown) => isObject(vin) && typeof vin.txid === 'string' && typeof vin.vout === 'number' && isPrevout(vin.prevout))
    && tx.vout.every(isOutput);
}

function isChainTip(tip: unknown): tip is ChainTip {
  return isObject(tip) && Number.isInteger(tip.height) && (tip.height as number) >= 0 && typeof tip.hash === 'string';
}

function isOutput(output: unknown): boolean {
  return isObject(output)
    && typeof output.value === 'number'
    && (output.scriptpubkey_address === undefined || typeof output.scriptpubkey_address === 'string');
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void => reject(request.error);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = (): void => resolve();
    tx.onerror = (): void => reject(tx.error);
    tx.onabort = (): void => reject(tx.error);
  });
}

/**
 * The last scan of each wallet, so reopening the page shows it at once instead of waiting
 * for a rescan.
 *
 * IndexedDB rather than localStorage: a wallet's history can run to thousands of full
 * transactions, several megabytes, which would exhaust localStorage's ~5 MB per origin and
 * block the page on every synchronous read. Wallet definitions stay in localStorage
 * (WalletStorageService); this store holds only what a rescan can rebuild, keyed by
 * wallet id, so losing it costs one scan and nothing else.
 *
 * Every method fails soft: where IndexedDB is missing, refused (some private windows) or
 * full, reads return null and writes do nothing, and the page simply scans as before.
 *
 * Like the wallet definitions, the cached history is stored unencrypted in this browser.
 */
@Injectable()
export class WalletCacheService {
  private db: Promise<IDBDatabase | null> | null = null;

  async get(walletId: string): Promise<CachedScan | null> {
    const db = await this.open();
    if (!db) {
      return null;
    }
    try {
      const record = await requestResult<ScanRecord | undefined>(
        db.transaction(STORE, 'readonly').objectStore(STORE).get(walletId),
      );
      if (
        !isObject(record) || record.schema !== SCHEMA || typeof record.updatedAt !== 'number'
        || !Array.isArray(record.transactions) || !record.transactions.every(isCachedTransaction)
      ) {
        return null;
      }
      const { walletId: id, updatedAt, truncated, transactions, syncedTip } = record as ScanRecord;
      return { walletId: id, updatedAt, truncated: !!truncated, transactions, ...(isChainTip(syncedTip) ? { syncedTip } : {}) };
    } catch {
      return null;
    }
  }

  async put(scan: CachedScan): Promise<void> {
    const record: ScanRecord = { ...scan, schema: SCHEMA };
    await this.write((store) => store.put(record));
  }

  async delete(walletId: string): Promise<void> {
    await this.write((store) => store.delete(walletId));
  }

  private async write(change: (store: IDBObjectStore) => void): Promise<void> {
    const db = await this.open();
    if (!db) {
      return;
    }
    try {
      const tx = db.transaction(STORE, 'readwrite');
      change(tx.objectStore(STORE));
      await transactionDone(tx);
    } catch {
      // Most likely QuotaExceededError. The cache is optional: the next visit rescans.
    }
  }

  private open(): Promise<IDBDatabase | null> {
    if (!this.db) {
      this.db = new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(null), OPEN_TIMEOUT_MS);
        const done = (db: IDBDatabase | null): void => {
          clearTimeout(timeout);
          resolve(db);
        };
        try {
          if (typeof indexedDB === 'undefined') {
            done(null);
            return;
          }
          const request = indexedDB.open(DB_NAME, DB_VERSION);
          request.onupgradeneeded = (): void => {
            if (!request.result.objectStoreNames.contains(STORE)) {
              request.result.createObjectStore(STORE, { keyPath: 'walletId' });
            }
          };
          request.onsuccess = (): void => {
            const db = request.result;
            // Let a newer version of the page in another tab upgrade the database.
            db.onversionchange = (): void => {
              db.close();
              this.db = null;
            };
            done(db);
          };
          request.onerror = (): void => done(null);
          request.onblocked = (): void => done(null);
        } catch {
          done(null);
        }
      });
    }
    return this.db;
  }
}
