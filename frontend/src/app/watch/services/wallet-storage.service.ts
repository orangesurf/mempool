import { Injectable } from '@angular/core';
import { StorageService } from '@app/services/storage.service';
import {
  Bip329Label,
  Bip329LabelType,
  WatchWallet,
  WatchNetwork,
} from '../watch.types';

const STORAGE_KEY = 'watch-wallets';
const LABEL_STORAGE_PREFIX = 'watch-labels-v1';
const LOCAL_STATE_STORAGE_PREFIX = 'watch-local-state-v1';
const LABEL_TYPES = new Set<Bip329LabelType>(['tx', 'addr', 'output']);

interface WalletLocalState {
  frozen: string[];
  receiveIndex?: number;
  changeIndex?: number;
}

function scopedStorageKey(prefix: string, wallet: WatchWallet): string {
  const identity = wallet.descriptor || wallet.source;
  return prefix + ':' + wallet.network + ':'
    + encodeURIComponent(wallet.id) + ':' + encodeURIComponent(identity);
}

/**
 * Persistence for watch-only wallets.
 *
 * ── Accepted risk ────────────────────────────────────────────────────────────────
 * This stores the pasted extended key (`wallet.source`) in plaintext localStorage.
 * That is a deliberate decision, documented in docs/watch-only-wallet-plan.md: it is
 * what allows the gap limit to auto-extend without re-prompting the user.
 *
 * The cost is real and worth naming: an XSS, a compromised dependency, or a malicious
 * browser extension running on the mempool.space origin can read the xpub — the one
 * secret we specifically declined to send to the server — and thereby learn every
 * address the wallet will *ever* use.
 *
 * Every read and write of the key goes through this class precisely so that policy can
 * be changed in one file. The intended stronger policy is: derive with a generous
 * look-ahead, persist only the resulting addresses, and drop `source` — an attacker then
 * learns only addresses the server already saw us query. To switch, strip `source` in
 * `serialize()` and prompt for a re-paste when the look-ahead is exhausted.
 * ─────────────────────────────────────────────────────────────────────────────────
 */
@Injectable({ providedIn: 'root' })
export class WalletStorageService {
  constructor(private storageService: StorageService) {}

  load(network: WatchNetwork): WatchWallet[] {
    const raw = this.storageService.getValue(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    try {
      const all = JSON.parse(raw) as WatchWallet[];
      if (!Array.isArray(all)) {
        return [];
      }
      // Older experimental builds could persist scanner-specific wallets without a usable
      // descriptor. Purge those records, including their xpub/source data, rather than merely
      // hiding them while every later save silently preserves them.
      const valid = all.filter((w) => w && typeof w.descriptor === 'string' && !!w.descriptor.trim());
      if (valid.length !== all.length) this.persist(valid);
      return valid.filter((w) => w.network === network);
    } catch {
      // A corrupt blob should not brick the page. Drop it and start clean.
      return [];
    }
  }

  private loadAll(): WatchWallet[] {
    const raw = this.storageService.getValue(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    try {
      const all = JSON.parse(raw);
      return Array.isArray(all) ? all : [];
    } catch {
      return [];
    }
  }

  save(wallet: WatchWallet): void {
    const all = this.loadAll().filter((w) => w.id !== wallet.id);
    all.push(this.serialize(wallet));
    this.persist(all);
  }

  remove(id: string): void {
    this.persist(this.loadAll().filter((w) => w.id !== id));
  }

  /** Wipe every stored wallet, on every network. Backs the "Forget wallet" control. */
  clear(): void {
    this.storageService.removeItem(STORAGE_KEY);
  }

  /** The single choke point for what actually hits disk. */
  private serialize(wallet: WatchWallet): WatchWallet {
    return wallet;
  }

  private persist(wallets: WatchWallet[]): void {
    this.storageService.setValue(STORAGE_KEY, JSON.stringify(wallets));
  }
}

/** Per-wallet BIP-329 labels. The JSONL interchange itself deliberately carries no wallet id. */
@Injectable({ providedIn: 'root' })
export class WalletLabelsService {
  private cache = new Map<string, Map<string, Bip329Label>>();

  constructor(private storage: StorageService) {}

  get(wallet: WatchWallet, type: Bip329LabelType, ref: string): string {
    return this.load(wallet).get(this.recordKey(type, ref))?.label ?? '';
  }

  set(wallet: WatchWallet, type: Bip329LabelType, ref: string, label: string): void {
    const records = this.load(wallet);
    const key = this.recordKey(type, ref);
    const trimmed = label.trim();
    if (trimmed) {
      records.set(key, { type, ref, label: trimmed });
    } else {
      records.delete(key);
    }
    this.persist(wallet, records);
  }

  merge(wallet: WatchWallet, records: Bip329Label[]): void {
    const merged = this.load(wallet);
    for (const record of records) {
      const key = this.recordKey(record.type, record.ref);
      if (record.label.trim()) {
        merged.set(key, { ...record, label: record.label.trim() });
      } else {
        merged.delete(key);
      }
    }
    this.persist(wallet, merged);
  }

  list(wallet: WatchWallet): Bip329Label[] {
    return [...this.load(wallet).values()].sort((a, b) =>
      a.type.localeCompare(b.type) || a.ref.localeCompare(b.ref),
    );
  }

  clear(wallet: WatchWallet): void {
    const key = scopedStorageKey(LABEL_STORAGE_PREFIX, wallet);
    this.cache.delete(key);
    this.storage.removeItem(key);
  }

  parseJsonl(text: string): Bip329Label[] {
    const lastByRef = new Map<string, Bip329Label>();
    const lines = text.replace(/\r/g, '').split('\n');
    lines.forEach((line, index) => {
      if (!line.trim()) {
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error('Invalid JSON on label line ' + (index + 1) + '.');
      }
      if (!this.isLabel(value)) {
        throw new Error('Invalid BIP-329 label on line ' + (index + 1) + '.');
      }
      lastByRef.set(this.recordKey(value.type, value.ref), {
        type: value.type,
        ref: value.ref,
        label: value.label,
      });
    });
    return [...lastByRef.values()];
  }

  toJsonl(records: Bip329Label[]): string {
    return records.map(({ type, ref, label }) => JSON.stringify({ type, ref, label })).join('\n');
  }

  private isLabel(value: unknown): value is Bip329Label {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const record = value as Partial<Bip329Label>;
    return LABEL_TYPES.has(record.type as Bip329LabelType)
      && typeof record.ref === 'string'
      && record.ref.length > 0
      && typeof record.label === 'string';
  }

  private load(wallet: WatchWallet): Map<string, Bip329Label> {
    const key = scopedStorageKey(LABEL_STORAGE_PREFIX, wallet);
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }

    const records = new Map<string, Bip329Label>();
    const raw = this.storage.getValue(key);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          for (const value of parsed) {
            if (this.isLabel(value)) {
              records.set(this.recordKey(value.type, value.ref), value);
            }
          }
        }
      } catch {
        // A corrupt label blob should not stop the wallet from loading.
      }
    }
    this.cache.set(key, records);
    return records;
  }

  private persist(wallet: WatchWallet, records: Map<string, Bip329Label>): void {
    this.storage.setValue(
      scopedStorageKey(LABEL_STORAGE_PREFIX, wallet),
      JSON.stringify([...records.values()]),
    );
  }

  private recordKey(type: Bip329LabelType, ref: string): string {
    return type + ':' + ref;
  }
}

/** Local-only coin-control and receive preferences, isolated by wallet and network. */
@Injectable({ providedIn: 'root' })
export class WalletLocalStateService {
  private cache = new Map<string, WalletLocalState>();

  constructor(private storage: StorageService) {}

  isFrozen(wallet: WatchWallet, outpoint: string): boolean {
    return this.load(wallet).frozen.includes(outpoint);
  }

  setFrozen(wallet: WatchWallet, outpoint: string, frozen: boolean): void {
    const state = this.load(wallet);
    const outpoints = new Set(state.frozen);
    frozen ? outpoints.add(outpoint) : outpoints.delete(outpoint);
    state.frozen = [...outpoints].sort();
    this.persist(wallet, state);
  }

  getReceiveIndex(wallet: WatchWallet): number | null {
    const value = this.load(wallet).receiveIndex;
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
  }

  setReceiveIndex(wallet: WatchWallet, index: number): void {
    const state = this.load(wallet);
    state.receiveIndex = Math.max(0, Math.floor(index));
    this.persist(wallet, state);
  }

  getChangeIndex(wallet: WatchWallet): number | null {
    const value = this.load(wallet).changeIndex;
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
  }

  setChangeIndex(wallet: WatchWallet, index: number): void {
    const state = this.load(wallet);
    state.changeIndex = Math.max(0, Math.floor(index));
    this.persist(wallet, state);
  }

  clear(wallet: WatchWallet): void {
    const key = scopedStorageKey(LOCAL_STATE_STORAGE_PREFIX, wallet);
    this.cache.delete(key);
    this.storage.removeItem(key);
  }

  private load(wallet: WatchWallet): WalletLocalState {
    const key = scopedStorageKey(LOCAL_STATE_STORAGE_PREFIX, wallet);
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }
    const state = this.read(key);
    this.cache.set(key, state);
    return state;
  }

  private read(key: string): WalletLocalState {
    const raw = this.storage.getValue(key);
    if (!raw) {
      return { frozen: [] };
    }
    try {
      const parsed = JSON.parse(raw) as Partial<WalletLocalState>;
      return {
        frozen: Array.isArray(parsed.frozen)
          ? parsed.frozen.filter((value): value is string => typeof value === 'string')
          : [],
        receiveIndex: parsed.receiveIndex,
        changeIndex: parsed.changeIndex,
      };
    } catch {
      return { frozen: [] };
    }
  }

  private persist(wallet: WatchWallet, state: WalletLocalState): void {
    this.storage.setValue(scopedStorageKey(LOCAL_STATE_STORAGE_PREFIX, wallet), JSON.stringify(state));
  }
}
