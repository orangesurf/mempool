import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { Router } from '@angular/router';
import { ApiService } from '@app/services/api.service';
import { SeoService } from '@app/services/seo.service';
import { StateService } from '@app/services/state.service';
import { WebsocketService } from '@app/services/websocket.service';
import { RelativeUrlPipe } from '@app/shared/pipes/relative-url/relative-url.pipe';
import { AddressTxSummary, Transaction, Utxo } from '@interfaces/electrs.interface';
import { BehaviorSubject, merge, of, Subscription } from 'rxjs';
import { distinctUntilChanged } from 'rxjs/operators';
import { DerivationService } from './services/derivation.service';
import { ScanProgress, WalletScannerService } from './services/wallet-scanner.service';
import { WalletSendController } from './services/wallet-send.controller';
import { WalletLabelsService, WalletLocalStateService, WalletStorageService } from './services/wallet-storage.service';
import { WalletTrackerService } from './services/wallet-tracker.service';
import { WalletService } from './services/wallet.service';
import { parseWalletFile, sparrowExport } from './wallet-file.utils';
import { LabelFileImportResult, LabelImportFormat, parseLabelFile, toJsonl } from './wallet-label-file.utils';
import { describeScriptType, fromMempoolNetwork, looksLikeDescriptor } from './watch-key.utils';
import { AddressExplorerRow, LabelEditor, WalletView, WatchTab } from './watch-models';
import {
  Bip329Label,
  Bip329LabelType,
  DerivedAddress,
  ScriptType,
  WalletBalance,
  WalletUtxo,
  WatchNetwork,
  WatchWallet,
} from './watch.types';

const SCRIPT_TYPES: { value: ScriptType; label: string; path: string }[] = [
  { value: 'wpkh',    label: 'Native SegWit', path: "m/84'/0'/0'" },
  { value: 'sh_wpkh', label: 'Nested SegWit', path: "m/49'/0'/0'" },
  { value: 'pkh',     label: 'Legacy',        path: "m/44'/0'/0'" },
  { value: 'tr',      label: 'Taproot',       path: "m/86'/0'/0'" },
];

@Component({
  selector: 'app-watch',
  templateUrl: './watch.component.html',
  styleUrls: ['./watch.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false,
})
export class WatchComponent implements OnInit, OnDestroy {
  readonly send: WalletSendController;
  private scanGeneration = 0;
  scriptTypes = SCRIPT_TYPES;

  // import form
  keyInput = '';
  label = 'My wallet';
  gapLimit = 20;
  scriptTypeHint: ScriptType = 'wpkh';

  network: WatchNetwork | null = null;
  networkUnsupported = false;

  /** Every saved wallet on this network. The dashboard shows one at a time (the active one)
   *  but all are tracked, switchable, and recognised site-wide. */
  wallets: WatchWallet[] = [];
  /** True while the import form is shown even though wallets already exist (adding another). */
  adding = false;
  /** True when the dashboard shows the aggregate of every loaded wallet ("All wallets"). */
  viewingAll = false;

  /**
   * In-memory cache of each wallet's computed view, so switching back to a wallet is instant
   * instead of re-fetching or re-scanning. Only lives for the session; a page reload
   * recomputes on first activation from the mempool API.
   */
  private views = new Map<string, WalletView>();

  wallet: WatchWallet | null = null;
  balance: WalletBalance = { confirmed: 0, pending: 0, total: 0 };
  utxos: WalletUtxo[] = [];
  transactions: Transaction[] = [];
  addressStrings: string[] = [];
  lastUsed: Record<0 | 1, number> = { 0: -1, 1: -1 };

  /** The gear panel: keeps script type, paths and the descriptor out of the main view. */
  showDetails = false;
  activeTab: WatchTab = 'overview';

  /** Receive addresses are already derived and scanned; this cursor lets the user skip one. */
  receiveIndex = 0;

  labelEditor: LabelEditor | null = null;
  labelTransferMessage = '';
  walletFileMessage = '';
  exportTransferMessage = '';
  pendingLabelImport: LabelFileImportResult | null = null;
  pendingLabelFileName = '';
  pendingLabelFileMessage = '';
  selectedLabelTxid = '';

  /** Cache backing txLabelMap: rebuilt when the transactions change or a label is edited. */
  private txLabelSource: Transaction[] | null = null;
  private txLabelsDirty = false;
  private txLabelMapCache: Record<string, string> = {};
  private labelContextsSource: Transaction[] | null = null;
  private labelContextsDirty = true;
  private addressTransactionLabelsCache: Record<string, string[]> = {};
  graphUtxoLabelDetails: Record<string, string[]> = {};

  addressChainFilter: 'all' | 'receive' | 'change' = 'all';
  addressStatusFilter: 'all' | 'unused' | 'used' = 'all';
  addressBalanceFilter: 'all' | 'positive' = 'all';
  addressBalanceSort: 'none' | 'desc' | 'asc' = 'none';
  highlightedAddress = '';
  showAddressDerivationPath = false;
  descriptorOriginAcknowledged = false;
  settingsGapLimit = 20;
  private explorerWallet: WatchWallet | null = null;
  private explorerTransactions: Transaction[] | null = null;
  private explorerUtxos: WalletUtxo[] | null = null;
  private explorerRows: AddressExplorerRow[] = [];

  /** Inline rename in the dashboard header. `labelDraft` is the in-progress edit. */
  editingLabel = false;
  labelDraft = '';
  @ViewChild('renameInput') renameInput?: ElementRef<HTMLInputElement>;

  scanning = false;
  /** True only until the first real wallet view arrives; later refreshes keep showing cached data. */
  initialWalletLoading = false;
  liveTrackingDegraded = false;
  progress: ScanProgress | null = null;
  error: string | null = null;
  truncated = false;

  /**
   * Feeds the shared balance-history chart (the same one the address page and the
   * enterprise wallet page use). AddressGraphComponent walks this list backwards from the
   * current total, so it must be newest-first — see its prepareChartOptions().
   */
  walletSummary$ = new BehaviorSubject<AddressTxSummary[]>([]);

  /**
   * <app-utxo-graph> is OnPush and re-packs its circles whenever its @Input array changes by
   * reference, so we map WalletUtxo[] → Utxo[] once per utxos change and cache it, rather than
   * building a fresh array on every change-detection pass. See the graphUtxos getter.
   */
  private graphUtxosSource: WalletUtxo[] | null = null;
  private graphUtxosCache: Utxo[] = [];
  graphFrozenOutpoints = new Set<string>();
  graphUtxoLabels: Record<string, string> = {};
  graphLabelSlots = new Set<string>();

  private subscription = new Subscription();
  private accelerationsSubscription: Subscription | null = null;
  acceleratedTxids: Set<string> | null = null;

  constructor(
    public stateService: StateService,
    private seoService: SeoService,
    private apiService: ApiService,
    private walletService: WalletService,
    private scanner: WalletScannerService,
    private storage: WalletStorageService,
    private labels: WalletLabelsService,
    private localState: WalletLocalStateService,
    private derivation: DerivationService,
    private tracker: WalletTrackerService,
    private websocketService: WebsocketService,
    private router: Router,
    private relativeUrlPipe: RelativeUrlPipe,
    private cd: ChangeDetectorRef,
  ) {
    this.send = new WalletSendController(this, stateService, derivation, storage, walletService, localState, router, relativeUrlPipe, cd);
  }

  ngOnInit(): void {
    this.send.initialize();
    this.seoService.setTitle($localize`:@@watch.title:Watch-only wallet`);

    this.subscription.add(this.tracker.walletUpdated$.subscribe(() => {
      this.liveTrackingDegraded = this.tracker.degraded;
      this.cd.markForCheck();
    }));

    // networkChanged$ does NOT emit on mainnet: StateService initialises `network` to ''
    // and only emits when it *changes* (state.service.ts:152, :460). Subscribing to it alone
    // means mainnet users never get a network, which silently disables the whole page. Seed
    // with the current value, exactly as MasterPageComponent does.
    this.subscription.add(merge(
      of(this.stateService.network),
      this.stateService.networkChanged$,
    ).pipe(distinctUntilChanged()).subscribe((network) => {
      this.scanGeneration++;
      this.scanning = false;
      const mapped = fromMempoolNetwork(network);
      this.network = mapped;
      this.networkUnsupported = mapped === null;
      this.updateAccelerationSubscription();
      this.reset();
      this.wallets = [];
      this.views.clear();
      this.adding = false;
      if (mapped) {
        this.wallets = this.storage.load(mapped);
        this.walletService.syncWallets(this.wallets);
        if (this.wallets.length) {
          this.activate(this.wallets[0]);
        }
      } else {
        this.walletService.syncWallets([]);
        this.walletService.setActive(null);
      }
      this.cd.markForCheck();
    }));
  }

  // ── multiple wallets ──

  get hasWallets(): boolean {
    return this.wallets.length > 0;
  }

  /** Show the import form when there are no wallets, or the user is adding another. */
  get showImportForm(): boolean {
    return !this.networkUnsupported && (this.adding || this.wallets.length === 0);
  }

  /** Show the dashboard — either a single active wallet, or the "All wallets" aggregate. */
  get showDashboard(): boolean {
    return (!!this.wallet || this.viewingAll) && !this.adding;
  }

  get needsSigningDescriptor(): boolean {
    return this.send.needsSigningDescriptor;
  }

  /** Each tab accepts only its own state and callbacks through an independent interface. */

  get sectionModel(): WatchComponent {
    return this;
  }

  /** Offer an "All wallets" option only once there is more than one wallet to aggregate. */
  get canViewAll(): boolean {
    return this.wallets.length > 1;
  }

  /** How many wallets are actually included in the aggregate (i.e. have a loaded view). */
  get loadedWalletCount(): number {
    return this.wallets.filter((w) => this.views.has(w.id)).length;
  }

  /** Begin adding another wallet: keep the existing ones, show a fresh import form. */
  addWallet(): void {
    if (this.scanning) {
      return;
    }
    this.stashActiveView();
    this.tracker.stop();
    this.viewingAll = false;
    this.adding = true;
    this.resetImportForm();
    this.cd.markForCheck();
  }

  /** Cancel adding — go back to the active wallet's dashboard. */
  cancelAdd(): void {
    this.adding = false;
    this.error = null;
    if (this.wallet) {
      this.showView(this.wallet.id);
    }
    this.cd.markForCheck();
  }

  /** Make `wallet` the active one, loading its view from cache or (re)computing it. */
  async activate(wallet: WatchWallet): Promise<void> {
    if (this.scanning) {
      return;
    }
    this.adding = false;
    this.viewingAll = false;
    this.error = null;
    const generation = ++this.scanGeneration;
    this.walletService.setActive(wallet);

    if (this.views.has(wallet.id)) {
      this.initialWalletLoading = false;
      this.showView(wallet.id);
      this.cd.markForCheck();
      await this.refresh(generation);
      return;
    }

    this.send.resetSendFlow();
    this.initialWalletLoading = true;
    this.applyWallet(wallet, []);
    await this.refresh(generation);
  }

  switchTo(id: string): void {
    if (this.scanning || (!this.viewingAll && id === this.wallet?.id)) {
      return;
    }
    this.stashActiveView();
    const target = this.wallets.find((w) => w.id === id);
    if (target) {
      this.activate(target);
    }
  }

  openWalletSettings(id: string): void {
    if (this.scanning) return;
    if (this.wallet?.id !== id || this.viewingAll) this.switchTo(id);
    this.activeTab = 'settings';
    this.cd.markForCheck();
  }

  // ── all wallets (aggregate) ──

  /**
   * Show the combined balance, UTXOs and history of every wallet at once. Any wallet not yet
   * cached this session is fetched from the mempool API first.
   */
  async showAll(): Promise<void> {
    if (this.scanning) {
      return;
    }
    this.stashActiveView();
    this.tracker.stop();
    this.viewingAll = true;
    if (this.activeTab !== 'overview' && this.activeTab !== 'transactions' && this.activeTab !== 'utxos') {
      this.activeTab = 'overview';
    }
    this.adding = false;
    this.editingLabel = false;
    this.wallet = null;
    this.error = null;
    this.initialWalletLoading = true;
    this.walletService.setActive(null);
    this.cd.markForCheck();

    await this.refreshAll();
  }

  /** Shared scan setup preserves both discovered addresses and reserved change. */
  private scanSavedWallet(
    wallet: WatchWallet, onProgress?: (progress: ScanProgress) => void,
  ): ReturnType<WalletScannerService['scan']> {
    return this.scanner.scan({
      descriptor: wallet.descriptor,
      scriptType: wallet.scriptType,
      network: wallet.network,
      gapLimit: wallet.gapLimit,
      source: wallet.source,
      label: wallet.label,
      identity: {
        fingerprint: wallet.fingerprint,
        fingerprintIsMaster: wallet.fingerprintIsMaster,
        originPath: wallet.originPath,
        signingOriginsComplete: wallet.signingOriginsComplete,
      },
      minimumDerived: {
        0: wallet.derivedCount[0],
        1: Math.max(wallet.derivedCount[1], (this.localState.getChangeIndex(wallet) ?? 0) + wallet.gapLimit),
      },
      existingWalletId: wallet.id,
      onProgress,
    });
  }

  /** Load one wallet's view into the cache without disturbing what is on screen. */
  private async loadViewFor(wallet: WatchWallet, generation = this.scanGeneration): Promise<void> {
    if (this.views.has(wallet.id)) {
      return;
    }
    const { wallet: scanned, txs, truncated } = await this.scanSavedWallet(wallet);
    if (generation !== this.scanGeneration) return;
    this.storage.save(scanned);
    const view = this.walletService.buildView(scanned, txs);
    this.views.set(scanned.id, {
      wallet: scanned,
      transactions: txs,
      utxos: view.utxos,
      balance: view.balance,
      lastUsed: view.lastUsed,
      summary: view.summary,
      truncated,
      liveTrackingDegraded: false,
    });
    const idx = this.wallets.findIndex((w) => w.id === scanned.id);
    if (idx >= 0) {
      this.wallets[idx] = scanned;
    }
  }

  /** Fold every loaded wallet's cached view into the aggregate display fields. */
  private applyAggregate(): void {
    const views = this.wallets
      .map((w) => this.views.get(w.id))
      .filter((v): v is WalletView => !!v);

    // Union of transactions, deduped by txid (one tx can touch two of the user's wallets).
    const txById = new Map<string, Transaction>();
    for (const v of views) {
      for (const tx of v.transactions) {
        txById.set(tx.txid, tx);
      }
    }
    this.transactions = [...txById.values()];
    this.walletService.syncWallets(this.wallets);
    const aggregate = this.walletService.buildAggregateView(this.wallets, this.transactions);
    this.balance = aggregate.balance;
    this.utxos = aggregate.utxos;
    this.walletSummary$.next(aggregate.summary);

    // Site-wide highlighting already recognises every wallet (mergedMap); give the tx list the
    // union of addresses so it highlights all of them.
    this.addressStrings = this.wallets.flatMap((w) => w.addresses.map((a) => a.address));
    this.syncDisplayPreferences();

    // Per-wallet-only state has no meaning for the aggregate.
    this.lastUsed = { 0: -1, 1: -1 };
    this.truncated = views.some((view) => view.truncated);
    this.liveTrackingDegraded = views.some((view) => view.liveTrackingDegraded);
  }

  /** Reload every included wallet and rebuild the aggregate (the Refresh button in All mode). */
  private async refreshAll(): Promise<void> {
    if (this.scanning) {
      return;
    }
    const generation = ++this.scanGeneration;
    this.scanning = true;
    this.error = null;
    this.cd.markForCheck();
    try {
      for (const w of [...this.wallets]) {
        this.views.delete(w.id);
        await this.loadViewFor(w, generation);
        if (generation !== this.scanGeneration) return;
      }
    } catch (e) {
      if (generation === this.scanGeneration) this.error = e instanceof Error ? e.message : String(e);
    } finally {
      if (generation === this.scanGeneration) this.scanning = false;
    }
    if (generation !== this.scanGeneration) return;
    this.applyAggregate();
    this.initialWalletLoading = false;
    this.cd.markForCheck();
  }

  /** Save the currently-displayed wallet's view into the cache before switching away. */
  private stashActiveView(): void {
    if (!this.wallet) {
      return;
    }
    this.views.set(this.wallet.id, {
      wallet: this.wallet,
      transactions: this.transactions,
      utxos: this.utxos,
      balance: this.balance,
      lastUsed: this.lastUsed,
      summary: this.walletSummary$.value,
      truncated: this.truncated,
      liveTrackingDegraded: this.liveTrackingDegraded,
    });
  }

  /** Populate the display fields from a cached view and restart live tracking for it. */
  private showView(id: string): void {
    this.send.resetSendFlow();
    const v = this.views.get(id);
    if (!v) {
      return;
    }
    this.tracker.stop();
    this.initialWalletLoading = false;
    this.wallet = v.wallet;
    this.transactions = v.transactions;
    this.utxos = v.utxos;
    this.balance = v.balance;
    this.lastUsed = v.lastUsed;
    this.addressStrings = v.wallet.addresses.map((a) => a.address);
    this.walletSummary$.next(v.summary);
    this.truncated = v.truncated;
    this.liveTrackingDegraded = v.liveTrackingDegraded;

    this.walletService.setActive(v.wallet);
    this.syncDisplayPreferences();
    this.startTracking();
  }

  private syncDisplayPreferences(): void {
    this.labelEditor = null;
    this.labelContextsDirty = true;
    this.send.syncSendCoinSelection();
    this.syncGraphPresentation();
    this.selectedLabelTxid = this.transactions.some((tx) => tx.txid === this.selectedLabelTxid)
      ? this.selectedLabelTxid
      : (this.transactions[0]?.txid ?? '');
    if (!this.wallet) {
      this.receiveIndex = 0;
      return;
    }
    this.settingsGapLimit = this.wallet.gapLimit;
    this.showAddressDerivationPath = this.localState.getShowAddressDerivationPath(this.wallet);
    this.descriptorOriginAcknowledged = this.localState.getDescriptorOriginAcknowledged(this.wallet);

    const minimum = this.lastUsed[0] + 1;
    const stored = this.localState.getReceiveIndex(this.wallet) ?? minimum;
    const receive = this.wallet.addresses
      .filter((address) => address.chain === 0 && address.index >= Math.max(minimum, stored))
      .sort((a, b) => a.index - b.index)[0];
    this.receiveIndex = receive?.index ?? minimum;
    if (receive && stored !== receive.index) {
      this.localState.setReceiveIndex(this.wallet, receive.index);
    }
  }

  async updateGapLimit(): Promise<void> {
    if (!this.wallet || this.scanning) {
      return;
    }
    const gapLimit = Number(this.settingsGapLimit);
    if (!Number.isInteger(gapLimit) || gapLimit < 5 || gapLimit > 1000) {
      this.error = 'Gap limit must be a whole number from 5 to 1000.';
      this.cd.markForCheck();
      return;
    }
    this.settingsGapLimit = gapLimit;
    if (gapLimit === this.wallet.gapLimit) {
      return;
    }
    const updated = { ...this.wallet, gapLimit };
    this.wallet = updated;
    const index = this.wallets.findIndex((wallet) => wallet.id === updated.id);
    if (index >= 0) {
      this.wallets = this.wallets.map((wallet, walletIndex) => walletIndex === index ? updated : wallet);
    }
    this.storage.save(updated);
    this.walletService.setActive(updated);
    this.walletService.syncWallets(this.wallets);
    this.views.delete(updated.id);
    await this.refresh();
  }

  // ── rename the active wallet ──

  /** Begin editing the active wallet's label from the dashboard header. */
  startRename(): void {
    if (!this.wallet || this.scanning) {
      return;
    }
    this.labelDraft = this.wallet.label;
    this.editingLabel = true;
    this.cd.markForCheck();
    // The input only exists once *ngIf renders it, so focus on the next tick.
    setTimeout(() => this.renameInput?.nativeElement.focus());
  }

  cancelRename(): void {
    this.editingLabel = false;
    this.cd.markForCheck();
  }

  /**
   * Persist a new label everywhere the old one was shown: local storage, the wallet list,
   * the site-wide registry, and the cached view — so the dropdown, the header and any
   * "is this mine?" wallet labelling all update at once.
   */
  saveRename(): void {
    if (!this.wallet) {
      this.editingLabel = false;
      return;
    }
    const name = this.labelDraft.trim();
    if (!name || name === this.wallet.label) {
      this.editingLabel = false;
      this.cd.markForCheck();
      return;
    }

    this.wallet.label = name;
    this.storage.save(this.wallet);

    const idx = this.wallets.findIndex((w) => w.id === this.wallet.id);
    if (idx >= 0) {
      this.wallets[idx] = this.wallet;
    }
    this.walletService.syncWallets(this.wallets);

    const view = this.views.get(this.wallet.id);
    if (view) {
      view.wallet = this.wallet;
    }

    this.editingLabel = false;
    this.cd.markForCheck();
  }

  async importWalletFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) {
      return;
    }
    this.error = null;
    this.walletFileMessage = '';
    try {
      const imported = parseWalletFile(await file.text());
      this.keyInput = imported.input;
      if (imported.label) this.label = imported.label;
      if (imported.gapLimit) this.gapLimit = Math.max(5, Math.min(1000, imported.gapLimit));
      this.onKeyInput();
      this.walletFileMessage = `Loaded ${imported.format} wallet data. Only public data will be imported.`;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.cd.markForCheck();
  }

  /** Open the existing add-wallet flow before loading a wallet file from the Settings tab. */
  async beginWalletFileImport(event: Event): Promise<void> {
    this.addWallet();
    await this.importWalletFile(event);
  }

  async attachLabelFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) {
      return;
    }

    this.pendingLabelImport = null;
    this.pendingLabelFileName = '';
    try {
      const imported = parseLabelFile(await file.text(), file.name);
      this.pendingLabelImport = imported;
      this.pendingLabelFileName = file.name;
      this.pendingLabelFileMessage = this.labelImportFormatName(imported.format) + ': '
        + imported.records.length + ' supported label'
        + (imported.records.length === 1 ? '' : 's') + ' ready.'
        + (imported.skipped ? ' ' + imported.skipped + ' unlabelled or unsupported records will be skipped.' : '');
    } catch (e) {
      this.pendingLabelFileMessage = e instanceof Error ? e.message : String(e);
    }
    this.cd.markForCheck();
  }

  removeAttachedLabelFile(): void {
    this.pendingLabelImport = null;
    this.pendingLabelFileName = '';
    this.pendingLabelFileMessage = '';
    this.cd.markForCheck();
  }

  // ── Wallet labels and label-file interchange ──

  labelFor(type: Bip329LabelType, ref: string): string {
    const wallets = this.viewingAll
      ? this.walletsOwning(type, ref)
      : (this.wallet ? [this.wallet] : []);
    for (const wallet of wallets) {
      const label = this.labels.get(wallet, type, ref);
      if (label) {
        return label;
      }
    }
    return '';
  }

  isEditingLabel(type: Bip329LabelType, ref: string): boolean {
    return this.labelEditor?.type === type && this.labelEditor.ref === ref;
  }

  startLabelEdit(type: Bip329LabelType, ref: string): void {
    const owners = this.viewingAll
      ? this.walletsOwning(type, ref)
      : (this.wallet ? [this.wallet] : []);
    if (!owners.length) {
      return;
    }
    this.labelEditor = {
      type,
      ref,
      walletIds: owners.map((wallet) => wallet.id),
      draft: this.labelFor(type, ref),
    };
    this.cd.markForCheck();
  }

  saveLabelEdit(): void {
    if (!this.labelEditor) {
      return;
    }
    const { type, ref, walletIds, draft } = this.labelEditor;
    for (const id of walletIds) {
      const wallet = this.wallets.find((candidate) => candidate.id === id);
      if (wallet) {
        this.labels.set(wallet, type, ref, draft);
      }
    }
    this.labelEditor = null;
    this.cd.markForCheck();
  }

  cancelLabelEdit(): void {
    this.labelEditor = null;
    this.cd.markForCheck();
  }

  /**
   * txid → label for the current transactions, fed to the inline pencil labels in the
   * transactions list. Memoised on the transactions reference (and invalidated when a label is
   * edited or imported) so the OnPush list receives a stable reference between changes.
   */
  get txLabelMap(): Record<string, string> {
    if (this.txLabelSource !== this.transactions || this.txLabelsDirty) {
      this.txLabelSource = this.transactions;
      this.txLabelsDirty = false;
      const map: Record<string, string> = {};
      for (const tx of this.transactions) {
        const label = this.labelFor('tx', tx.txid);
        if (label) {
          map[tx.txid] = label;
        }
      }
      this.txLabelMapCache = map;
    }
    return this.txLabelMapCache;
  }

  /** Transaction labels inherited by touched addresses without overwriting direct labels. */
  private rebuildLabelContexts(): void {
    if (this.labelContextsSource === this.transactions && !this.labelContextsDirty) return;

    const addressTransactionLabels = new Map<string, Set<string>>();
    for (const tx of this.transactions) {
      const touchedAddresses = new Set<string>();

      tx.vin?.forEach((vin) => {
        const address = vin.prevout?.scriptpubkey_address;
        if (address) touchedAddresses.add(address);
      });
      tx.vout?.forEach((vout) => {
        const address = vout.scriptpubkey_address;
        if (address) touchedAddresses.add(address);
      });

      const transactionLabel = this.labelFor('tx', tx.txid);
      if (transactionLabel) {
        touchedAddresses.forEach((address) => {
          const labels = addressTransactionLabels.get(address) ?? new Set<string>();
          labels.add(transactionLabel);
          addressTransactionLabels.set(address, labels);
        });
      }
    }

    this.addressTransactionLabelsCache = Object.fromEntries(
      [...addressTransactionLabels].map(([address, labels]) => [address, [...labels]]),
    );
    this.labelContextsSource = this.transactions;
    this.labelContextsDirty = false;
  }

  addressTransactionLabels(address: string): string[] {
    this.rebuildLabelContexts();
    return this.addressTransactionLabelsCache[address] ?? [];
  }

  addressDisplayLabel(address: string): string {
    return this.labelFor('addr', address) || this.addressTransactionLabels(address)[0] || '';
  }

  utxoInheritedLabel(utxo: WalletUtxo): string {
    return this.labelFor('tx', utxo.txid) || this.labelFor('addr', utxo.address);
  }

  utxoDisplayLabel(utxo: WalletUtxo): string {
    return this.labelFor('output', this.outpoint(utxo)) || this.utxoInheritedLabel(utxo);
  }

  /** Persist a transaction label edited inline beside its txid. */
  setTxLabel(txid: string, label: string): void {
    const owners = this.viewingAll
      ? this.walletsOwning('tx', txid)
      : (this.wallet ? [this.wallet] : []);
    for (const wallet of owners) {
      this.labels.set(wallet, 'tx', txid, label);
    }
    this.txLabelsDirty = true;
    this.labelContextsDirty = true;
    this.syncGraphPresentation();
    this.cd.markForCheck();
  }

  private walletsOwning(type: Bip329LabelType, ref: string): WatchWallet[] {
    return this.wallets.filter((wallet) => this.walletOwns(wallet, type, ref));
  }

  private walletOwns(wallet: WatchWallet, type: Bip329LabelType, ref: string): boolean {
    if (type === 'addr') {
      return wallet.addresses.some((item) => item.address === ref);
    }

    const view = this.wallet?.id === wallet.id
      ? { transactions: this.transactions, utxos: this.utxos }
      : this.views.get(wallet.id);
    if (type === 'tx') {
      return !!view?.transactions.some((tx) => tx.txid === ref);
    }

    const separator = ref.lastIndexOf(':');
    const txid = ref.slice(0, separator);
    const vout = Number(ref.slice(separator + 1));
    if (view?.utxos.some((utxo) => utxo.txid === txid && utxo.vout === vout)) {
      return true;
    }
    const addresses = new Set(wallet.addresses.map((item) => item.address));
    const tx = view?.transactions.find((candidate) => candidate.txid === txid);
    return !!tx?.vout?.[vout]?.scriptpubkey_address
      && addresses.has(tx.vout[vout].scriptpubkey_address);
  }

  async importLabels(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) {
      return;
    }
    try {
      const imported = parseLabelFile(await file.text(), file.name);
      this.applyImportedLabels(imported.records, imported.skipped, undefined, imported.format);
    } catch (e) {
      this.labelTransferMessage = e instanceof Error ? e.message : String(e);
    }
    this.cd.markForCheck();
  }

  private labelImportFormatName(format: LabelImportFormat): string {
    return format === 'sparrow-transactions-csv' ? 'Sparrow transaction CSV' : 'BIP-329 JSONL';
  }

  private applyImportedLabels(
    records: Bip329Label[],
    skipped = 0,
    targetWallet?: WatchWallet,
    format: LabelImportFormat = 'bip329',
  ): void {
    const byWallet = new Map<string, { wallet: WatchWallet; records: Bip329Label[] }>();
    let applied = 0;
    for (const record of records) {
      const wallets = targetWallet
        ? (this.walletOwns(targetWallet, record.type, record.ref) ? [targetWallet] : [])
        : this.walletsOwning(record.type, record.ref);
      for (const wallet of wallets) {
        const identity = wallet.network + ':' + wallet.descriptor;
        const entry = byWallet.get(identity) ?? { wallet, records: [] };
        entry.records.push(record);
        byWallet.set(identity, entry);
        applied++;
      }
    }
    byWallet.forEach(({ wallet, records: walletRecords }) => {
      this.labels.merge(wallet, walletRecords);
    });
    this.txLabelsDirty = true;
    this.labelContextsDirty = true;
    this.syncGraphPresentation();
    const summary = applied
      ? 'Imported ' + records.length + ' labels from ' + this.labelImportFormatName(format)
        + ' (' + applied + ' wallet matches).'
      : records.length
        ? 'No imported labels matched the loaded wallets.'
        : 'No supported labelled records were found.';
    this.labelTransferMessage = summary
      + (skipped ? ' Skipped ' + skipped + ' unsupported or unlabelled records.' : '');
  }

  exportLabels(): void {
    if (!this.wallet) {
      return;
    }
    const records = this.labels.list(this.wallet);
    const blob = new Blob([toJsonl(records) + (records.length ? '\n' : '')], {
      type: 'application/jsonl',
    });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = this.wallet.label.replace(/[^a-z0-9_-]+/gi, '-') + '-labels.jsonl';
    link.click();
    URL.revokeObjectURL(url);
    this.exportTransferMessage = 'Exported ' + records.length + ' labels as BIP-329 JSONL.';
    this.cd.markForCheck();
  }

  private download(contents: string, filename: string, type: string): void {
    const url = URL.createObjectURL(new Blob([contents], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  get fileStem(): string {
    return (this.wallet?.label || 'watch-wallet').replace(/[^a-z0-9_-]+/gi, '-');
  }

  exportDescriptor(): void {
    if (!this.wallet?.descriptor) return;
    this.download(this.wallet.descriptor + '\n', this.fileStem + '-descriptor.txt', 'text/plain');
    this.exportTransferMessage = 'Exported public output descriptor.';
  }

  exportSparrow(): void {
    if (!this.wallet?.descriptor) return;
    this.download(sparrowExport(this.wallet), this.fileStem + '-sparrow.json', 'application/json');
    this.exportTransferMessage = 'Exported watch-only Sparrow-compatible JSON.';
  }

  private csv(rows: Array<Array<string | number | boolean | undefined>>): string {
    return rows.map((row) => row.map((value) => {
      const cell = value == null ? '' : String(value);
      return /[",\r\n]/.test(cell) ? '"' + cell.replace(/"/g, '""') + '"' : cell;
    }).join(',')).join('\r\n') + '\r\n';
  }

  exportUtxosCsv(): void {
    if (!this.wallet) return;
    const rows: Array<Array<string | number | boolean | undefined>> = [
      ['txid', 'vout', 'address', 'derivation', 'value', 'confirmed', 'frozen', 'label'],
    ];
    for (const utxo of this.utxos) {
      rows.push([utxo.txid, utxo.vout, utxo.address, this.derivationPath(utxo), utxo.value,
        utxo.confirmed, this.isFrozen(utxo), this.labelFor('output', this.outpoint(utxo))]);
    }
    this.download(this.csv(rows), this.fileStem + '-utxos.csv', 'text/csv');
    this.exportTransferMessage = 'Exported ' + this.utxos.length + ' UTXOs as CSV.';
    this.cd.markForCheck();
  }

  exportTransactionsCsv(): void {
    if (!this.wallet) return;
    const rows: Array<Array<string | number | boolean | undefined>> = [['txid', 'height', 'time', 'net value', 'label']];
    for (const tx of this.transactions) {
      rows.push([tx.txid, tx.status?.block_height, tx.status?.block_time,
        this.walletService.netValue(tx), this.labelFor('tx', tx.txid)]);
    }
    this.download(this.csv(rows), this.fileStem + '-transactions.csv', 'text/csv');
    this.exportTransferMessage = 'Exported ' + this.transactions.length + ' transactions as CSV.';
    this.cd.markForCheck();
  }

  /**
   * The script type the import will end up with, guessed from what has been pasted so far.
   *
   * The real answer comes back from the WASM `prepare()` call. The prefix is enough for
   * the import preview; only a bare xpub/tpub is genuinely ambiguous, which is the case
   * where we ask for the type explicitly.
   */
  private get effectiveScriptType(): ScriptType {
    const input = this.keyInput.trim().toLowerCase();

    if (looksLikeDescriptor(input)) {
      if (input.startsWith('tr(')) {
        return 'tr';
      }
      if (input.startsWith('sh(wsh(')) return 'sh_wsh';
      if (input.startsWith('wsh(')) return 'wsh';
      if (input.startsWith('wpkh(')) return 'wpkh';
      if (input.startsWith('sh(')) {
        return 'sh_wpkh';
      }
      if (input.startsWith('pkh(')) {
        return 'pkh';
      }
      return 'pkh'; // Unknown script: assume the oldest possible, i.e. scan furthest back.
    }

    // SLIP-132 prefixes encode the type; xpub/tpub do not, which is why we ask.
    if (input.startsWith('zpub') || input.startsWith('vpub')) {
      return 'wpkh';
    }
    if (input.startsWith('ypub') || input.startsWith('upub')) {
      return 'sh_wpkh';
    }
    return this.scriptTypeHint;
  }

  /** The human name of the address type inferred from the pasted key/descriptor, e.g.
   *  "Taproot" — shown read-only for a descriptor (which encodes its own type). */
  get importScriptTypeName(): string {
    return describeScriptType(this.effectiveScriptType).name;
  }

  /** A bare xpub does not say which script type it is. Everything else does. */
  get needsScriptTypeHint(): boolean {
    const input = this.keyInput.trim();
    return input.startsWith('xpub') || input.startsWith('tpub');
  }

  get isDescriptorInput(): boolean {
    return looksLikeDescriptor(this.keyInput);
  }

  /** Update the import preview as the extended public key or descriptor changes. */
  onKeyInput(): void {
    this.cd.markForCheck();
  }

  /** A short label describing what the primary input currently holds. */
  get detectedInputLabel(): string {
    if (!this.keyInput.trim()) {
      return '';
    }
    if (this.isDescriptorInput) {
      return `${this.importScriptTypeName} · ${$localize`:@@watch.from-descriptor:from descriptor`}`;
    }
    if (this.needsScriptTypeHint) {
      return $localize`:@@watch.detected-xpub:Extended public key`;
    }
    return this.importScriptTypeName;
  }

  async import(): Promise<void> {
    if (this.scanning || !this.keyInput.trim()) {
      return;
    }
    if (!this.network) {
      // Should be unreachable, but a wallet page that does nothing when you click Import is
      // the worst possible failure. Say something rather than swallow it.
      this.error = $localize`:@@watch.no-network:Could not determine which network you are on.`;
      this.cd.markForCheck();
      return;
    }
    const generation = ++this.scanGeneration;
    const importNetwork = this.network;
    const input = this.keyInput.trim();
    const scriptTypeHint = this.needsScriptTypeHint ? this.scriptTypeHint : undefined;
    const importLabel = this.label.trim() || 'My wallet';
    this.scanning = true;
    this.error = null;
    this.truncated = false;
    this.cd.markForCheck();

    try {
      const gapLimit = Number(this.gapLimit);
      if (!Number.isInteger(gapLimit) || gapLimit < 5 || gapLimit > 1000) {
        throw new Error('Gap limit must be a whole number from 5 to 1000.');
      }
      this.gapLimit = gapLimit;
      const prepared = await this.derivation.prepare(
        input,
        importNetwork,
        scriptTypeHint,
      );
      if (generation !== this.scanGeneration) return;
      const identity = {
        fingerprint: prepared.fingerprint,
        fingerprintIsMaster: prepared.fingerprintIsMaster,
        originPath: prepared.originPath,
        signingOriginsComplete: prepared.signingOriginsComplete,
      };
      const source = input;

      const { wallet, txs, truncated } = await this.scanner.scan({
        descriptor: prepared.descriptor,
        scriptType: prepared.scriptType,
        network: importNetwork,
        gapLimit,
        source,
        label: importLabel,
        identity,
        onProgress: (p) => {
          if (generation === this.scanGeneration) {
            this.progress = p;
            this.cd.markForCheck();
          }
        }
      });
      if (generation !== this.scanGeneration) return;
      this.storage.save(wallet);
      this.applyWallet(wallet, txs, truncated);

      if (this.pendingLabelImport) {
        const attachedLabels = this.pendingLabelImport;
        this.applyImportedLabels(
          attachedLabels.records,
          attachedLabels.skipped,
          wallet,
          attachedLabels.format,
        );
        this.pendingLabelImport = null;
        this.pendingLabelFileName = '';
        this.pendingLabelFileMessage = '';
      }

      this.keyInput = '';
    } catch (e) {
      if (generation === this.scanGeneration) this.error = e instanceof Error ? e.message : String(e);
    } finally {
      if (generation === this.scanGeneration) {
        this.scanning = false;
        this.initialWalletLoading = false;
        this.progress = null;
        this.cd.markForCheck();
      }
    }
  }

  /**
   * Re-scan a wallet we already have. Needs the derivation engine again (to extend the
   * gap limit), which is why `source` is persisted.
   */
  async refresh(expectedGeneration?: number): Promise<void> {
    if (this.viewingAll) {
      return this.refreshAll();
    }
    if (!this.wallet || !this.network || this.scanning) {
      return;
    }

    const generation = expectedGeneration ?? ++this.scanGeneration;
    if (expectedGeneration != null && generation !== this.scanGeneration) return;
    this.scanning = true;
    this.send.invalidateSendDraft();
    this.error = null;
    this.cd.markForCheck();

    const activeWallet = this.wallet;
    try {
      const { wallet, txs, truncated } = await this.scanSavedWallet(activeWallet, (p) => {
        if (generation === this.scanGeneration) {
          this.progress = p;
          this.cd.markForCheck();
        }
      });
      if (generation !== this.scanGeneration) return;
      this.storage.save(wallet);
      this.applyWallet(wallet, txs, truncated);
    } catch (e) {
      if (generation === this.scanGeneration) this.error = e instanceof Error ? e.message : String(e);
    } finally {
      if (generation === this.scanGeneration) {
        this.scanning = false;
        this.initialWalletLoading = false;
        this.progress = null;
        this.cd.markForCheck();
      }
    }
  }

  private applyWallet(wallet: WatchWallet, txs: Transaction[], truncated = false): void {
    this.send.invalidateSendDraft();
    this.walletService.setActive(wallet);

    const view = this.walletService.buildView(wallet, txs);
    this.wallet = wallet;
    this.transactions = txs;
    this.addressStrings = wallet.addresses.map((a) => a.address);
    this.utxos = view.utxos;
    this.balance = view.balance;
    this.lastUsed = view.lastUsed;
    this.truncated = truncated;
    this.walletSummary$.next(view.summary);

    this.syncDisplayPreferences();
    this.startTracking();
    this.registerActiveWallet();
  }

  /**
   * Fold the just-shown wallet into the multi-wallet set: add it to the list if new, refresh
   * the site-wide merged address map, and cache its computed view so switching back is instant.
   */
  private registerActiveWallet(): void {
    if (!this.wallet) {
      return;
    }
    const idx = this.wallets.findIndex((w) => w.id === this.wallet.id);
    if (idx >= 0) {
      this.wallets[idx] = this.wallet;
    } else {
      this.wallets = [...this.wallets, this.wallet];
    }
    this.adding = false;
    this.walletService.syncWallets(this.wallets);
    this.stashActiveView();
  }

  /** Live tracking over the websocket, limited to the addresses that need to be live. */
  private startTracking(): void {
    if (!this.wallet) {
      this.tracker.stop();
      return;
    }
    this.tracker.start(
      this.wallet,
      this.utxos,
      { ...this.lastUsed, 0: Math.max(this.lastUsed[0], this.receiveIndex - 1) },
      (fresh) => this.mergeTransactions(fresh),
      () => this.refresh(),
    );
    this.liveTrackingDegraded = this.tracker.degraded;
  }

  /** Merge websocket-delivered transactions into the wallet and recompute, deduping by txid. */
  private mergeTransactions(fresh: Transaction[]): void {
    if (!this.wallet) {
      return;
    }
    const byId = new Map(this.transactions.map((tx) => [tx.txid, tx]));
    let changed = false;
    for (const tx of fresh) {
      const existing = byId.get(tx.txid);
      // A tx we already have can still change: it confirms.
      if (!existing || (!existing.status?.confirmed && tx.status?.confirmed)) {
        byId.set(tx.txid, tx);
        changed = true;
      }
    }
    if (!changed) {
      return;
    }
    this.send.invalidateSendDraft();
    this.transactions = [...byId.values()];
    const view = this.walletService.buildView(this.wallet, this.transactions);
    this.utxos = view.utxos;
    this.balance = view.balance;
    this.lastUsed = view.lastUsed;
    this.walletSummary$.next(view.summary);
    this.syncDisplayPreferences();
    this.liveTrackingDegraded = this.tracker.degraded;
    this.cd.markForCheck();
  }

  /** Remove only the active wallet; keep the others and activate one of them. */
  forget(): void {
    if (!this.wallet) {
      return;
    }
    this.tracker.stop();
    const removedId = this.wallet.id;
    this.labels.clear(this.wallet);
    this.localState.clear(this.wallet);
    this.storage.remove(removedId);
    this.views.delete(removedId);
    this.wallets = this.wallets.filter((w) => w.id !== removedId);
    this.walletService.syncWallets(this.wallets);

    this.reset();

    if (this.wallets.length) {
      // Show another wallet rather than dropping the user back to an empty import form.
      this.activate(this.wallets[0]);
    } else {
      this.walletService.setActive(null);
      this.adding = false;
      this.resetImportForm();
    }
    this.cd.markForCheck();
  }

  /** Clear just the import-form inputs, leaving the wallet list and dashboard untouched. */
  private resetImportForm(): void {
    this.keyInput = '';
    this.label = 'My wallet';
    this.walletFileMessage = '';
    this.pendingLabelImport = null;
    this.pendingLabelFileName = '';
    this.pendingLabelFileMessage = '';
    this.error = null;
    this.progress = null;
  }

  private reset(): void {
    this.wallet = null;
    this.send.resetSendFlow();
    this.viewingAll = false;
    this.transactions = [];
    this.utxos = [];
    this.addressStrings = [];
    this.balance = { confirmed: 0, pending: 0, total: 0 };
    this.lastUsed = { 0: -1, 1: -1 };
    this.walletSummary$.next([]);
    this.showDetails = false;
    this.receiveIndex = 0;
    this.labelEditor = null;
    this.labelTransferMessage = '';
    this.walletFileMessage = '';
    this.exportTransferMessage = '';
    this.selectedLabelTxid = '';
    this.addressChainFilter = 'all';
    this.addressStatusFilter = 'all';
    this.addressBalanceFilter = 'all';
    this.addressBalanceSort = 'none';
    this.highlightedAddress = '';
    this.showAddressDerivationPath = false;
    this.descriptorOriginAcknowledged = false;
    this.initialWalletLoading = false;
    this.settingsGapLimit = 20;
    this.error = null;
    this.truncated = false;
  }

  /** e.g. "Native SegWit" — far more legible than the raw 'wpkh'. */
  get scriptTypeName(): string {
    return this.wallet ? describeScriptType(this.wallet.scriptType).name : '';
  }

  /** e.g. "P2WPKH". */
  get scriptTypeCode(): string {
    return this.wallet ? describeScriptType(this.wallet.scriptType).code : '';
  }

  /**
   * The real derivation path when a descriptor told us, otherwise the BIP-standard path for
   * this script type. Never invent one for a multisig/script descriptor, which has no
   * single standard path.
   */
  get derivationPathLabel(): string | null {
    if (!this.wallet) {
      return null;
    }
    return this.wallet.originPath ?? describeScriptType(this.wallet.scriptType).path ?? null;
  }

  /** The next scanned-but-unused receive address, respecting a manually advanced cursor. */
  get currentReceiveAddress(): DerivedAddress | null {
    if (!this.wallet) {
      return null;
    }
    return this.wallet.addresses.find(
      (address) => address.chain === 0 && address.index === this.receiveIndex,
    ) ?? null;
  }

  get upcomingReceiveAddresses(): DerivedAddress[] {
    if (!this.wallet) {
      return [];
    }
    return this.wallet.addresses
      .filter((address) => address.chain === 0 && address.index > this.receiveIndex)
      .sort((a, b) => a.index - b.index)
      .slice(0, 4);
  }

  advanceReceiveAddress(): void {
    const next = this.upcomingReceiveAddresses[0];
    if (!this.wallet || !next) {
      return;
    }
    this.receiveIndex = next.index;
    this.localState.setReceiveIndex(this.wallet, next.index);
    this.startTracking();
    this.cd.markForCheck();
  }

  receiveDerivationPath(address: DerivedAddress): string {
    return this.walletService.derivationPath(address.address) ?? '';
  }

  openWalletTab(tab: WatchTab): void {
    this.activeTab = tab;
    this.cd.markForCheck();
  }

  openWalletAddress(address: string): void {
    if (!address || !this.wallet?.addresses.some((candidate) => candidate.address === address)) return;
    this.highlightedAddress = address;
    this.addressChainFilter = 'all';
    this.addressStatusFilter = 'all';
    this.addressBalanceFilter = 'all';
    this.activeTab = 'addresses';
    this.cd.markForCheck();
    if (this.stateService.isBrowser) {
      setTimeout(() => {
        const row = document.getElementById('wallet-address-' + address);
        row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        row?.focus({ preventScroll: true });
      });
    }
  }

  transactionNetValue(tx: Transaction): number {
    return this.walletService.netValue(tx);
  }

  get recentTransactions(): Transaction[] {
    return this.transactions.slice(0, 5);
  }

  get recentTransactionValues(): Record<string, number> {
    return Object.fromEntries(this.recentTransactions.map((tx) => [tx.txid, this.transactionNetValue(tx)]));
  }

  cycleAddressStatusFilter(): void {
    this.addressStatusFilter = this.addressStatusFilter === 'all'
      ? 'unused'
      : (this.addressStatusFilter === 'unused' ? 'used' : 'all');
  }

  cycleAddressBalanceFilter(): void {
    this.addressBalanceFilter = this.addressBalanceFilter === 'all' ? 'positive' : 'all';
  }

  cycleAddressBalanceSort(): void {
    this.addressBalanceSort = this.addressBalanceSort === 'desc' ? 'asc' : 'desc';
  }

  absoluteSats(value: number): number {
    return Math.abs(value);
  }

  get walletLoadingTitle(): string {
    switch (this.progress?.phase) {
      case 'deriving': return `Deriving ${this.progress.chain === 1 ? 'change' : 'receive'} addresses`;
      case 'fetching': return `Checking ${this.progress.chain === 1 ? 'change' : 'receive'} address history`;
      case 'finalizing': return 'Calculating wallet state';
      case 'done': return 'Wallet state ready';
      default: return 'Preparing wallet scan';
    }
  }

  setInlineLabel(type: Bip329LabelType, ref: string, label: string): void {
    const owners = this.viewingAll ? this.walletsOwning(type, ref) : (this.wallet ? [this.wallet] : []);
    for (const wallet of owners) {
      this.labels.set(wallet, type, ref, label);
    }
    if (type === 'tx') {
      this.txLabelsDirty = true;
    }
    this.labelContextsDirty = true;
    this.syncGraphPresentation();
    this.cd.markForCheck();
  }

  setUtxoLabelDraft(ref: string, label: string): void {
    this.graphUtxoLabels = { ...this.graphUtxoLabels, [ref]: label };
    this.cd.markForCheck();
  }

  setUtxoLabelFocus(ref: string, focused: boolean): void {
    const slots = new Set(this.graphLabelSlots);
    if (focused) {
      slots.add(ref);
    } else {
      slots.delete(ref);
    }
    this.graphLabelSlots = slots;
    if (!focused) {
      this.syncGraphPresentation();
    }
    this.cd.markForCheck();
  }

  setShowAddressDerivationPath(show: boolean): void {
    if (!this.wallet) return;
    this.showAddressDerivationPath = show;
    this.localState.setShowAddressDerivationPath(this.wallet, show);
  }

  acknowledgeDescriptorOrigin(): void {
    if (!this.wallet) return;
    this.descriptorOriginAcknowledged = true;
    this.localState.setDescriptorOriginAcknowledged(this.wallet, true);
    this.cd.markForCheck();
  }

  private addressRows(): AddressExplorerRow[] {
    if (!this.wallet) return [];
    if (this.explorerWallet !== this.wallet || this.explorerTransactions !== this.transactions
      || this.explorerUtxos !== this.utxos) {
      const balances = new Map<string, number>();
      this.utxos.forEach((utxo) => balances.set(utxo.address, (balances.get(utxo.address) ?? 0) + utxo.value));
      const used = new Set<string>();
      const mine = new Set(this.wallet.addresses.map((item) => item.address));
      for (const tx of this.transactions) {
        tx.vin?.forEach((vin) => {
          const address = vin.prevout?.scriptpubkey_address;
          if (address && mine.has(address)) used.add(address);
        });
        tx.vout?.forEach((vout) => {
          const address = vout.scriptpubkey_address;
          if (address && mine.has(address)) used.add(address);
        });
      }
      this.explorerRows = this.wallet.addresses.map((derived) => ({
        derived,
        balance: balances.get(derived.address) ?? 0,
        used: used.has(derived.address),
        path: this.walletService.derivationPath(derived.address) ?? `${derived.chain}/${derived.index}`,
      }));
      this.explorerWallet = this.wallet;
      this.explorerTransactions = this.transactions;
      this.explorerUtxos = this.utxos;
    }
    return this.explorerRows;
  }

  get addressStats(): { total: number; used: number; withBalance: number } {
    const rows = this.addressRows();
    return {
      total: rows.length,
      used: rows.filter((row) => row.used).length,
      withBalance: rows.filter((row) => row.balance > 0).length,
    };
  }

  get visibleAddressRows(): AddressExplorerRow[] {
    const rows = this.addressRows().filter((row) =>
      (this.addressBalanceFilter === 'all' || row.balance !== 0)
      && (this.addressStatusFilter === 'all'
        || (this.addressStatusFilter === 'used' ? row.used : !row.used))
      && (this.addressChainFilter === 'all' || row.derived.chain === (this.addressChainFilter === 'receive' ? 0 : 1))
    );
    if (this.addressBalanceSort === 'none') return rows;
    const direction = this.addressBalanceSort === 'desc' ? -1 : 1;
    return [...rows].sort((a, b) => direction * (a.balance - b.balance));
  }
  derivationPath(utxo: WalletUtxo): string {
    return this.walletService.derivationPath(utxo.address) ?? '';
  }

  outpoint(utxo: Pick<WalletUtxo, 'txid' | 'vout'>): string {
    return utxo.txid + ':' + utxo.vout;
  }

  isFrozen(utxo: WalletUtxo): boolean {
    const ref = this.outpoint(utxo);
    const owners = this.viewingAll
      ? this.walletsOwning('output', ref)
      : (this.wallet ? [this.wallet] : []);
    return owners.some((wallet) => this.localState.isFrozen(wallet, ref));
  }

  toggleFrozen(utxo: WalletUtxo): void {
    const ref = this.outpoint(utxo);
    const owners = this.viewingAll
      ? this.walletsOwning('output', ref)
      : (this.wallet ? [this.wallet] : []);
    const frozen = !owners.some((wallet) => this.localState.isFrozen(wallet, ref));
    owners.forEach((wallet) => this.localState.setFrozen(wallet, ref, frozen));
    this.send.syncSendCoinSelection();
    this.syncGraphPresentation();
    this.cd.markForCheck();
  }

  private syncGraphPresentation(): void {
    this.graphFrozenOutpoints = new Set(
      this.utxos.filter((utxo) => this.isFrozen(utxo)).map((utxo) => this.outpoint(utxo)),
    );
    this.graphUtxoLabels = Object.fromEntries(this.utxos.map((utxo) => [
      this.outpoint(utxo), this.utxoDisplayLabel(utxo),
    ]));
    this.graphUtxoLabelDetails = Object.fromEntries(this.utxos.map((utxo) => [
      this.outpoint(utxo), [
        this.labelFor('tx', utxo.txid) ? 'Transaction: ' + this.labelFor('tx', utxo.txid) : '',
        this.labelFor('addr', utxo.address) ? 'Address: ' + this.labelFor('addr', utxo.address) : '',
      ].filter((label): label is string => !!label),
    ]));
  }

  get frozenTotal(): number {
    return this.utxos.filter((utxo) => this.isFrozen(utxo))
      .reduce((sum, utxo) => sum + utxo.value, 0);
  }

  get hasFrozenUtxos(): boolean {
    return this.frozenTotal > 0;
  }

  get spendableBalance(): number {
    return this.balance.total - this.frozenTotal;
  }

  /**
   * The wallet's UTXOs shaped for <app-utxo-graph>. The conversion itself lives in
   * WalletService, so here we only memoise it on the utxos array
   * reference — the OnPush graph re-packs its circles whenever its @Input changes identity.
   */
  get graphUtxos(): Utxo[] {
    if (this.graphUtxosSource !== this.utxos) {
      this.graphUtxosSource = this.utxos;
      this.graphUtxosCache = this.walletService.utxosForGraph(
        this.utxos, this.transactions, this.stateService.latestBlockHeight,
      );
    }
    return this.graphUtxosCache;
  }

  trackByUtxo(_: number, utxo: WalletUtxo): string {
    return `${utxo.txid}:${utxo.vout}`;
  }

  trackByAddress(_: number, row: AddressExplorerRow): string {
    return row.derived.address;
  }

  private updateAccelerationSubscription(): void {
    if (this.stateService.env.ACCELERATOR_BUTTON && this.stateService.network === '') {
      if (this.accelerationsSubscription) return;
      this.websocketService.ensureTrackAccelerations();
      this.acceleratedTxids = new Set();
      this.accelerationsSubscription = this.stateService.accelerations$.subscribe((delta) => {
        if (!this.acceleratedTxids) this.acceleratedTxids = new Set();
        if (delta.reset) this.acceleratedTxids.clear();
        else for (const txid of delta.removed) this.acceleratedTxids.delete(txid);
        for (const acceleration of delta.added) this.acceleratedTxids.add(acceleration.txid);
        this.cd.markForCheck();
      });
    } else {
      this.accelerationsSubscription?.unsubscribe();
      this.accelerationsSubscription = null;
      this.acceleratedTxids = null;
    }
  }

  ngOnDestroy(): void {
    this.send.destroy();
    this.tracker.stop();
    this.subscription.unsubscribe();
    this.accelerationsSubscription?.unsubscribe();
    this.websocketService.stopTrackAccelerations();
  }
}
