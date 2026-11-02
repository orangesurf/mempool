import { HttpErrorResponse } from '@angular/common/http';
import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { looksLikeAddressList } from '@app/watch/address-list';
import { applyLiveUpdate, buildWalletView, currentReceiveIndex, upcomingReceiveAddresses, WalletView } from '@app/watch/wallet-math';
import { RetryWait } from '@app/watch/api-retry';
import { scriptTypeName } from '@app/watch/script-type-name';
import { fromMempoolNetwork, isBareExtendedKey } from '@app/watch/watch-key.utils';
import { ChainTip, DescriptorWalletDefinition, ScriptType, WalletDefinition, WatchNetwork, WatchWallet } from '@app/watch/watch.types';
import { DerivationService } from '@app/watch/services/derivation.service';
import { CachedScan, WalletCacheService } from '@app/watch/services/wallet-cache.service';
import { IncrementalScan, ScanIncompleteError, ScanProgress, walletId, WalletScannerService } from '@app/watch/services/wallet-scanner.service';
import { StorageProblem, WalletStorageError, WalletStorageService } from '@app/watch/services/wallet-storage.service';
import { ChainChange, LiveUpdate, WalletTrackerService, WATCH_UNUSED_RECEIVE } from '@app/watch/services/wallet-tracker.service';

export const MIN_GAP_LIMIT = 5;
export const MAX_GAP_LIMIT = 1000;
/** BIP-44's gap limit. Users can change it per wallet in Settings after import. */
export const DEFAULT_GAP_LIMIT = 20;

export interface WalletImportForm {
  /** A descriptor, an extended public key, or a list of addresses. */
  input: string;
  label: string;
  /** Ignored for an address list, which has nothing to derive. */
  gapLimit: number;
  /** Only used for a bare xpub/tpub, which does not say which script type it is. */
  scriptTypeHint?: ScriptType;
  /**
   * For a bare xpub/tpub: look up which script type has history at receive index 0 before
   * scanning, and use `scriptTypeHint` only if none has. False when the user chose the type.
   */
  detectScriptType?: boolean;
}

export interface WalletPageState {
  /** The page's network, or null when the wallet does not support it (Liquid). */
  network: WatchNetwork | null;
  wallets: WatchWallet[];
  activeId: string | null;
  /** The active wallet's computed view; null until its first scan finishes or its cached scan loads. */
  view: WalletView | null;
  /** Unix time in seconds of the scan or refresh behind `view`, or null when there is none. */
  updatedAt: number | null;
  /** True while the import form is shown on top of existing wallets. */
  adding: boolean;
  scanning: boolean;
  progress: ScanProgress | null;
  error: string | null;
  /** Something the user should know that is not an error, e.g. that an import was already saved. */
  notice: string | null;
  /** False once the server has refused live tracking; updates then arrive per block. */
  liveUpdates: boolean;
  /**
   * True while new blocks do not refresh the active wallet, because a per-block refresh found
   * more new transactions than a scan can page through. Pressing Refresh or reopening it resumes.
   */
  autoRefreshPaused: boolean;
  /**
   * Set when a bare xpub's receive address 0 has history under more than one script type:
   * those types, for the user to choose from. Nothing was imported.
   */
  scriptTypeChoices: ScriptType[] | null;
  /** Why some saved wallets could not be read, or null when all of them could. */
  storageUnreadable: StorageProblem | null;
  /** Why the last change to the saved wallets did not reach local storage, or null. */
  storageError: string | null;
}

const INITIAL_STATE: WalletPageState = {
  network: null,
  wallets: [],
  activeId: null,
  view: null,
  updatedAt: null,
  adding: false,
  scanning: false,
  progress: null,
  error: null,
  notice: null,
  liveUpdates: true,
  autoRefreshPaused: false,
  scriptTypeChoices: null,
  storageUnreadable: null,
  storageError: null,
};

function errorMessage(e: unknown): string {
  if (e instanceof ScanIncompleteError) {
    return e.reason === 'history-moved'
      ? $localize`:@@watch.scan-history-moved:The wallet's history kept changing on the server while it was being read, so it could not be read completely. Nothing was changed; try again in a moment.`
      : $localize`:@@watch.scan-reconcile-truncated:This wallet's new transactions could not all be read: there are more than a scan can page through in the browser. Nothing was changed.`;
  }
  if (e instanceof HttpErrorResponse) {
    switch (e.status) {
      case 429:
        return $localize`:@@watch.api-error-rate-limited:The server is limiting requests from this browser and the retries ran out. Nothing was changed; try again in a few minutes.`;
      case 503:
        return $localize`:@@watch.api-error-busy:The server is busy and the retries ran out. Nothing was changed; try again in a few minutes.`;
      case 413:
      case 504:
        return $localize`:@@watch.api-error-too-heavy:The server could not answer this wallet's history query in time (${e.status}:status:). Nothing was changed. A smaller gap limit or address list may help.`;
    }
    return $localize`:@@watch.api-error:Could not load the wallet's history from the server (${e.status || 'no response'}:status:). Nothing was changed; try again later.`;
  }
  return e instanceof Error ? e.message : String(e);
}

function isTooManyTransactions(e: unknown): boolean {
  return e instanceof ScanIncompleteError && e.reason === 'too-many-transactions';
}

/** A full refresh, or one for a new chain tip that may only need what is newer than the synced tip. */
type RefreshKind = 'full' | 'tip';

/** What looking up a bare xpub's script type found. */
type ScriptTypeDetection =
  | { outcome: 'detected'; scriptType: ScriptType }
  | { outcome: 'none' }
  | { outcome: 'several'; scriptTypes: ScriptType[] };

function saveFailedMessage(): string {
  return $localize`:@@watch.save-failed:This wallet couldn't be saved in this browser (storage full?)`;
}

function validGapLimit(value: number): number {
  const gapLimit = Number(value);
  if (!Number.isInteger(gapLimit) || gapLimit < MIN_GAP_LIMIT || gapLimit > MAX_GAP_LIMIT) {
    throw new Error($localize`:@@watch.gap-limit-invalid:Gap limit must be a whole number from ${MIN_GAP_LIMIT}:min: to ${MAX_GAP_LIMIT}:max:.`);
  }
  return gapLimit;
}

/**
 * State and actions for the /wallet page: the saved wallets, which one is shown, its
 * computed view, and the scan in progress.
 *
 * Provided by WatchComponent, so it lives exactly as long as the page and live tracking
 * stops when the user navigates away. Only one scan runs at a time; `generation` lets a
 * network change discard the result of a scan that started before it.
 *
 * Live updates keep arriving during a refresh: they are applied to the view on screen at
 * once and again to the refresh's result, which may have been fetched before them. A chain
 * change during a scan queues one more refresh for when it ends.
 *
 * Refreshes come in two sizes. A full refresh reads every address's history: on opening a
 * wallet, on the Refresh button and after a websocket reconnect. A new block only needs what
 * is newer than the server tip the wallet was last synced to (see WalletScannerService):
 * the server's tip plus one request per 100 addresses when nothing happened. The scanner
 * scans in full instead after a reorg, whenever it cannot show the result to be the same, and
 * once the server's tip is six blocks past the last full scan's, so a wallet left open is read
 * in full about once an hour.
 */
@Injectable()
export class WalletSessionService implements OnDestroy {
  readonly state$ = new BehaviorSubject<WalletPageState>(INITIAL_STATE);

  /** Views of wallets shown this session, so switching back is instant. */
  private views = new Map<string, WalletView>();
  /** When each of those views was last scanned or refreshed, in Unix seconds. */
  private scannedAt = new Map<string, number>();
  /**
   * The server tip each of those views is complete up to, or null when unknown (the tip could
   * not be read, or a truncated scan); see WalletScanResult.syncedTip.
   */
  private syncedTips = new Map<string, ChainTip | null>();
  /**
   * The height of the synced tip of the last full scan behind each of those views, when known.
   * Per-block refreshes build on it and give way to a full scan once the server is six blocks
   * past it (see IncrementalScan).
   */
  private fullScanHeights = new Map<string, number>();
  private generation = 0;
  /** The mempool network last loaded, so a change of network can be told from the first load. */
  private mempoolNetwork: string | null = null;
  /** The refresh a chain change asked for while a scan or the import form was in the way. */
  private queuedRefresh: RefreshKind | null = null;
  /** Live updates for the active wallet received while its refresh was running. */
  private updatesDuringScan: LiveUpdate[] = [];
  /**
   * Wallets whose per-block refresh found more new transactions than a scan can page through.
   * Every later block would fail the same way, so they are not refreshed on new blocks again
   * until the user presses Refresh or reopens the wallet.
   */
  private autoRefreshPaused = new Set<string>();

  constructor(
    private derivation: DerivationService,
    private scanner: WalletScannerService,
    private storage: WalletStorageService,
    private tracker: WalletTrackerService,
    private cache: WalletCacheService,
  ) {
    this.tracker.watchChain((change) => this.onChainChange(change));
  }

  get state(): WalletPageState {
    return this.state$.value;
  }

  get activeWallet(): WatchWallet | null {
    return this.state.wallets.find((w) => w.id === this.state.activeId) ?? null;
  }

  /** Load the wallets saved for a mempool network ('' is mainnet) and show the first. */
  setNetwork(mempoolNetwork: string): void {
    this.generation++;
    this.tracker.stop();
    if (this.mempoolNetwork !== null && this.mempoolNetwork !== mempoolNetwork) {
      this.tracker.resetChain();
    }
    this.mempoolNetwork = mempoolNetwork;
    this.queuedRefresh = null;
    this.autoRefreshPaused.clear();
    this.views.clear();
    this.scannedAt.clear();
    this.syncedTips.clear();
    this.fullScanHeights.clear();
    const network = fromMempoolNetwork(mempoolNetwork);
    const wallets = network ? this.storage.load(network) : [];
    this.state$.next({ ...INITIAL_STATE, network, wallets, storageUnreadable: this.storage.unreadable });
    if (wallets.length) {
      this.activate(wallets[0].id);
    }
  }

  startAdding(): void {
    if (this.state.scanning) {
      return;
    }
    this.tracker.stop();
    this.patch({ adding: true, error: null, notice: null, scriptTypeChoices: null });
  }

  cancelAdding(): void {
    this.patch({ adding: false, error: null, scriptTypeChoices: null });
    if (!this.runQueuedRefresh()) {
      this.startTracking();
    }
  }

  /**
   * Show a saved wallet at once, from this session or from the last visit's cached scan,
   * then rescan it in the background.
   */
  activate(id: string): Promise<void> {
    return this.show(id, null);
  }

  async importWallet(form: WalletImportForm): Promise<void> {
    const network = this.state.network;
    if (this.state.scanning || !network) {
      return;
    }
    let duplicate: WatchWallet | undefined;
    this.patch({ scriptTypeChoices: null });
    await this.runScan(async (generation) => {
      let detection: ScriptTypeDetection | null = null;
      let scriptTypeHint = form.scriptTypeHint;
      if (form.detectScriptType) {
        detection = await this.detectScriptType(form.input, network, generation);
        if (generation !== this.generation) {
          return;
        }
        if (detection?.outcome === 'several') {
          this.patch({ scriptTypeChoices: detection.scriptTypes });
          return;
        }
        if (detection?.outcome === 'detected') {
          scriptTypeHint = detection.scriptType;
        }
      }
      const definition = await this.toDefinition({ ...form, scriptTypeHint }, network);
      const id = await walletId(definition);
      if (generation !== this.generation) {
        return;
      }
      // Scanning a saved wallet afresh would drop the receive cursor, gap limit and address
      // window it has grown since, and could then hide funds beyond the default window.
      duplicate = this.state.wallets.find((w) => w.id === id);
      if (duplicate) {
        return;
      }
      const { wallet, txs, truncated, syncedTip, incremental } = await this.scanner.scan({
        definition,
        existingWalletId: id,
        onProgress: this.progressReporter(generation),
        isCancelled: () => generation !== this.generation,
      });
      if (generation !== this.generation) {
        return;
      }
      // A wallet forgotten while its refreshes were paused starts afresh when added again.
      this.autoRefreshPaused.delete(wallet.id);
      this.storeView(buildWalletView(wallet, txs, truncated), syncedTip, incremental);
      this.patch({ activeId: wallet.id, adding: false, notice: this.detectionNotice(detection, txs.length > 0) });
    });
    if (duplicate) {
      await this.show(duplicate.id, $localize`:@@watch.already-saved:This wallet is already saved as “${duplicate.label}:label:”. Showing it with its saved settings.`);
    }
  }

  /**
   * Rescan the active wallet in full. Called by the Refresh button and on opening a wallet,
   * which also resume refreshes on new blocks if they were paused.
   */
  refresh(): Promise<void> {
    if (this.state.activeId && !this.state.scanning) {
      this.autoRefreshPaused.delete(this.state.activeId);
    }
    return this.refreshActive('full');
  }

  rename(label: string): void {
    const wallet = this.activeWallet;
    const name = label.trim();
    if (wallet && name && name !== wallet.label) {
      this.updateWallet({ ...wallet, label: name });
    }
  }

  async setGapLimit(value: number): Promise<void> {
    const wallet = this.activeWallet;
    if (wallet?.kind !== 'descriptor' || this.state.scanning) {
      return;
    }
    let gapLimit: number;
    try {
      gapLimit = validGapLimit(value);
    } catch (e) {
      this.patch({ error: errorMessage(e) });
      return;
    }
    if (gapLimit === wallet.gapLimit) {
      return;
    }
    // A lower limit derives nothing and drops nothing: addresses are never forgotten.
    this.updateWallet({ ...wallet, gapLimit });
    if (gapLimit < wallet.gapLimit) {
      return;
    }
    // A higher one needs only the addresses beyond the derived edge.
    const view = this.views.get(wallet.id);
    if (!view || view.truncated) {
      await this.refresh();
      return;
    }
    await this.refreshActive('full', { kind: 'extend', tip: this.syncedTips.get(wallet.id) ?? null, transactions: view.transactions });
  }

  /**
   * Re-import the active bare-xpub wallet under another script type. That is a different
   * descriptor, and so a different wallet: it is scanned, then takes the old one's place in
   * the list, keeping its name and gap limit. The old one is removed only once the new scan
   * has succeeded.
   */
  async changeScriptType(scriptType: ScriptType): Promise<void> {
    const old = this.activeWallet;
    if (old?.kind !== 'descriptor' || this.state.scanning || !isBareExtendedKey(old.source) || old.scriptType === scriptType) {
      return;
    }
    let existing: WatchWallet | undefined;
    await this.runScan(async (generation) => {
      const definition = await this.toDefinition(
        { input: old.source, label: old.label, gapLimit: old.gapLimit, scriptTypeHint: scriptType },
        old.network,
      ) as DescriptorWalletDefinition;
      const id = await walletId(definition);
      if (generation !== this.generation) {
        return;
      }
      existing = this.state.wallets.find((w) => w.id === id);
      if (existing) {
        return;
      }
      const { wallet, txs, truncated, syncedTip, incremental } = await this.scanner.scan({
        definition,
        existingWalletId: id,
        onProgress: this.progressReporter(generation),
        isCancelled: () => generation !== this.generation,
      });
      if (generation !== this.generation || this.state.activeId !== old.id) {
        return;
      }
      this.tracker.stop();
      this.writeStorage(() => this.storage.replace(old.id, wallet), saveFailedMessage());
      this.dropSessionState(old.id);
      this.autoRefreshPaused.delete(wallet.id);
      this.patch({ wallets: this.state.wallets.map((w) => (w.id === old.id ? wallet : w)), activeId: wallet.id });
      this.storeView(buildWalletView(wallet, txs, truncated), syncedTip, incremental);
    });
    if (existing) {
      await this.show(existing.id, $localize`:@@watch.script-type-already-saved:This key is already saved with that address type as “${existing.label}:label:”. Showing it.`);
    }
  }

  /** Skip the current receive address, e.g. after handing it to someone who has not paid yet. */
  useNextReceiveAddress(): void {
    const wallet = this.state.view?.wallet;
    if (wallet?.kind !== 'descriptor') {
      return;
    }
    const next = currentReceiveIndex(wallet, this.state.view.lastUsed) + 1;
    if (wallet.addresses.some((a) => a.chain === 0 && a.index === next)) {
      this.updateWallet({ ...wallet, receiveIndex: next });
      this.startTracking();
    }
  }

  /** Remove the active wallet from this browser and show the next one, if any. */
  forget(): void {
    const wallet = this.activeWallet;
    if (!wallet || this.state.scanning) {
      return;
    }
    this.tracker.stop();
    this.writeStorage(() => this.storage.remove(wallet.id), $localize`:@@watch.remove-failed:This wallet couldn't be removed from this browser's storage, so it may come back when you reload the page.`);
    this.dropSessionState(wallet.id);
    const wallets = this.state.wallets.filter((w) => w.id !== wallet.id);
    this.patch({ wallets, activeId: null, view: null, updatedAt: null, error: null, notice: null });
    if (wallets.length) {
      this.activate(wallets[0].id);
    }
  }

  ngOnDestroy(): void {
    this.generation++;
    this.tracker.stop();
  }

  /**
   * For a bare xpub/tpub, which script type has history at receive index 0: one request for
   * the four candidate addresses together. Null for any other input.
   */
  private async detectScriptType(input: string, network: WatchNetwork, generation: number): Promise<ScriptTypeDetection | null> {
    const candidates = await this.derivation.scriptCandidates(input, network);
    if (!candidates.length || generation !== this.generation) {
      return null;
    }
    const progress = { phase: 'fetching' as const, addressesDerived: candidates.length, txsFound: 0, apiRequests: 1 };
    const report = this.progressReporter(generation);
    report(progress);
    const used = await this.scanner.addressesWithHistory(candidates.map((c) => c.address), {
      isCancelled: () => generation !== this.generation,
      onWait: (retry: RetryWait | null) => report({ ...progress, retry: retry ?? undefined }),
    });
    const withHistory = candidates.filter((c) => used.has(c.address)).map((c) => c.scriptType);
    if (withHistory.length === 1) {
      return { outcome: 'detected', scriptType: withHistory[0] };
    }
    return withHistory.length ? { outcome: 'several', scriptTypes: withHistory } : { outcome: 'none' };
  }

  /** What to tell the user after importing a bare xpub whose script type was looked up. */
  private detectionNotice(detection: ScriptTypeDetection | null, foundHistory: boolean): string | null {
    if (detection?.outcome === 'detected') {
      return $localize`:@@watch.script-type-detected:Detected ${scriptTypeName(detection.scriptType)}:scriptType: from on-chain history.`;
    }
    if (detection?.outcome === 'none' && !foundHistory) {
      return $localize`:@@watch.script-type-not-detected:No history found at m/…/0/0. If this key is from a Legacy, Nested SegWit or Taproot wallet, change the address type in Settings.`;
    }
    return null;
  }

  /** Validate the form's input and turn it into a wallet definition, ready to scan. */
  private async toDefinition(form: WalletImportForm, network: WatchNetwork): Promise<WalletDefinition> {
    const input = form.input.trim();
    const label = form.label.trim() || $localize`:@@watch.default-wallet-name:My wallet`;
    if (looksLikeAddressList(input)) {
      const addresses = await this.derivation.parseAddressList(input, network);
      return { kind: 'address-list', label, network, addresses };
    }
    const gapLimit = validGapLimit(form.gapLimit);
    const prepared = await this.derivation.prepare(input, network, form.scriptTypeHint);
    return {
      kind: 'descriptor',
      label,
      source: input,
      descriptor: prepared.descriptor,
      scriptType: prepared.scriptType,
      fingerprint: prepared.fingerprint,
      fingerprintIsMaster: prepared.fingerprintIsMaster,
      originPath: prepared.originPath,
      network,
      gapLimit,
    };
  }

  /** Update the page state. `autoRefreshPaused` always follows the active wallet. */
  private patch(changes: Partial<WalletPageState>): void {
    const next = { ...this.state, ...changes };
    next.autoRefreshPaused = !!next.activeId && this.autoRefreshPaused.has(next.activeId);
    this.state$.next(next);
  }

  private progressReporter(generation: number): (p: ScanProgress) => void {
    return (progress) => {
      if (generation === this.generation) {
        this.patch({ progress });
      }
    };
  }

  /**
   * Run one scan with the shared scanning/progress/error bookkeeping. Live tracking of the
   * wallet on screen carries on meanwhile; it is restarted afterwards for the new view.
   */
  private async runScan(scan: (generation: number) => Promise<void>, describeError: (e: unknown) => string = errorMessage): Promise<void> {
    const generation = ++this.generation;
    this.patch({ scanning: true, progress: null, error: null });
    try {
      await scan(generation);
    } catch (e) {
      if (generation === this.generation) {
        this.patch({ error: describeError(e) });
      }
    } finally {
      if (generation === this.generation) {
        this.updatesDuringScan = [];
        this.patch({ scanning: false, progress: null });
        if (!this.runQueuedRefresh()) {
          this.startTracking();
        }
      }
    }
  }

  /** Show a saved wallet, with an optional notice, then rescan it. */
  private async show(id: string, notice: string | null): Promise<void> {
    if (this.state.scanning || !this.state.wallets.some((w) => w.id === id)) {
      return;
    }
    this.tracker.stop();
    const view = this.views.get(id) ?? null;
    this.patch({ activeId: id, view, updatedAt: this.scannedAt.get(id) ?? null, adding: false, error: null, notice, liveUpdates: true });
    if (!view) {
      await this.showCachedScan(id);
    }
    this.startTracking();
    await this.refresh();
  }

  /** A new tip, a reorg or a reconnect: refresh now, or once the scan or import form is out of the way. */
  private onChainChange(change: ChainChange): void {
    const kind: RefreshKind = change === 'reconnect' ? 'full' : 'tip';
    if (this.state.activeId && this.autoRefreshPaused.has(this.state.activeId)) {
      return;
    }
    if (this.state.scanning || this.state.adding) {
      this.queueRefresh(kind);
    } else {
      void this.refreshActive(kind);
    }
  }

  /** Queue a refresh for when the current scan ends. A full one covers a per-block one. */
  private queueRefresh(kind: RefreshKind): void {
    this.queuedRefresh = this.queuedRefresh === 'full' ? 'full' : kind;
  }

  /** Start the refresh a chain change queued, if any. True if one started. */
  private runQueuedRefresh(): boolean {
    if (!this.queuedRefresh || this.state.adding || this.state.scanning || !this.activeWallet) {
      return false;
    }
    if (this.autoRefreshPaused.has(this.activeWallet.id)) {
      this.queuedRefresh = null;
      return false;
    }
    void this.refreshActive(this.queuedRefresh);
    return true;
  }

  /**
   * Refresh the active wallet. 'tip' is a chain change that may only need what is newer than
   * the wallet's synced tip; it becomes a full scan whenever that is not safe. `incremental`
   * forces a particular incremental scan, e.g. extending to a higher gap limit.
   */
  private async refreshActive(kind: RefreshKind, incremental?: IncrementalScan): Promise<void> {
    const wallet = this.activeWallet;
    if (!wallet || this.state.scanning) {
      return;
    }
    // This scan covers every chain change so far.
    this.queuedRefresh = null;
    this.updatesDuringScan = [];
    if (!incremental && kind === 'tip') {
      incremental = this.sinceSyncedTip(wallet);
    }
    await this.runScan(async (generation) => {
      const { wallet: scanned, txs, truncated, syncedTip, incremental: built } = await this.scanner.scan({
        definition: wallet,
        existingWalletId: wallet.id,
        minimumDerived: wallet.kind === 'descriptor' ? {
          0: Math.max(wallet.derivedCount[0], (wallet.receiveIndex ?? 0) + 1),
          1: wallet.derivedCount[1],
        } : undefined,
        incremental,
        onProgress: this.progressReporter(generation),
        isCancelled: () => generation !== this.generation,
      });
      if (generation !== this.generation || this.state.activeId !== scanned.id) {
        return;
      }
      // The user may have renamed the wallet or moved its receive cursor while it scanned.
      const current = this.activeWallet ?? wallet;
      // A changed gap limit needs a scan of its own, so it queues one.
      let merged: WatchWallet = { ...scanned, label: current.label };
      if (scanned.kind === 'descriptor' && current.kind === 'descriptor') {
        merged = { ...scanned, label: current.label, receiveIndex: current.receiveIndex, gapLimit: current.gapLimit };
        if (current.gapLimit !== scanned.gapLimit) {
          this.queueRefresh('full');
        }
      }
      let history = txs;
      for (const update of this.updatesDuringScan) {
        history = applyLiveUpdate(history, update.added, update.removed) ?? history;
      }
      this.storeView(buildWalletView(merged, history, truncated), syncedTip, built);
    }, (e) => {
      // The pause outlasts this error, which closing the import form or another scan clears;
      // the page shows it on its own (WalletPageState.autoRefreshPaused).
      if (kind === 'tip' && isTooManyTransactions(e)) {
        this.autoRefreshPaused.add(wallet.id);
      }
      return errorMessage(e);
    });
  }

  /**
   * The per-block scan for the active wallet, or undefined when there is no complete view or
   * synced tip to build on. The scanner checks the synced tip against the server's chain and
   * scans in full after a reorg or when the server is behind it.
   */
  private sinceSyncedTip(wallet: WatchWallet): IncrementalScan | undefined {
    const view = this.views.get(wallet.id);
    const synced = this.syncedTips.get(wallet.id);
    if (!view || view.truncated || !synced) {
      return undefined;
    }
    return { kind: 'since', tip: synced, transactions: view.transactions, fullScanHeight: this.fullScanHeights.get(wallet.id) ?? null };
  }

  /**
   * Show the wallet's cached scan, unless something else has been shown or started meanwhile.
   * A cached scan that cannot be read or turned into a view is discarded: the refresh that
   * follows replaces it, and the page must not stop short of that refresh because of it.
   */
  private async showCachedScan(id: string): Promise<void> {
    const generation = this.generation;
    let cached: CachedScan | null;
    let view: WalletView;
    try {
      cached = await this.cache.get(id);
      const wallet = this.state.wallets.find((w) => w.id === id);
      if (!cached || !wallet || generation !== this.generation || this.state.activeId !== id || this.state.view) {
        return;
      }
      view = buildWalletView(wallet, cached.transactions, cached.truncated);
    } catch {
      void this.cache.delete(id).catch(() => undefined);
      return;
    }
    this.views.set(id, view);
    this.scannedAt.set(id, cached.updatedAt);
    this.syncedTips.set(id, cached.syncedTip ?? null);
    this.patch({ view, updatedAt: cached.updatedAt });
  }

  /** Forget what this session holds for a wallet that is being removed or replaced. */
  private dropSessionState(id: string): void {
    this.cache.delete(id);
    this.views.delete(id);
    this.scannedAt.delete(id);
    this.syncedTips.delete(id);
    this.fullScanHeights.delete(id);
    this.autoRefreshPaused.delete(id);
  }

  /**
   * Save a freshly scanned wallet, cache its history and make its view the one on screen.
   * `syncedTip` is the block the history is complete up to, or null when unknown;
   * `incremental` says whether the scan built on an earlier one rather than reading it all.
   */
  private storeView(view: WalletView, syncedTip: ChainTip | null, incremental: boolean): void {
    const { wallet } = view;
    const updatedAt = Math.floor(Date.now() / 1000);
    this.writeStorage(() => this.storage.save(wallet), saveFailedMessage());
    this.cache.put({ walletId: wallet.id, updatedAt, truncated: view.truncated, transactions: view.transactions, ...(syncedTip ? { syncedTip } : {}) });
    this.views.set(wallet.id, view);
    this.scannedAt.set(wallet.id, updatedAt);
    this.syncedTips.set(wallet.id, syncedTip);
    if (!incremental) {
      if (syncedTip) {
        this.fullScanHeights.set(wallet.id, syncedTip.height);
      } else {
        this.fullScanHeights.delete(wallet.id);
      }
    }
    const wallets = this.state.wallets.some((w) => w.id === wallet.id)
      ? this.state.wallets.map((w) => (w.id === wallet.id ? wallet : w))
      : [...this.state.wallets, wallet];
    this.patch({ wallets, view, updatedAt });
  }

  /**
   * Run one write to the saved wallets, reporting a failed one (e.g. a full storage quota) on
   * the page instead of losing it silently. A write that succeeds clears an earlier report.
   */
  private writeStorage(write: () => void, failure: string): void {
    let storageError: string | null = null;
    try {
      write();
    } catch (e) {
      if (!(e instanceof WalletStorageError)) {
        throw e;
      }
      storageError = failure;
    }
    this.patch({ storageError, storageUnreadable: this.storage.unreadable });
  }

  /** Persist a settings change to the active wallet without rescanning it. */
  private updateWallet(wallet: WatchWallet): void {
    this.writeStorage(() => this.storage.save(wallet), saveFailedMessage());
    const cached = this.views.get(wallet.id);
    const view = cached ? { ...cached, wallet } : null;
    if (view) {
      this.views.set(wallet.id, view);
    }
    this.patch({
      wallets: this.state.wallets.map((w) => (w.id === wallet.id ? wallet : w)),
      view: this.state.activeId === wallet.id ? view : this.state.view,
    });
  }

  /** Track the addresses of the wallet on screen. Not while the import form is open. */
  private startTracking(): void {
    const view = this.state.view;
    if (!view || this.state.adding) {
      return;
    }
    const id = view.wallet.id;
    this.tracker.start(view.wallet, view.utxos, upcomingReceiveAddresses(view, WATCH_UNUSED_RECEIVE), {
      onUpdate: (update) => this.onLiveUpdate(id, update),
      onDegraded: () => this.patch({ liveUpdates: false }),
    });
  }

  /** Apply a websocket update to the active view and its cached scan. */
  private onLiveUpdate(id: string, update: LiveUpdate): void {
    const view = this.state.view;
    if (!view || view.wallet.id !== id) {
      return;
    }
    if (this.state.scanning) {
      this.updatesDuringScan.push(update);
    }
    const transactions = applyLiveUpdate(view.transactions, update.added, update.removed);
    if (!transactions) {
      return;
    }
    const updated = buildWalletView(view.wallet, transactions, view.truncated);
    this.views.set(id, updated);
    this.patch({ view: updated });
    // Keep the cached scan's time: the update does not make the rest of the history fresher.
    const updatedAt = this.scannedAt.get(id);
    if (updatedAt) {
      const syncedTip = this.syncedTips.get(id);
      this.cache.put({ walletId: id, updatedAt, truncated: updated.truncated, transactions, ...(syncedTip ? { syncedTip } : {}) });
    }
    // A payment can move the next receive address or fund a new one; track the new set.
    this.startTracking();
  }
}
