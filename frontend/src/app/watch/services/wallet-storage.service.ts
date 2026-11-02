import { Injectable } from '@angular/core';
import { StorageService } from '@app/services/storage.service';
import { WatchNetwork, WatchWallet } from '@app/watch/watch.types';

const STORAGE_KEY = 'watch-wallets';
/** Prefix of the key an unreadable saved list is copied to, followed by the time it was found. */
export const BACKUP_KEY_PREFIX = 'watch-wallets-unreadable-';

/** A write to local storage did not take, e.g. because the browser's storage quota is used up. */
export class WalletStorageError extends Error {
  constructor() {
    super('Saving to local storage failed');
  }
}

/** Why some saved wallets could not be read. */
export type StorageProblem =
  /** The saved list could not be parsed. A copy of it is kept under a backup key. */
  | 'list-copied'
  /** The saved list could not be parsed and no copy could be made, e.g. because storage is full. It is left as it is. */
  | 'list-not-copied'
  /** Some saved records are corrupt or from a newer version. They are left in the list as they are. */
  | 'records';

/**
 * The networks a saved record may name. 'testnet4' is accepted too: some saved wallets name
 * it, and they stay in the list untouched rather than being reported as unreadable. The
 * wallet does not run on testnet4, so they are never loaded.
 */
const NETWORKS: readonly unknown[] = [...(['mainnet', 'testnet', 'signet'] satisfies WatchNetwork[]), 'testnet4'];

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;
const isOptional = (value: unknown, check: (v: unknown) => boolean): boolean => value === undefined || check(value);
const isString = (value: unknown): value is string => typeof value === 'string';

function isAddress(address: unknown): boolean {
  return isObject(address)
    && isString(address.address) && address.address !== ''
    && (address.chain === 0 || address.chain === 1)
    && isCount(address.index)
    && isOptional(address.scriptPubKey, isString);
}

/** The fields every scanned wallet has, whichever kind it is. */
function hasWalletFields(record: Record<string, unknown>): boolean {
  return isString(record.id) && record.id !== ''
    && isString(record.label)
    && NETWORKS.includes(record.network)
    && isObject(record.derivedCount) && isCount(record.derivedCount[0]) && isCount(record.derivedCount[1])
    && Array.isArray(record.addresses) && record.addresses.every(isAddress);
}

/**
 * A saved record as this version understands it, or null. A record with no `kind` is a
 * descriptor wallet, since some saved wallets lack the field. A record missing a field the
 * scanner and views rely on is not a wallet: it would fail every scan, and with no view the
 * user could not reach Settings to forget it.
 */
function readRecord(record: unknown): WatchWallet | null {
  if (!isObject(record) || !hasWalletFields(record)) {
    return null;
  }
  if (record.kind === 'address-list') {
    return record as unknown as WatchWallet;
  }
  if (
    (record.kind === undefined || record.kind === 'descriptor')
    && isString(record.descriptor) && record.descriptor !== ''
    && isString(record.source)
    && isString(record.scriptType)
    && Number.isInteger(record.gapLimit) && (record.gapLimit as number) > 0
    && isOptional(record.receiveIndex, isCount)
    && isOptional(record.fingerprint, isString)
    && isOptional(record.originPath, isString)
    && isOptional(record.fingerprintIsMaster, (v) => typeof v === 'boolean')
  ) {
    return { ...record, kind: 'descriptor' } as unknown as WatchWallet;
  }
  return null;
}

/**
 * Persistence for watch-only wallets, in this browser's local storage only.
 *
 * Accepted risk: for a descriptor wallet this stores the pasted extended key
 * (`wallet.source`) in plaintext, so the gap limit can extend as the wallet receives
 * without asking for the key again. Script
 * running on this origin (an XSS, a compromised dependency, a malicious extension) could
 * read it and learn every address the wallet will ever use. Every read and write goes
 * through this class so that policy can be changed in one place: to drop the key, derive a
 * generous look-ahead, strip `source` before saving, and ask for the key again when the
 * look-ahead runs out.
 *
 * Nothing saved is dropped silently. A record this version cannot read (corrupt, or written
 * by a newer version) stays in the list untouched, and `unreadable` says so. A list that cannot be parsed at all is
 * copied to a backup key before anything can overwrite it, and is overwritten only once
 * that copy is known to exist; at most one backup is kept, and it is never replaced.
 *
 * StorageService.setValue swallows errors such as a full quota, so every write is read back
 * to confirm it took; one that did not throws WalletStorageError.
 */
@Injectable()
export class WalletStorageService {
  /** Set once the saved list is found unparsable, and kept: the backup it names stays too. */
  private listProblem: 'list-copied' | 'list-not-copied' | null = null;
  /** The last read found records this version cannot read. */
  private recordsUnreadable = false;

  constructor(private storageService: StorageService) {}

  /** What the user should be told about saved wallets that could not be read, or null. */
  get unreadable(): StorageProblem | null {
    return this.listProblem ?? (this.recordsUnreadable ? 'records' : null);
  }

  /** Wallets saved for one network, in the order they were added. */
  load(network: WatchNetwork): WatchWallet[] {
    return this.readRecords().records
      .map(readRecord)
      .filter((w): w is WatchWallet => w !== null && w.network === network);
  }

  /** Throws WalletStorageError if the wallet could not be saved. */
  save(wallet: WatchWallet): void {
    const records = this.writableRecords();
    const index = records.findIndex((r) => readRecord(r)?.id === wallet.id);
    if (index >= 0) {
      records[index] = wallet;
    } else {
      records.push(wallet);
    }
    this.persist(records);
  }

  /**
   * Put `wallet` where the wallet `oldId` was, e.g. after re-importing it under another script
   * type. Throws WalletStorageError if that could not be saved.
   */
  replace(oldId: string, wallet: WatchWallet): void {
    const records = this.writableRecords().filter((r) => readRecord(r)?.id !== wallet.id);
    const index = records.findIndex((r) => readRecord(r)?.id === oldId);
    if (index >= 0) {
      records[index] = wallet;
    } else {
      records.push(wallet);
    }
    this.persist(records);
  }

  /** Throws WalletStorageError if the wallet could not be removed. */
  remove(id: string): void {
    this.persist(this.writableRecords().filter((r) => readRecord(r)?.id !== id));
  }

  /**
   * The saved records exactly as stored, readable or not. An unparsable list reads as empty,
   * and `preserved` says whether a copy of it is safely kept, so that it may be overwritten.
   */
  private readRecords(): { records: unknown[]; preserved: boolean } {
    const raw = this.storageService.getValue(STORAGE_KEY);
    if (!raw) {
      this.recordsUnreadable = false;
      return { records: [], preserved: true };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (Array.isArray(parsed)) {
      this.recordsUnreadable = parsed.some((record) => readRecord(record) === null);
      return { records: parsed, preserved: true };
    }
    const preserved = this.backUp(raw);
    this.listProblem = preserved ? 'list-copied' : 'list-not-copied';
    return { records: [], preserved };
  }

  /** The records to change and write back; throws rather than overwrite an unreadable list that has no copy. */
  private writableRecords(): unknown[] {
    const { records, preserved } = this.readRecords();
    if (!preserved) {
      throw new WalletStorageError();
    }
    return records;
  }

  /** Copy an unreadable saved list to a backup key. True once a copy of exactly `raw` exists. */
  private backUp(raw: string): boolean {
    const existing = this.backupKeys();
    if (existing.some((key) => this.storageService.getValue(key) === raw)) {
      return true;
    }
    if (existing.length) {
      // Keep at most one backup, and never replace it: it may be the only copy of older wallets.
      return false;
    }
    const key = `${BACKUP_KEY_PREFIX}${Date.now()}`;
    this.storageService.setValue(key, raw);
    return this.storageService.getValue(key) === raw;
  }

  private backupKeys(): string[] {
    const keys: string[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(BACKUP_KEY_PREFIX)) {
          keys.push(key);
        }
      }
    } catch {
      // Storage unavailable: there is nothing to find, and the backup write will fail too.
    }
    return keys;
  }

  private persist(records: unknown[]): void {
    const json = JSON.stringify(records);
    this.storageService.setValue(STORAGE_KEY, json);
    if (this.storageService.getValue(STORAGE_KEY) !== json) {
      throw new WalletStorageError();
    }
  }
}
