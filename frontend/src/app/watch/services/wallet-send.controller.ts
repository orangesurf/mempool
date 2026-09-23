import { ChangeDetectorRef } from '@angular/core';
import { Router } from '@angular/router';
import { StateService } from '@app/services/state.service';
import { RelativeUrlPipe } from '@app/shared/pipes/relative-url/relative-url.pipe';
import { addressToScriptPubKey, decodeRawTransaction, serializeTransaction, uint8ArrayToHexString } from '@app/shared/transaction.utils';
import { Transaction, Utxo } from '@interfaces/electrs.interface';
import { Subscription } from 'rxjs';
import { distinctUntilChanged, map } from 'rxjs/operators';
import { AnimatedPsbtQrDecoder, encodeBbqrPsbt, encodeUrPsbt, PsbtQrDecodeProgress, PsbtQrEncoding, PsbtQrFrames } from '../psbt-qr.utils';
import {
  base64ToBytes,
  bytesToHex,
  normalizeSignedTransactionText,
  parseBitcoinRecipient,
  PsbtBuildResult,
  PsbtBuildUtxo,
  PsbtEstimateResult,
} from '../psbt.utils';
import { DerivationService } from './derivation.service';
import { WalletLocalStateService, WalletStorageService } from './wallet-storage.service';
import { WalletService } from './wallet.service';
import { SendLocktimeMode, SendRecipientRow } from '../watch-models';
import { Bip329LabelType, DerivedAddress, WalletUtxo, WatchNetwork, WatchWallet } from '../watch.types';

export interface WalletSendContext {
  wallet: WatchWallet | null;
  utxos: WalletUtxo[];
  isFrozen: (utxo: WalletUtxo) => boolean;
  outpoint: (utxo: Pick<WalletUtxo, 'txid' | 'vout'>) => string;
  scanning: boolean;
  truncated: boolean;
  descriptorOriginAcknowledged: boolean;
  labelFor: (type: Bip329LabelType, ref: string) => string;
  network: WatchNetwork | null;
  wallets: WatchWallet[];
  lastUsed: Record<0 | 1, number>;
  transactions: Transaction[];
  fileStem: string;
  graphUtxos: Utxo[];
  graphFrozenOutpoints: Set<string>;
}

/** Page-scoped external-signer workflow. Owns drafts, estimation, and camera/QR lifetime. */
export class WalletSendController {
  private subscription = new Subscription();
  constructor(
    private context: WalletSendContext,
    public stateService: StateService,
    private derivation: DerivationService,
    private storage: WalletStorageService,
    private walletService: WalletService,
    private localState: WalletLocalStateService,
    private router: Router,
    private relativeUrlPipe: RelativeUrlPipe,
    private cd: ChangeDetectorRef,
  ) {}

  initialize(): void {
    this.subscription.add(this.stateService.recommendedFees$.subscribe((fees) => {
      if (!this.builtPsbt && !this.sendFeeRateManuallySet && this.sendFeeRate !== fees.halfHourFee) {
        this.sendFeeRate = fees.halfHourFee;
        this.invalidateSendDraft();
        void this.refreshSendMaxAmount();
      }
      this.cd.markForCheck();
    }));
    this.subscription.add(this.stateService.viewAmountMode$.pipe(
      map((mode) => mode === 'sats' ? 'sats' as const : 'btc' as const),
      distinctUntilChanged(),
    ).subscribe((mode) => {
      const previous = this.sendAmountMode;
      if (previous !== mode) {
        for (const recipient of this.sendRecipients) {
          recipient.amountBtc = this.convertSendAmount(recipient.amountBtc, previous, mode);
          if (recipient.amountBeforeMax !== undefined) {
            recipient.amountBeforeMax = this.convertSendAmount(recipient.amountBeforeMax, previous, mode);
          }
        }
        this.sendMaxAmounts = this.sendMaxAmounts.map((amount) => amount === null ? null : this.convertSendAmount(amount, previous, mode));
        this.sendAmountMode = mode;
        this.invalidateSendDraft();
        void this.refreshSendMaxAmount();
      }
      this.cd.markForCheck();
    }));
  }


  // ── experimental send / external-signer PSBT flow ──
  sendRecipients: SendRecipientRow[] = [{ target: '', amountBtc: '' }];
  sendAmountMode: 'btc' | 'sats' = 'btc';
  sendMaxRecipientIndex: number | null = null;
  sendMaxCalculating = false;
  sendMaxAmounts: Array<string | null> = [null];
  sendFeeEstimate: PsbtEstimateResult | null = null;
  sendFeeRate = 1;
  private sendFeeRateManuallySet = false;
  sendSelectedOutpoints = new Set<string>();
  private sendKnownOutpoints = new Set<string>();
  private sendDraftGeneration = 0;
  private sendMaxGeneration = 0;
  private sendEstimateTimer: ReturnType<typeof setTimeout> | null = null;
  private signedImportGeneration = 0;
  sendRbf = true;
  sendVersion = 2;
  sendAbsoluteLocktimeType: 'none' | 'height' | 'time' = 'none';
  sendLocktime = 0;
  sendLocktimeDateTime = '';
  sendRelativeLocktimeType: 'none' | 'blocks' | 'time' = 'none';
  sendRelativeLocktime = 1;
  sendOpReturn = '';
  psbtBuilding = false;
  psbtError = '';
  builtPsbt: PsbtBuildResult | null = null;
  signedPsbtInput = '';

  // Animated QR export stays deterministic: the same finite fountain sequence loops until
  // the signer has enough parts. Reduced-motion users start paused and can advance manually.
  psbtQrExportVisible = false;
  psbtQrEncoding: PsbtQrEncoding = 'ur';
  psbtQrExport: PsbtQrFrames | null = null;
  psbtQrFrameIndex = 0;
  psbtQrPlaying = false;
  psbtQrFps = 4;
  psbtQrDensity: 'low' | 'medium' | 'high' = 'medium';
  psbtQrSettingsVisible = false;
  psbtQrReducedMotion = false;
  private psbtQrTimer: number | null = null;

  psbtQrScanning = false;
  psbtQrScanError = '';
  psbtQrScanProgress: PsbtQrDecodeProgress | null = null;
  private psbtQrDecoder = new AnimatedPsbtQrDecoder();
  private psbtQrScanner: { start(): Promise<void>; stop(): void; destroy(): void } | null = null;

  private sendGraphUtxosSource: Utxo[] | null = null;
  private sendGraphFrozenSource: Set<string> | null = null;
  private sendGraphUtxosCache: Utxo[] = [];
  resetSendFlow(): void {
    this.sendDraftGeneration++;
    this.signedImportGeneration++;
    this.closePsbtQrExport();
    this.stopSignedPsbtQrScan();
    this.psbtQrDecoder.reset();
    this.psbtQrScanProgress = null;
    this.psbtQrScanError = '';
    this.sendRecipients = [{ target: '', amountBtc: '' }];
    this.sendMaxRecipientIndex = null;
    this.sendMaxCalculating = false;
    this.sendMaxAmounts = [null];
    this.sendFeeEstimate = null;
    this.sendMaxGeneration++;
    if (this.sendEstimateTimer !== null) {
      clearTimeout(this.sendEstimateTimer);
      this.sendEstimateTimer = null;
    }
    this.sendSelectedOutpoints = new Set<string>();
    this.sendKnownOutpoints = new Set<string>();
    this.builtPsbt = null;
    this.psbtError = '';
    this.signedPsbtInput = '';
  }

  get needsSigningDescriptor(): boolean {
    return !!this.context.wallet && !this.hasCompleteSigningOrigins(this.context.wallet);
  }

  get sendSpendableUtxos(): WalletUtxo[] {
    return this.context.utxos.filter((utxo) => !this.context.isFrozen(utxo));
  }

  get sendSelectedUtxos(): WalletUtxo[] {
    return this.sendSpendableUtxos.filter((utxo) => this.sendSelectedOutpoints.has(this.context.outpoint(utxo)));
  }

  get sendSelectedTotal(): number {
    return this.sendSelectedUtxos.reduce((total, utxo) => total + utxo.value, 0);
  }

  get sendAmountUnit(): string {
    return this.sendAmountMode === 'sats' ? 'sats' : 'BTC';
  }

  get sendAmountPlaceholder(): string {
    return this.sendAmountMode === 'sats' ? '100000' : '0.001';
  }

  setManualSendFeeRate(): void {
    this.sendFeeRateManuallySet = true;
    this.invalidateSendDraft();
    this.scheduleSendEstimate();
  }

  selectRecommendedFeeRate(rate: number): void {
    this.sendFeeRate = rate;
    this.setManualSendFeeRate();
  }

  get sendBlockedReason(): string {
    if (this.context.scanning) {
      return 'Sending is disabled until the wallet refresh finishes and its UTXO set is current.';
    }
    if (this.context.truncated) {
      return 'Sending is disabled because this wallet history was truncated; its balance and UTXO set may be incomplete.';
    }
    if (this.context.wallet && !this.hasCompleteSigningOrigins(this.context.wallet) && !this.context.descriptorOriginAcknowledged) {
      return 'For smoother hardware-wallet signing, import the wallet’s full descriptor so the PSBT includes its device fingerprint and derivation path. To continue with this public key as-is, acknowledge the missing signing details in Settings.';
    }
    if (this.context.wallet && !this.isSupportedSigningPolicy(this.context.wallet)) {
      return 'This wallet policy is supported for watching, but PSBT creation is limited to single-key legacy/SegWit/Taproot and sortedmulti SegWit descriptors.';
    }
    return '';
  }

  private hasCompleteSigningOrigins(wallet: WatchWallet): boolean {
    if (wallet.signingOriginsComplete != null) return wallet.signingOriginsComplete;
    const keys = [...wallet.descriptor.matchAll(/(?:\[([0-9a-fA-F]{8})((?:\/[^\]]+)+)\])?((?:xpub|tpub)[1-9A-HJ-NP-Za-km-z]+)/g)];
    if (!keys.length) return false;
    if (keys.every((match) => !!match[1] && !!match[2])) return true;
    // A single depth-zero extended public key is itself the master and needs no origin prefix.
    return keys.length === 1 && wallet.fingerprintIsMaster && !wallet.originPath;
  }

  private isSupportedSigningPolicy(wallet: WatchWallet): boolean {
    const type = wallet.scriptType.toLowerCase();
    if (['pkh', 'wpkh', 'sh_wpkh', 'shwpkh'].includes(type)) return true;
    if (type === 'tr') return /^tr\([^,{]+\)$/.test(wallet.descriptor);
    if (type === 'wsh') return /^wsh\(sortedmulti\(/.test(wallet.descriptor);
    if (type === 'sh_wsh' || type === 'shwsh') return /^sh\(wsh\(sortedmulti\(/.test(wallet.descriptor);
    return false;
  }

  /** Preserve explicit deselections while selecting every newly discovered spendable coin. */
  syncSendCoinSelection(): void {
    const available = new Set(this.sendSpendableUtxos.map((utxo) => this.context.outpoint(utxo)));
    const availabilityChanged = available.size !== this.sendKnownOutpoints.size
      || [...available].some((outpoint) => !this.sendKnownOutpoints.has(outpoint));
    const selected = new Set(
      [...this.sendSelectedOutpoints].filter((outpoint) => available.has(outpoint)),
    );
    for (const outpoint of available) {
      if (!this.sendKnownOutpoints.has(outpoint)) {
        selected.add(outpoint);
      }
    }
    this.sendSelectedOutpoints = selected;
    this.sendKnownOutpoints = available;
    if (availabilityChanged) {
      this.invalidateSendDraft();
      void this.refreshSendMaxAmount();
    }
  }

  selectAllSendCoins(): void {
    this.sendSelectedOutpoints = new Set(this.sendSpendableUtxos.map((utxo) => this.context.outpoint(utxo)));
    this.invalidateSendDraft();
    void this.refreshSendMaxAmount();
  }

  clearSendCoins(): void {
    this.sendSelectedOutpoints = new Set<string>();
    this.invalidateSendDraft();
    void this.refreshSendMaxAmount();
  }

  sendCoinLabels(utxo: WalletUtxo): string[] {
    return [...new Set([
      this.context.labelFor('output', this.context.outpoint(utxo)),
      this.context.labelFor('tx', utxo.txid),
      this.context.labelFor('addr', utxo.address),
    ].filter((label): label is string => !!label))];
  }

  addSendRecipient(): void {
    this.sendRecipients = [...this.sendRecipients, { target: '', amountBtc: '' }];
    this.sendMaxAmounts = this.sendRecipients.map(() => null);
    this.sendFeeEstimate = null;
    this.invalidateSendDraft();
  }

  removeSendRecipient(index: number): void {
    if (this.sendRecipients.length > 1) {
      if (this.sendMaxRecipientIndex === index) {
        this.sendMaxRecipientIndex = null;
      } else if (this.sendMaxRecipientIndex != null && this.sendMaxRecipientIndex > index) {
        this.sendMaxRecipientIndex--;
      }
      this.sendRecipients = this.sendRecipients.filter((_, i) => i !== index);
      this.sendMaxAmounts = this.sendMaxAmounts.filter((_, i) => i !== index);
      this.invalidateSendDraft();
      void this.refreshSendMaxAmount();
    }
  }

  sendRecipientChanged(): void {
    this.invalidateSendDraft();
    this.sendMaxGeneration++;
    this.sendMaxAmounts = this.sendRecipients.map(() => null);
    this.sendFeeEstimate = null;
    if (this.sendMaxRecipientIndex != null) {
      this.sendRecipients[this.sendMaxRecipientIndex].amountBtc = '';
    }
  }

  recipientAmountChanged(index: number): void {
    if (index === this.sendMaxRecipientIndex) {
      delete this.sendRecipients[index].amountBeforeMax;
      this.sendMaxRecipientIndex = null;
      this.sendMaxAmounts = this.sendRecipients.map(() => null);
    }
    this.invalidateSendDraft();
    this.scheduleSendEstimate();
  }

  async applyRecipientUri(row: SendRecipientRow, index: number): Promise<void> {
    try {
      const parsed = parseBitcoinRecipient(row.target);
      row.target = parsed.address;
      if (parsed.amount != null && index !== this.sendMaxRecipientIndex) {
        row.amountBtc = this.satsToSendAmount(parsed.amount);
      }
      this.invalidateSendDraft();
      this.psbtError = '';
      await this.refreshSendMaxAmount();
    } catch (e) {
      this.psbtError = e instanceof Error ? e.message : String(e);
    }
  }

  async pasteSendRecipient(index: number): Promise<void> {
    if (!this.stateService.isBrowser || !navigator.clipboard?.readText) {
      this.psbtError = 'Clipboard reading is not available in this browser.';
      return;
    }
    try {
      const value = (await navigator.clipboard.readText()).trim();
      if (!value) throw new Error('The clipboard is empty.');
      this.sendRecipients[index].target = value;
      this.sendRecipientChanged();
      await this.applyRecipientUri(this.sendRecipients[index], index);
    } catch (error) {
      this.psbtError = error instanceof Error ? error.message : 'Could not read the clipboard.';
      this.cd.markForCheck();
    }
  }

  isSendRecipientMax(index: number): boolean {
    return this.sendMaxRecipientIndex === index;
  }

  async setSendMax(index: number): Promise<void> {
    if (!this.sendSelectedUtxos.length && this.sendSpendableUtxos.length) {
      this.sendSelectedOutpoints = new Set(this.sendSpendableUtxos.map((utxo) => this.context.outpoint(utxo)));
      this.sendKnownOutpoints = new Set(this.sendSelectedOutpoints);
    }
    const current = this.sendMaxRecipientIndex;
    if (current === index) {
      const row = this.sendRecipients[index];
      row.amountBtc = row.amountBeforeMax ?? '';
      delete row.amountBeforeMax;
      this.sendMaxRecipientIndex = null;
      this.sendMaxGeneration++;
      this.sendMaxCalculating = false;
      this.sendMaxAmounts = this.sendRecipients.map(() => null);
      this.invalidateSendDraft();
      void this.refreshSendMaxAmount();
      this.cd.markForCheck();
      return;
    }
    if (current != null) {
      const previous = this.sendRecipients[current];
      previous.amountBtc = previous.amountBeforeMax ?? '';
      delete previous.amountBeforeMax;
    }
    const row = this.sendRecipients[index];
    row.amountBeforeMax = row.amountBtc;
    row.amountBtc = '';
    this.sendMaxRecipientIndex = index;
    this.invalidateSendDraft();
    await this.refreshSendMaxAmount();
  }

  sendOutputOptionsChanged(): void {
    this.invalidateSendDraft();
    this.scheduleSendEstimate();
  }

  private scheduleSendEstimate(delay = 180): void {
    this.sendMaxGeneration++;
    if (this.sendEstimateTimer !== null) clearTimeout(this.sendEstimateTimer);
    this.sendEstimateTimer = setTimeout(() => {
      this.sendEstimateTimer = null;
      void this.refreshSendMaxAmount();
    }, delay);
  }

  setAbsoluteLocktimeType(type: 'none' | 'height' | 'time'): void {
    this.sendAbsoluteLocktimeType = type;
    if (type !== 'none') this.sendRelativeLocktimeType = 'none';
    this.sendOutputOptionsChanged();
  }

  setRelativeLocktimeType(type: 'none' | 'blocks' | 'time'): void {
    this.sendRelativeLocktimeType = type;
    if (type !== 'none') {
      this.sendAbsoluteLocktimeType = 'none';
      this.sendVersion = 2;
      this.sendRelativeLocktime = 0;
    }
    this.sendOutputOptionsChanged();
  }

  get sendLocktimeMode(): SendLocktimeMode {
    if (this.sendAbsoluteLocktimeType === 'height') return 'absolute-height';
    if (this.sendAbsoluteLocktimeType === 'time') return 'absolute-time';
    if (this.sendRelativeLocktimeType === 'blocks') return 'relative-blocks';
    if (this.sendRelativeLocktimeType === 'time') return 'relative-time';
    return 'none';
  }

  setSendLocktimeMode(mode: SendLocktimeMode): void {
    this.sendAbsoluteLocktimeType = mode === 'absolute-height'
      ? 'height'
      : (mode === 'absolute-time' ? 'time' : 'none');
    this.sendRelativeLocktimeType = mode === 'relative-blocks'
      ? 'blocks'
      : (mode === 'relative-time' ? 'time' : 'none');
    if (this.sendRelativeLocktimeType !== 'none') {
      this.sendVersion = 2;
      this.sendRelativeLocktime = 0;
    }
    this.sendOutputOptionsChanged();
  }

  get sendRelativeLocktimeMax(): number {
    return this.sendRelativeLocktimeType === 'time' ? 0xffff * 512 : 0xffff;
  }

  get sendRelativeLocktimeStep(): number {
    return this.sendRelativeLocktimeType === 'time' ? 512 : 1;
  }

  get sendRelativeLocktimeDescription(): string {
    const value = Math.max(0, Number(this.sendRelativeLocktime) || 0);
    const seconds = this.sendRelativeLocktimeType === 'blocks' ? value * 600 : value;
    const human = this.formatHumanDuration(seconds);
    const technical = this.sendRelativeLocktimeType === 'blocks'
      ? `${value.toLocaleString()} blocks`
      : `${Math.ceil(value / 512).toLocaleString()} × 512-second units`;
    return `${human} [${technical}]`;
  }

  private formatHumanDuration(seconds: number): string {
    if (seconds <= 0) return 'No delay';
    const units: Array<[string, number]> = [
      ['year', 365 * 86400], ['month', 30 * 86400], ['day', 86400],
      ['hour', 3600], ['minute', 60],
    ];
    let remaining = Math.round(seconds);
    const parts: string[] = [];
    for (const [name, size] of units) {
      const count = Math.floor(remaining / size);
      if (count > 0) {
        parts.push(`${count} ${name}${count === 1 ? '' : 's'}`);
        remaining -= count * size;
      }
      if (parts.length === 2) break;
    }
    return parts.join(' ') || `${remaining} seconds`;
  }

  private async refreshSendMaxAmount(): Promise<void> {
    if (this.sendEstimateTimer !== null) {
      clearTimeout(this.sendEstimateTimer);
      this.sendEstimateTimer = null;
    }
    const maxRecipientIndex = this.sendMaxRecipientIndex;
    const generation = ++this.sendMaxGeneration;
    if (!this.context.wallet || !this.context.network || !this.sendRecipients.every((recipient) => recipient.target.trim()) || !this.sendSelectedUtxos.length) {
      this.sendMaxCalculating = false;
      this.sendFeeEstimate = null;
      this.cd.markForCheck();
      return;
    }
    this.sendMaxCalculating = true;
    this.cd.markForCheck();
    try {
      const parsedRecipients = this.sendRecipients.map((recipientRow) => {
        const parsed = parseBitcoinRecipient(recipientRow.target);
        const recipient = addressToScriptPubKey(parsed.address, this.context.network!);
        if (!recipient.scriptPubKey) throw new Error(`Invalid ${this.context.network} recipient address: ${parsed.address}`);
        return { parsed, scriptPubKey: recipient.scriptPubKey, row: recipientRow };
      });
      const candidates = maxRecipientIndex == null
        ? this.sendRecipients.map((_, index) => index)
        : [maxRecipientIndex];
      const changeScriptPubKey = this.context.wallet.addresses.find((address) => address.chain === 1)?.scriptPubKey;
      const estimatePromise = Promise.resolve().then(() => this.derivation.estimateTransaction({
        descriptor: this.context.wallet!.descriptor,
        utxoValues: this.sendSelectedUtxos.map((utxo) => utxo.value),
        recipients: parsedRecipients.map((recipient, index) => ({
          scriptPubKey: recipient.scriptPubKey,
          value: index === maxRecipientIndex ? 0 : (recipient.parsed.amount ?? this.parseSendAmount(recipient.row.amountBtc)),
        })),
        changeScriptPubKey,
        maxRecipientIndex,
        feeRate: Number(this.sendFeeRate),
        opReturn: this.sendOpReturn.trim() || undefined,
      })).catch(() => null);
      const [maximums, estimate] = await Promise.all([
        Promise.all(candidates.map((candidate) => this.derivation.maxSendAmount({
          descriptor: this.context.wallet!.descriptor,
          utxoValues: this.sendSelectedUtxos.map((utxo) => utxo.value),
          recipients: parsedRecipients.map((recipient, index) => ({
            scriptPubKey: recipient.scriptPubKey,
            value: index === candidate ? 0 : (recipient.parsed.amount ?? this.parseSendAmount(recipient.row.amountBtc)),
          })),
          maxRecipientIndex: candidate,
          feeRate: Number(this.sendFeeRate),
          opReturn: this.sendOpReturn.trim() || undefined,
        }))),
        estimatePromise,
      ]);
      if (generation !== this.sendMaxGeneration || this.sendMaxRecipientIndex !== maxRecipientIndex) return;
      const nextMaxAmounts = [...this.sendMaxAmounts];
      while (nextMaxAmounts.length < this.sendRecipients.length) nextMaxAmounts.push(null);
      nextMaxAmounts.length = this.sendRecipients.length;
      candidates.forEach((candidate, index) => {
        nextMaxAmounts[candidate] = this.satsToSendAmount(maximums[index].value);
      });
      this.sendMaxAmounts = nextMaxAmounts;
      this.sendFeeEstimate = estimate;
      if (maxRecipientIndex != null) {
        this.sendRecipients[maxRecipientIndex].amountBtc = this.sendMaxAmounts[maxRecipientIndex]!;
      }
      this.psbtError = '';
    } catch (e) {
      if (generation === this.sendMaxGeneration) this.sendFeeEstimate = null;
      if (maxRecipientIndex != null && generation === this.sendMaxGeneration && this.sendMaxRecipientIndex === maxRecipientIndex) {
        this.psbtError = e instanceof Error ? e.message : String(e);
      }
    } finally {
      if (generation === this.sendMaxGeneration) {
        this.sendMaxCalculating = false;
        this.cd.markForCheck();
      }
    }
  }

  isSendCoinSelected(utxo: WalletUtxo): boolean {
    return this.sendSelectedOutpoints.has(this.context.outpoint(utxo));
  }

  isBuiltSendCoin(utxo: WalletUtxo): boolean {
    const ref = this.context.outpoint(utxo);
    return !!this.builtPsbt?.selected.some((selected) => this.context.outpoint(selected) === ref);
  }

  toggleSendCoin(utxo: WalletUtxo): void {
    if (this.context.isFrozen(utxo)) return;
    const selected = new Set(this.sendSelectedOutpoints);
    const outpoint = this.context.outpoint(utxo);
    selected.has(outpoint) ? selected.delete(outpoint) : selected.add(outpoint);
    this.sendSelectedOutpoints = selected;
    this.invalidateSendDraft();
    void this.refreshSendMaxAmount();
  }

  toggleSendGraphCoin(utxo: Utxo): void {
    const walletUtxo = this.context.utxos.find((candidate) => candidate.txid === utxo.txid && candidate.vout === utxo.vout);
    if (walletUtxo) this.toggleSendCoin(walletUtxo);
  }

  invalidateSendDraft(): void {
    this.sendDraftGeneration++;
    this.signedImportGeneration++;
    // Returning a signed PSBT is part of the built draft. If that draft changes, release
    // the camera before Angular removes the scanner's video element and discard all parts.
    this.stopSignedPsbtQrScan();
    this.psbtQrDecoder.reset();
    this.psbtQrScanProgress = null;
    this.psbtQrScanError = '';
    if (!this.builtPsbt) {
      return;
    }
    this.closePsbtQrExport();
    this.builtPsbt = null;
    this.signedPsbtInput = '';
  }

  private parseSendAmount(value: string): number {
    const trimmed = value.trim();
    if (this.sendAmountMode === 'sats') {
      if (!/^\d+$/.test(trimmed)) throw new Error('Enter each amount as a whole number of sats.');
      const sats = Number(trimmed);
      if (!Number.isSafeInteger(sats) || sats <= 0) throw new Error('Recipient amounts must be positive whole sats.');
      return sats;
    }
    if (!/^(?:\d+)(?:\.\d{1,8})?$/.test(trimmed)) throw new Error('Enter each amount in BTC with at most 8 decimal places.');
    const sats = Math.round(Number(trimmed) * 100_000_000);
    if (!Number.isSafeInteger(sats) || sats <= 0) throw new Error('Recipient amounts must be positive.');
    return sats;
  }

  private satsToBtc(sats: number): string {
    return (sats / 100_000_000).toFixed(8).replace(/0+$/, '').replace(/\.$/, '') || '0';
  }

  private satsToSendAmount(sats: number): string {
    return this.sendAmountMode === 'sats' ? String(sats) : this.satsToBtc(sats);
  }

  private convertSendAmount(value: string, from: 'btc' | 'sats', to: 'btc' | 'sats'): string {
    const trimmed = value.trim();
    if (!trimmed || from === to) return value;
    if (from === 'btc' && /^(?:\d+)(?:\.\d{1,8})?$/.test(trimmed)) {
      return String(Math.round(Number(trimmed) * 100_000_000));
    }
    if (from === 'sats' && /^\d+$/.test(trimmed)) return this.satsToBtc(Number(trimmed));
    return value;
  }

  private async nextChangeAddress(wallet: WatchWallet, lastUsedIndex: number): Promise<DerivedAddress> {
    const nextIndex = Math.max(lastUsedIndex + 1, this.localState.getChangeIndex(wallet) ?? 0);
    let change = wallet.addresses.find((address) => address.chain === 1 && address.index === nextIndex);
    if (!change) {
      [change] = await this.derivation.derive(wallet.descriptor, wallet.network, 1, nextIndex, 1);
      wallet.addresses = [...wallet.addresses, change];
      wallet.derivedCount[1] = Math.max(wallet.derivedCount[1], nextIndex + 1);
      this.storage.save(wallet);
      this.walletService.syncWallets(this.context.wallets);
    }
    if (!change.scriptPubKey) throw new Error('The change address is missing its locking script. Refresh the wallet and try again.');
    return change;
  }

  private resolvedSendLocktime(): number {
    if (this.sendAbsoluteLocktimeType === 'none') return 0;
    if (this.sendAbsoluteLocktimeType === 'time') {
      const milliseconds = Date.parse(this.sendLocktimeDateTime);
      if (!Number.isFinite(milliseconds)) throw new Error('Choose a valid absolute locktime date and time.');
      const timestamp = Math.floor(milliseconds / 1000);
      if (timestamp < 500_000_000 || timestamp > 0xffffffff) throw new Error('Absolute time lock is outside the valid transaction locktime range.');
      return timestamp;
    }
    const height = Number(this.sendLocktime);
    if (!Number.isInteger(height) || height < 1 || height >= 500_000_000) throw new Error('Absolute block locktime must be a whole block height below 500,000,000.');
    return height;
  }

  private resolvedSendSequence(version: number): number {
    if (this.sendRelativeLocktimeType === 'none') return this.sendRbf ? 0xfffffffd : 0xfffffffe;
    if (version < 2) throw new Error('Relative locktime requires transaction version 2.');
    const relative = Number(this.sendRelativeLocktime);
    if (!Number.isInteger(relative) || relative < 0) throw new Error('Relative locktime must be a non-negative whole number.');
    if (this.sendRelativeLocktimeType === 'blocks') {
      if (relative > 0xffff) throw new Error('Relative block locktime cannot exceed 65,535 blocks.');
      return relative;
    }
    const units = Math.ceil(relative / 512);
    if (units > 0xffff) throw new Error('Relative time lock cannot exceed 33,553,920 seconds.');
    return 0x00400000 | units;
  }

  async buildSendPsbt(): Promise<void> {
    if (!this.context.wallet || !this.context.network || this.psbtBuilding) return;
    const wallet = this.context.wallet;
    const network = this.context.network;
    const generation = this.sendDraftGeneration;
    const lastUsedChange = this.context.lastUsed[1];
    const feeRate = Number(this.sendFeeRate);
    const maxRecipientIndex = this.sendMaxRecipientIndex;
    const version = Number(this.sendVersion);
    const opReturn = this.sendOpReturn.trim() || undefined;
    this.closePsbtQrExport();
    this.psbtBuilding = true;
    this.psbtError = '';
    this.builtPsbt = null;
    try {
      if (this.sendBlockedReason) throw new Error(this.sendBlockedReason);
      const locktime = this.resolvedSendLocktime();
      const sequence = this.resolvedSendSequence(version);
      const recipients = this.sendRecipients.map((row, index) => {
        const parsed = parseBitcoinRecipient(row.target);
        const converted = addressToScriptPubKey(parsed.address, network);
        if (!converted.scriptPubKey) throw new Error(`Invalid ${network} recipient address: ${parsed.address}`);
        const value = index === maxRecipientIndex ? 0 : (parsed.amount ?? this.parseSendAmount(row.amountBtc));
        return { address: parsed.address, value, scriptPubKey: converted.scriptPubKey };
      });
      const available = this.sendSelectedUtxos;
      if (!available.length) throw new Error('Select at least one spendable UTXO.');
      const walletAddress = new Map(wallet.addresses.map((address) => [address.address, address]));
      const txById = new Map(this.context.transactions.map((tx) => [tx.txid, tx]));
      const utxos: PsbtBuildUtxo[] = available.map((utxo) => {
        const derived = walletAddress.get(utxo.address);
        if (!derived?.scriptPubKey) throw new Error(`Missing derivation metadata for ${this.context.outpoint(utxo)}.`);
        const previous = txById.get(utxo.txid);
        const previousTx = previous ? uint8ArrayToHexString(serializeTransaction(
          previous, previous.vin.some((input) => !!input.witness?.length),
        )) : undefined;
        return { ...utxo, scriptPubKey: derived.scriptPubKey, chain: derived.chain, index: derived.index, previousTx };
      });
      const change = await this.nextChangeAddress(wallet, lastUsedChange);
      if (generation !== this.sendDraftGeneration || this.context.wallet?.id !== wallet.id) return;
      const built = await this.derivation.buildPsbt({
        descriptor: wallet.descriptor,
        network,
        utxos,
        recipients,
        change: { address: change.address, scriptPubKey: change.scriptPubKey!, chain: 1, index: change.index },
        feeRate,
        maxRecipientIndex,
        useAllUtxos: true,
        version,
        sequence,
        locktime,
        opReturn,
      });
      if (generation !== this.sendDraftGeneration || this.context.wallet?.id !== wallet.id) return;
      this.builtPsbt = built;
      if (maxRecipientIndex != null && built.outputs[maxRecipientIndex]) {
        const maximum = this.satsToSendAmount(built.outputs[maxRecipientIndex].value);
        this.sendRecipients[maxRecipientIndex].amountBtc = maximum;
        this.sendMaxAmounts[maxRecipientIndex] = maximum;
      }
      if (built.changeValue) this.localState.setChangeIndex(wallet, change.index + 1);
      this.openPsbtQrExport();
    } catch (e) {
      if (generation === this.sendDraftGeneration && this.context.wallet?.id === wallet.id) {
        this.psbtError = e instanceof Error ? e.message : String(e);
      }
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
    link.download = this.context.fileStem + '.psbt';
    link.click();
    URL.revokeObjectURL(url);
  }

  togglePsbtQrExport(): void {
    if (this.psbtQrExportVisible) {
      this.closePsbtQrExport();
      return;
    }
    this.openPsbtQrExport();
  }

  private openPsbtQrExport(): void {
    if (!this.builtPsbt) return;
    // Defend against stale template/runtime values while keeping UR as the interoperable default.
    this.psbtQrEncoding = this.psbtQrEncoding === 'bbqr' ? 'bbqr' : 'ur';
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
      const fragmentBytes = this.psbtQrDensity === 'low' ? 120 : (this.psbtQrDensity === 'high' ? 240 : 180);
      const maxVersion = (this.psbtQrDensity === 'low' ? 10 : (this.psbtQrDensity === 'high' ? 20 : 15)) as 10 | 15 | 20;
      this.psbtQrExport = this.psbtQrEncoding === 'ur'
        ? encodeUrPsbt(bytes, fragmentBytes)
        : encodeBbqrPsbt(bytes, { maxVersion });
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

  setPsbtQrSpeed(speed: 'slow' | 'medium' | 'fast'): void {
    this.psbtQrFps = speed === 'slow' ? 2 : (speed === 'fast' ? 7 : 4);
    this.changePsbtQrFrameRate();
  }

  get psbtQrSpeed(): 'slow' | 'medium' | 'fast' {
    return this.psbtQrFps <= 2 ? 'slow' : (this.psbtQrFps >= 7 ? 'fast' : 'medium');
  }

  changePsbtQrDensity(density: 'low' | 'medium' | 'high'): void {
    this.psbtQrDensity = density;
    this.preparePsbtQrExport();
  }

  togglePsbtQrSettings(): void {
    this.psbtQrSettingsVisible = !this.psbtQrSettingsVisible;
    this.cd.markForCheck();
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
    this.psbtQrSettingsVisible = false;
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
      const video = videoElement?.();
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
        await this.previewSignedTransaction();
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
    await this.previewSignedTransaction();
  }

  invalidateSignedPreview(): void {
    this.signedImportGeneration++;
    this.psbtError = '';
  }

  async previewSignedTransaction(): Promise<void> {
    const generation = ++this.signedImportGeneration;
    const builtPsbt = this.builtPsbt;
    this.psbtError = '';
    try {
      if (!builtPsbt) {
        throw new Error('Build an unsigned PSBT here first so the signed transaction can be verified against its intended inputs and outputs.');
      }
      const signedInput = normalizeSignedTransactionText(this.signedPsbtInput);
      const intended = decodeRawTransaction(builtPsbt.base64, this.stateService.network).tx;
      const signed = decodeRawTransaction(
        signedInput.kind === 'psbt' ? signedInput.base64 : signedInput.rawHex,
        this.stateService.network,
      ).tx;
      const unsignedIdentity = (tx: Transaction): string => JSON.stringify({
        version: tx.version,
        locktime: tx.locktime,
        inputs: tx.vin.map((input) => ({ txid: input.txid, vout: input.vout, sequence: input.sequence })),
        outputs: tx.vout.map((output) => ({ value: output.value, script: output.scriptpubkey })),
      });
      if (unsignedIdentity(signed) !== unsignedIdentity(intended)) {
        throw new Error('The signed transaction does not match the unsigned transaction built here. Inputs, outputs, amounts, sequences, or locktime were changed.');
      }
      const finalizedRawHex = signedInput.kind === 'psbt'
        ? (await this.derivation.finalizePsbt(signedInput.base64)).rawHex
        : signedInput.rawHex;
      if (generation !== this.signedImportGeneration || this.builtPsbt !== builtPsbt) return;
      await this.router.navigate([this.relativeUrlPipe.transform('/tx/preview')], {
        fragment: new URLSearchParams({ tx: finalizedRawHex }).toString(),
      });
    } catch (e) {
      this.psbtError = e instanceof Error ? e.message : String(e);
    }
    this.cd.markForCheck();
  }

  get sendGraphUtxos(): Utxo[] {
    const graphUtxos = this.context.graphUtxos;
    if (this.sendGraphUtxosSource !== graphUtxos || this.sendGraphFrozenSource !== this.context.graphFrozenOutpoints) {
      this.sendGraphUtxosSource = graphUtxos;
      this.sendGraphFrozenSource = this.context.graphFrozenOutpoints;
      this.sendGraphUtxosCache = graphUtxos.filter((utxo) => !this.context.graphFrozenOutpoints.has(this.context.outpoint(utxo)));
    }
    return this.sendGraphUtxosCache;
  }

  destroy(): void {
    this.resetSendFlow();
    this.subscription.unsubscribe();
  }
}
