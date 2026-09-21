import { Component, OnInit, OnDestroy, ChangeDetectorRef, ChangeDetectionStrategy, ViewChild, ElementRef } from '@angular/core';
import { BehaviorSubject, Subscription, merge, of } from 'rxjs';
import { distinctUntilChanged } from 'rxjs/operators';
import { StateService } from '@app/services/state.service';
import { SeoService } from '@app/services/seo.service';
import { ApiService } from '@app/services/api.service';
import { addressToScriptPubKey } from '@app/shared/transaction.utils';
import { decodeRawTransaction, serializeTransaction, uint8ArrayToHexString } from '@app/shared/transaction.utils';
import { AddressTxSummary, Transaction, Utxo } from '@interfaces/electrs.interface';
import { WalletService } from './services/wallet.service';
import { WalletScannerService, ScanProgress } from './services/wallet-scanner.service';
import {
  WalletLabelsService,
  WalletLocalStateService,
  WalletStorageService,
} from './services/wallet-storage.service';
import { DerivationService } from './services/derivation.service';
import { WalletTrackerService } from './services/wallet-tracker.service';
import { describeScriptType, fromMempoolNetwork, looksLikeDescriptor } from './watch-key.utils';
import {
  base64ToBytes,
  bytesToHex,
  normalizePsbtText,
  parseBitcoinRecipient,
  PsbtBuildResult,
  PsbtBuildUtxo,
} from './psbt.utils';
import {
  AnimatedPsbtQrDecoder,
  encodeBbqrPsbt,
  encodeUrPsbt,
  PsbtQrDecodeProgress,
  PsbtQrEncoding,
  PsbtQrFrames,
} from './psbt-qr.utils';
import { parseWalletFile, sparrowExport } from './wallet-file.utils';
import type { WatchSectionAction } from './components/watch-section.types';
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

/** One wallet's fully-computed display state, cached so switching wallets is instant. */
interface WalletView {
  wallet: WatchWallet;
  transactions: Transaction[];
  utxos: WalletUtxo[];
  balance: WalletBalance;
  lastUsed: Record<0 | 1, number>;
  summary: AddressTxSummary[];
  truncated: boolean;
  liveTrackingDegraded: boolean;
}

interface LabelEditor {
  type: Bip329LabelType;
  ref: string;
  walletIds: string[];
  draft: string;
}

interface AddressExplorerRow {
  derived: DerivedAddress;
  balance: number;
  used: boolean;
  path: string;
}


interface SendRecipientRow {
  target: string;
  amountBtc: string;
}

interface SignedTransactionPreview {
  tx: Transaction;
  rawHex: string;
  inputs: Array<{ txid: string; vout: number; address?: string; value: number }>;
  outputs: Array<{ address?: string; value: number; script: string }>;
  fee: number;
  vsize: number;
  feeRate: number;
}
@Component({
  selector: 'app-watch',
  templateUrl: './watch.component.html',
  styleUrls: ['./watch.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false,
})
export class WatchComponent implements OnInit, OnDestroy {
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
  /** The descriptor embeds the extended public key, so don't put it on screen by default. */
  showDescriptor = false;
  activeTab: 'overview' | 'transactions' | 'utxos' | 'addresses' | 'send' | 'settings' = 'overview';

  /** Receive addresses are already derived and scanned; this cursor lets the user skip one. */
  receiveIndex = 0;
  showUpcomingReceive = false;
  showReceiveDetails = false;

  labelEditor: LabelEditor | null = null;
  labelTransferMessage = '';
  walletFileMessage = '';
  selectedLabelTxid = '';

  /** Cache backing txLabelMap: rebuilt when the transactions change or a label is edited. */
  private txLabelSource: Transaction[] | null = null;
  private txLabelsDirty = false;
  private txLabelMapCache: Record<string, string> = {};

  addressChainFilter: 'all' | 'receive' | 'change' = 'all';
  hideEmptyAddresses = false;
  private explorerWallet: WatchWallet | null = null;
  private explorerTransactions: Transaction[] | null = null;
  private explorerUtxos: WalletUtxo[] | null = null;
  private explorerRows: AddressExplorerRow[] = [];

  /** Inline rename in the dashboard header. `labelDraft` is the in-progress edit. */
  editingLabel = false;
  labelDraft = '';
  @ViewChild('renameInput') renameInput?: ElementRef<HTMLInputElement>;

  scanning = false;
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

  // ── experimental send / external-signer PSBT flow ──
  sendRecipients: SendRecipientRow[] = [{ target: '', amountBtc: '' }];
  sendMax = false;
  sendFeeRate = 1;
  sendManualCoins = false;
  sendSelectedOutpoints = new Set<string>();
  sendRbf = true;
  sendLocktime = 0;
  sendOpReturn = '';
  psbtBuilding = false;
  psbtError = '';
  builtPsbt: PsbtBuildResult | null = null;
  signedPsbtInput = '';
  signedPreview: SignedTransactionPreview | null = null;
  broadcastConfirmed = false;
  broadcasting = false;
  broadcastError = '';
  broadcastTxid = '';

  // Animated QR export stays deterministic: the same finite fountain sequence loops until
  // the signer has enough parts. Reduced-motion users start paused and can advance manually.
  psbtQrExportVisible = false;
  psbtQrEncoding: PsbtQrEncoding = 'ur';
  psbtQrExport: PsbtQrFrames | null = null;
  psbtQrFrameIndex = 0;
  psbtQrPlaying = false;
  psbtQrFps = 4;
  psbtQrReducedMotion = false;
  private psbtQrTimer: number | null = null;

  @ViewChild('psbtQrVideo') psbtQrVideo?: ElementRef<HTMLVideoElement>;
  psbtQrScanning = false;
  psbtQrScanError = '';
  psbtQrScanProgress: PsbtQrDecodeProgress | null = null;
  private psbtQrDecoder = new AnimatedPsbtQrDecoder();
  private psbtQrScanner: { start(): Promise<void>; stop(): void; destroy(): void } | null = null;

  private subscription = new Subscription();

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
    private cd: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.seoService.setTitle($localize`:@@watch.title:Watch-only wallet`);

    this.subscription.add(this.stateService.recommendedFees$.subscribe((fees) => {
      if (!this.builtPsbt) this.sendFeeRate = fees.halfHourFee;
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
      const mapped = fromMempoolNetwork(network);
      this.network = mapped;
      this.networkUnsupported = mapped === null;
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

  /** Typed presentation model shared with the tab components; wallet state still lives here. */
  get sectionModel(): WatchComponent {
    return this;
  }

  /** Route a presentation event back to the existing shell method without duplicating logic. */
  handleSectionAction(action: WatchSectionAction): void {
    const handler = (this as unknown as Record<string, (...args: unknown[]) => unknown>)[action.name];
    if (typeof handler === 'function') {
      handler.apply(this, action.args ?? []);
    }
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
    this.walletService.setActive(wallet);

    if (this.views.has(wallet.id)) {
      this.showView(wallet.id);
      this.cd.markForCheck();
      return;
    }

    this.applyWallet(wallet, []);
    await this.refresh();
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
    this.walletService.setActive(null);
    this.cd.markForCheck();

    const toLoad = this.wallets.filter((w) => !this.views.has(w.id));
    if (toLoad.length) {
      this.scanning = true;
      this.cd.markForCheck();
      try {
        for (const w of toLoad) {
          await this.loadViewFor(w);
        }
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
      } finally {
        this.scanning = false;
      }
    }

    this.applyAggregate();
    this.cd.markForCheck();
  }

  /** Load one wallet's view into the cache without disturbing what is on screen. */
  private async loadViewFor(wallet: WatchWallet): Promise<void> {
    if (this.views.has(wallet.id)) {
      return;
    }
    const { wallet: scanned, txs } = await this.scanner.scan(
      wallet.descriptor,
      wallet.scriptType,
      wallet.network,
      wallet.gapLimit,
      wallet.source,
      wallet.label,
      {
        fingerprint: wallet.fingerprint,
        fingerprintIsMaster: wallet.fingerprintIsMaster,
        originPath: wallet.originPath,
      },
      () => {},
    );
    this.storage.save(scanned);
    const view = this.walletService.buildView(scanned, txs);
    this.views.set(scanned.id, {
      wallet: scanned,
      transactions: txs,
      utxos: view.utxos,
      balance: view.balance,
      lastUsed: view.lastUsed,
      summary: view.summary,
      truncated: false,
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

    const balance: WalletBalance = { confirmed: 0, pending: 0, total: 0 };
    for (const v of views) {
      balance.confirmed += v.balance.confirmed;
      balance.pending += v.balance.pending;
      balance.total += v.balance.total;
    }
    this.balance = balance;

    // Union of UTXOs, deduped by outpoint (two wallets could derive a shared address).
    const utxosByOutpoint = new Map<string, WalletUtxo>();
    for (const v of views) {
      for (const u of v.utxos) {
        utxosByOutpoint.set(`${u.txid}:${u.vout}`, u);
      }
    }
    this.utxos = [...utxosByOutpoint.values()];

    // Union of transactions, deduped by txid (one tx can touch two of the user's wallets).
    const txById = new Map<string, Transaction>();
    for (const v of views) {
      for (const tx of v.transactions) {
        txById.set(tx.txid, tx);
      }
    }
    this.transactions = [...txById.values()];

    // Balance history = each tx's net effect summed across wallets, so a transfer between two
    // of the user's own wallets nets to ~0 rather than showing as a spend and a matching receive.
    const summaryByTxid = new Map<string, AddressTxSummary>();
    for (const v of views) {
      for (const s of v.summary) {
        const existing = summaryByTxid.get(s.txid);
        if (existing) {
          existing.value += s.value;
        } else {
          summaryByTxid.set(s.txid, { ...s });
        }
      }
    }
    this.walletSummary$.next([...summaryByTxid.values()].sort((a, b) => b.height - a.height));

    // Site-wide highlighting already recognises every wallet (mergedMap); give the tx list the
    // union of addresses so it highlights all of them.
    this.addressStrings = this.wallets.flatMap((w) => w.addresses.map((a) => a.address));
    this.walletService.setTransactions(this.transactions);
    this.syncDisplayPreferences();

    // Per-wallet-only state has no meaning for the aggregate.
    this.lastUsed = { 0: -1, 1: -1 };
    this.truncated = false;
    this.liveTrackingDegraded = false;
  }

  /** Reload every included wallet and rebuild the aggregate (the Refresh button in All mode). */
  private async refreshAll(): Promise<void> {
    if (this.scanning) {
      return;
    }
    this.scanning = true;
    this.error = null;
    this.cd.markForCheck();
    try {
      for (const w of this.wallets) {
        this.views.delete(w.id);
        await this.loadViewFor(w);
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.scanning = false;
    }
    this.applyAggregate();
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
    this.resetSendFlow();
    const v = this.views.get(id);
    if (!v) {
      return;
    }
    this.tracker.stop();
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
    this.walletService.setTransactions(v.transactions);
    this.syncDisplayPreferences();
    this.startTracking();
  }

  private syncDisplayPreferences(): void {
    this.labelEditor = null;
    this.selectedLabelTxid = this.transactions.some((tx) => tx.txid === this.selectedLabelTxid)
      ? this.selectedLabelTxid
      : (this.transactions[0]?.txid ?? '');
    if (!this.wallet) {
      this.receiveIndex = 0;
      return;
    }

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
    if (!file) return;
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

  // ── BIP-329 labels ──

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

  /** Persist a transaction label edited inline (the pencil next to a txid in the list). */
  setTxLabel(txid: string, label: string): void {
    const owners = this.viewingAll
      ? this.walletsOwning('tx', txid)
      : (this.wallet ? [this.wallet] : []);
    for (const wallet of owners) {
      this.labels.set(wallet, 'tx', txid, label);
    }
    this.txLabelsDirty = true;
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
      this.applyImportedLabels(this.labels.parseJsonl(await file.text()));
    } catch (e) {
      this.labelTransferMessage = e instanceof Error ? e.message : String(e);
    }
    this.cd.markForCheck();
  }

  private applyImportedLabels(records: Bip329Label[]): void {
    const byWallet = new Map<string, { wallet: WatchWallet; records: Bip329Label[] }>();
    let applied = 0;
    for (const record of records) {
      for (const wallet of this.walletsOwning(record.type, record.ref)) {
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
    this.labelTransferMessage = applied
      ? 'Imported ' + records.length + ' labels (' + applied + ' wallet matches).'
      : 'No imported labels matched the loaded wallets.';
  }

  exportLabels(): void {
    if (!this.wallet) {
      return;
    }
    const records = this.labels.list(this.wallet);
    const blob = new Blob([this.labels.toJsonl(records) + (records.length ? '\n' : '')], {
      type: 'application/jsonl',
    });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = this.wallet.label.replace(/[^a-z0-9_-]+/gi, '-') + '-labels.jsonl';
    link.click();
    URL.revokeObjectURL(url);
    this.labelTransferMessage = 'Exported ' + records.length + ' labels.';
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

  private get fileStem(): string {
    return (this.wallet?.label || 'watch-wallet').replace(/[^a-z0-9_-]+/gi, '-');
  }

  exportDescriptor(): void {
    if (!this.wallet?.descriptor) return;
    this.download(this.wallet.descriptor + '\n', this.fileStem + '-descriptor.txt', 'text/plain');
    this.walletFileMessage = 'Exported public output descriptor.';
  }

  exportSparrow(): void {
    if (!this.wallet?.descriptor) return;
    this.download(sparrowExport(this.wallet), this.fileStem + '-sparrow.json', 'application/json');
    this.walletFileMessage = 'Exported watch-only Sparrow-compatible JSON.';
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
  }

  exportTransactionsCsv(): void {
    if (!this.wallet) return;
    const rows: Array<Array<string | number | boolean | undefined>> = [['txid', 'height', 'time', 'net value', 'label']];
    for (const tx of this.transactions) {
      rows.push([tx.txid, tx.status?.block_height, tx.status?.block_time,
        this.walletService.netValue(tx), this.labelFor('tx', tx.txid)]);
    }
    this.download(this.csv(rows), this.fileStem + '-transactions.csv', 'text/csv');
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
    this.scanning = true;
    this.error = null;
    this.truncated = false;
    this.cd.markForCheck();

    try {
      const prepared = await this.derivation.prepare(
        this.keyInput,
        this.network,
        this.needsScriptTypeHint ? this.scriptTypeHint : undefined,
      );
      const identity = {
        fingerprint: prepared.fingerprint,
        fingerprintIsMaster: prepared.fingerprintIsMaster,
        originPath: prepared.originPath,
      };
      const source = this.keyInput.trim();
      const label = this.label.trim() || 'My wallet';

      const { wallet, txs, truncated } = await this.scanner.scan(
        prepared.descriptor,
        prepared.scriptType,
        this.network,
        this.gapLimit,
        source,
        label,
        identity,
        (p) => {
          this.progress = p;
          this.cd.markForCheck();
        },
      );
      this.storage.save(wallet);
      this.applyWallet(wallet, txs);
      this.truncated = truncated;

      this.keyInput = '';
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.scanning = false;
      this.progress = null;
      this.cd.markForCheck();
    }
  }

  /**
   * Re-scan a wallet we already have. Needs the derivation engine again (to extend the
   * gap limit), which is why `source` is persisted.
   */
  async refresh(): Promise<void> {
    if (this.viewingAll) {
      return this.refreshAll();
    }
    if (!this.wallet || !this.network || this.scanning) {
      return;
    }

    this.scanning = true;
    this.error = null;
    this.cd.markForCheck();

    const identity = {
      fingerprint: this.wallet.fingerprint,
      fingerprintIsMaster: this.wallet.fingerprintIsMaster,
      originPath: this.wallet.originPath,
    };

    try {
      const { wallet, txs, truncated } = await this.scanner.scan(
        this.wallet.descriptor,
        this.wallet.scriptType,
        this.network,
        this.wallet.gapLimit,
        this.wallet.source,
        this.wallet.label,
        identity,
        (p) => {
          this.progress = p;
          this.cd.markForCheck();
        },
      );
      this.storage.save(wallet);
      this.applyWallet(wallet, txs);
      this.truncated = truncated;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.scanning = false;
      this.progress = null;
      this.cd.markForCheck();
    }
  }

  private applyWallet(wallet: WatchWallet, txs: Transaction[]): void {
    this.walletService.setActive(wallet);
    this.walletService.setTransactions(txs);

    const view = this.walletService.buildView(wallet, txs);
    this.wallet = wallet;
    this.transactions = txs;
    this.addressStrings = wallet.addresses.map((a) => a.address);
    this.utxos = view.utxos;
    this.balance = view.balance;
    this.lastUsed = view.lastUsed;
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
      this.lastUsed,
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
    this.transactions = [...byId.values()];
    this.walletService.setTransactions(this.transactions);
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
    this.error = null;
    this.progress = null;
  }

  private resetSendFlow(): void {
    this.closePsbtQrExport();
    this.stopSignedPsbtQrScan();
    this.psbtQrDecoder.reset();
    this.psbtQrScanProgress = null;
    this.psbtQrScanError = '';
    this.sendRecipients = [{ target: '', amountBtc: '' }];
    this.sendMax = false;
    this.sendManualCoins = false;
    this.sendSelectedOutpoints = new Set<string>();
    this.builtPsbt = null;
    this.psbtError = '';
    this.signedPsbtInput = '';
    this.signedPreview = null;
    this.broadcastConfirmed = false;
    this.broadcastError = '';
    this.broadcastTxid = '';
  }

  private reset(): void {
    this.wallet = null;
    this.resetSendFlow();
    this.viewingAll = false;
    this.transactions = [];
    this.utxos = [];
    this.addressStrings = [];
    this.balance = { confirmed: 0, pending: 0, total: 0 };
    this.lastUsed = { 0: -1, 1: -1 };
    this.walletSummary$.next([]);
    this.showDetails = false;
    this.showDescriptor = false;
    this.showUpcomingReceive = false;
    this.showReceiveDetails = false;
    this.receiveIndex = 0;
    this.labelEditor = null;
    this.labelTransferMessage = '';
    this.walletFileMessage = '';
    this.selectedLabelTxid = '';
    this.addressChainFilter = 'all';
    this.hideEmptyAddresses = false;
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
    this.showReceiveDetails = false;
    this.cd.markForCheck();
  }

  receiveDerivationPath(address: DerivedAddress): string {
    return this.walletService.derivationPath(address.address) ?? '';
  }

  get visibleAddressRows(): AddressExplorerRow[] {
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
    return this.explorerRows.filter((row) => (!this.hideEmptyAddresses || row.balance !== 0) && (this.addressChainFilter === 'all' || row.derived.chain === (this.addressChainFilter === 'receive' ? 0 : 1)));
  }
  get sendSpendableUtxos(): WalletUtxo[] {
    return this.utxos.filter((utxo) => !this.isFrozen(utxo));
  }

  addSendRecipient(): void {
    if (!this.sendMax) this.sendRecipients = [...this.sendRecipients, { target: '', amountBtc: '' }];
  }

  removeSendRecipient(index: number): void {
    if (this.sendRecipients.length > 1) this.sendRecipients = this.sendRecipients.filter((_, i) => i !== index);
  }

  applyRecipientUri(row: SendRecipientRow): void {
    try {
      const parsed = parseBitcoinRecipient(row.target);
      row.target = parsed.address;
      if (parsed.amount != null) row.amountBtc = (parsed.amount / 100_000_000).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
      this.psbtError = '';
    } catch (e) {
      this.psbtError = e instanceof Error ? e.message : String(e);
    }
  }

  isSendCoinSelected(utxo: WalletUtxo): boolean {
    return this.sendSelectedOutpoints.has(this.outpoint(utxo));
  }

  toggleSendCoin(utxo: WalletUtxo): void {
    const selected = new Set(this.sendSelectedOutpoints);
    const outpoint = this.outpoint(utxo);
    selected.has(outpoint) ? selected.delete(outpoint) : selected.add(outpoint);
    this.sendSelectedOutpoints = selected;
  }

  private btcToSats(value: string): number {
    const trimmed = value.trim();
    if (!/^(?:\d+)(?:\.\d{1,8})?$/.test(trimmed)) throw new Error('Enter each amount in BTC with at most 8 decimal places.');
    const sats = Math.round(Number(trimmed) * 100_000_000);
    if (!Number.isSafeInteger(sats) || sats <= 0) throw new Error('Recipient amounts must be positive.');
    return sats;
  }

  private async nextChangeAddress(): Promise<DerivedAddress> {
    if (!this.wallet) throw new Error('No active wallet.');
    const nextIndex = this.lastUsed[1] + 1;
    let change = this.wallet.addresses.find((address) => address.chain === 1 && address.index === nextIndex);
    if (!change) {
      [change] = await this.derivation.derive(this.wallet.descriptor, this.wallet.network, 1, nextIndex, 1);
      this.wallet.addresses = [...this.wallet.addresses, change];
      this.wallet.derivedCount[1] = Math.max(this.wallet.derivedCount[1], nextIndex + 1);
      this.storage.save(this.wallet);
      this.walletService.syncWallets(this.wallets);
    }
    if (!change.scriptPubKey) throw new Error('The change address is missing its locking script. Refresh the wallet and try again.');
    return change;
  }

  async buildSendPsbt(): Promise<void> {
    if (!this.wallet || !this.network) return;
    this.closePsbtQrExport();
    this.psbtBuilding = true;
    this.psbtError = '';
    this.builtPsbt = null;
    this.signedPreview = null;
    this.broadcastConfirmed = false;
    try {
      const recipients = this.sendRecipients.map((row) => {
        const parsed = parseBitcoinRecipient(row.target);
        const converted = addressToScriptPubKey(parsed.address, this.network!);
        if (!converted.scriptPubKey) throw new Error(`Invalid ${this.network} recipient address: ${parsed.address}`);
        const value = this.sendMax ? 0 : (parsed.amount ?? this.btcToSats(row.amountBtc));
        return { address: parsed.address, value, scriptPubKey: converted.scriptPubKey };
      });
      const available = this.sendSpendableUtxos.filter((utxo) =>
        !this.sendManualCoins || this.sendSelectedOutpoints.has(this.outpoint(utxo)),
      );
      if (this.sendManualCoins && !available.length) throw new Error('Select at least one spendable UTXO.');
      const walletAddress = new Map(this.wallet.addresses.map((address) => [address.address, address]));
      const txById = new Map(this.transactions.map((tx) => [tx.txid, tx]));
      const utxos: PsbtBuildUtxo[] = available.map((utxo) => {
        const derived = walletAddress.get(utxo.address);
        if (!derived?.scriptPubKey) throw new Error(`Missing derivation metadata for ${this.outpoint(utxo)}.`);
        const previous = txById.get(utxo.txid);
        const previousTx = previous ? uint8ArrayToHexString(serializeTransaction(
          previous, previous.vin.some((input) => !!input.witness?.length),
        )) : undefined;
        return { ...utxo, scriptPubKey: derived.scriptPubKey, chain: derived.chain, index: derived.index, previousTx };
      });
      const change = await this.nextChangeAddress();
      this.builtPsbt = await this.derivation.buildPsbt({
        descriptor: this.wallet.descriptor,
        network: this.network,
        utxos,
        recipients,
        change: { address: change.address, scriptPubKey: change.scriptPubKey!, chain: 1, index: change.index },
        feeRate: Number(this.sendFeeRate),
        sendMax: this.sendMax,
        useAllUtxos: this.sendManualCoins,
        rbf: this.sendRbf,
        locktime: Math.max(0, Math.floor(Number(this.sendLocktime) || 0)),
        opReturn: this.sendOpReturn.trim() || undefined,
      });
    } catch (e) {
      this.psbtError = e instanceof Error ? e.message : String(e);
    } finally {
      this.psbtBuilding = false;
      this.cd.markForCheck();
    }
  }

  downloadPsbt(): void {
    if (!this.builtPsbt) return;
    const bytes = base64ToBytes(this.builtPsbt.base64);
    const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)], { type: 'application/psbt' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = this.fileStem + '.psbt';
    link.click();
    URL.revokeObjectURL(url);
  }

  togglePsbtQrExport(): void {
    if (this.psbtQrExportVisible) {
      this.closePsbtQrExport();
      return;
    }
    if (!this.builtPsbt) return;
    this.psbtQrReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.psbtQrExportVisible = true;
    this.preparePsbtQrExport();
  }

  changePsbtQrEncoding(encoding: PsbtQrEncoding): void {
    this.psbtQrEncoding = encoding;
    this.preparePsbtQrExport();
  }

  private preparePsbtQrExport(): void {
    if (!this.builtPsbt) return;
    try {
      const bytes = base64ToBytes(this.builtPsbt.base64);
      this.psbtQrExport = this.psbtQrEncoding === 'ur' ? encodeUrPsbt(bytes) : encodeBbqrPsbt(bytes);
      this.psbtQrFrameIndex = 0;
      this.psbtQrPlaying = this.psbtQrExport.frames.length > 1 && !this.psbtQrReducedMotion;
      this.restartPsbtQrTimer();
      this.psbtError = '';
    } catch (e) {
      this.closePsbtQrExport();
      this.psbtError = e instanceof Error ? e.message : String(e);
    }
    this.cd.markForCheck();
  }

  togglePsbtQrPlayback(): void {
    if (!this.psbtQrExport || this.psbtQrExport.frames.length < 2) return;
    this.psbtQrPlaying = !this.psbtQrPlaying;
    this.restartPsbtQrTimer();
  }

  nextPsbtQrFrame(): void {
    if (!this.psbtQrExport?.frames.length) return;
    this.psbtQrFrameIndex = (this.psbtQrFrameIndex + 1) % this.psbtQrExport.frames.length;
    this.cd.markForCheck();
  }

  changePsbtQrFrameRate(): void {
    this.restartPsbtQrTimer();
  }

  private restartPsbtQrTimer(): void {
    if (this.psbtQrTimer !== null) {
      window.clearInterval(this.psbtQrTimer);
      this.psbtQrTimer = null;
    }
    if (!this.psbtQrPlaying || !this.psbtQrExport || this.psbtQrExport.frames.length < 2) return;
    this.psbtQrTimer = window.setInterval(() => this.nextPsbtQrFrame(), Math.round(1000 / this.psbtQrFps));
  }

  closePsbtQrExport(): void {
    if (this.psbtQrTimer !== null) window.clearInterval(this.psbtQrTimer);
    this.psbtQrTimer = null;
    this.psbtQrPlaying = false;
    this.psbtQrExportVisible = false;
    this.psbtQrExport = null;
  }

  async startSignedPsbtQrScan(
    videoElement?: () => HTMLVideoElement | undefined,
  ): Promise<void> {
    this.stopSignedPsbtQrScan();
    this.psbtQrDecoder.reset();
    this.psbtQrScanProgress = null;
    this.psbtQrScanError = '';
    this.psbtQrScanning = true;
    this.cd.detectChanges();
    try {
      const QrScanner = (await import('qr-scanner')).default;
      const video = videoElement?.() ?? this.psbtQrVideo?.nativeElement;
      if (!video) throw new Error('The camera preview could not be opened.');
      this.psbtQrScanner = new QrScanner(
        video,
        (result) => void this.acceptSignedPsbtQrFrame(result.data),
        {
          preferredCamera: 'environment',
          maxScansPerSecond: 12,
          highlightScanRegion: true,
          highlightCodeOutline: true,
          returnDetailedScanResult: true,
        },
      );
      await this.psbtQrScanner.start();
    } catch (e) {
      this.stopSignedPsbtQrScan();
      this.psbtQrScanError = e instanceof Error ? e.message : String(e);
      this.cd.markForCheck();
    }
  }

  resetSignedPsbtQrScan(): void {
    this.psbtQrDecoder.reset();
    this.psbtQrScanProgress = null;
    this.psbtQrScanError = '';
    this.cd.markForCheck();
  }

  stopSignedPsbtQrScan(): void {
    this.psbtQrScanner?.stop();
    this.psbtQrScanner?.destroy();
    this.psbtQrScanner = null;
    this.psbtQrScanning = false;
  }

  private async acceptSignedPsbtQrFrame(value: string): Promise<void> {
    try {
      const progress = this.psbtQrDecoder.receivePart(value);
      this.psbtQrScanProgress = progress;
      this.psbtQrScanError = '';
      if (progress.bytes) {
        this.signedPsbtInput = bytesToHex(progress.bytes);
        this.stopSignedPsbtQrScan();
        await this.finalizeSignedPsbt();
      }
    } catch (e) {
      this.psbtQrScanError = e instanceof Error ? e.message : String(e);
    }
    this.cd.markForCheck();
  }

  async importSignedPsbtFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    this.signedPsbtInput = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    await this.finalizeSignedPsbt();
  }

  async finalizeSignedPsbt(): Promise<void> {
    this.psbtError = '';
    this.signedPreview = null;
    this.broadcastConfirmed = false;
    this.broadcastTxid = '';
    try {
      const finalized = await this.derivation.finalizePsbt(normalizePsbtText(this.signedPsbtInput));
      const decoded = decodeRawTransaction(finalized.base64, this.stateService.network);
      const tx = decoded.tx;
      const inputs = tx.vin.map((input) => ({
        txid: input.txid, vout: input.vout, address: input.prevout?.scriptpubkey_address,
        value: input.prevout?.value ?? 0,
      }));
      const outputs = tx.vout.map((output) => ({
        address: output.scriptpubkey_address, value: output.value, script: output.scriptpubkey,
      }));
      const fee = inputs.reduce((sum, input) => sum + input.value, 0)
        - outputs.reduce((sum, output) => sum + output.value, 0);
      const vsize = Math.ceil(tx.weight / 4);
      this.signedPreview = { tx, rawHex: finalized.rawHex, inputs, outputs, fee, vsize, feeRate: fee / vsize };
    } catch (e) {
      this.psbtError = e instanceof Error ? e.message : String(e);
    }
    this.cd.markForCheck();
  }

  broadcastSignedTransaction(): void {
    if (!this.signedPreview || !this.broadcastConfirmed || this.broadcasting) return;
    this.broadcasting = true;
    this.broadcastError = '';
    this.apiService.postTransaction$(this.signedPreview.rawHex).subscribe({
      next: (txid) => {
        this.broadcastTxid = String(txid);
        this.broadcasting = false;
        this.cd.markForCheck();
      },
      error: (error) => {
        this.broadcastError = error?.error || error?.message || 'Broadcast failed.';
        this.broadcasting = false;
        this.cd.markForCheck();
      },
    });
  }

  derivationPath(utxo: WalletUtxo): string {
    return this.walletService.derivationPath(utxo.address) ?? '';
  }

  outpoint(utxo: WalletUtxo): string {
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
    this.cd.markForCheck();
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

  ngOnDestroy(): void {
    this.closePsbtQrExport();
    this.stopSignedPsbtQrScan();
    this.tracker.stop();
    this.subscription.unsubscribe();
  }
}
