import { ChangeDetectionStrategy, Component, ElementRef, EventEmitter, Input, OnChanges, Output, SimpleChanges, ViewChild } from '@angular/core';
import { StateService } from '@app/services/state.service';
import { DEFAULT_GAP_LIMIT, MAX_GAP_LIMIT, MIN_GAP_LIMIT, WalletSessionService } from '@app/watch/services/wallet-session.service';
import { accountPath, WalletView } from '@app/watch/wallet-math';
import { BARE_KEY_SCRIPT_OPTIONS, scriptTypeName } from '@app/watch/script-type-name';
import { describeScriptType, isBareExtendedKey, isBareKeyScriptType } from '@app/watch/watch-key.utils';
import { DescriptorWallet, ScriptType } from '@app/watch/watch.types';

/**
 * Rename, gap limit, technical details, and removing the wallet from this browser. An
 * address list has no key details or gap limit, so it shows its address count instead.
 */
@Component({
  selector: 'app-watch-settings',
  templateUrl: './watch-settings.component.html',
  styleUrls: ['./watch-settings.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false,
})
export class WatchSettingsComponent implements OnChanges {
  @Input({ required: true }) view!: WalletView;
  @Input() scanning = false;
  @Output() forgotten = new EventEmitter<void>();
  @ViewChild('renameInput') renameInput?: ElementRef<HTMLInputElement>;

  readonly minGapLimit = MIN_GAP_LIMIT;
  readonly maxGapLimit = MAX_GAP_LIMIT;
  readonly scriptTypes = BARE_KEY_SCRIPT_OPTIONS;

  /** The active wallet when it is a descriptor wallet; null for an address list. */
  descriptorWallet: DescriptorWallet | null = null;
  /** An address list, one per line, for the copy button. */
  addressListText = '';
  editingLabel = false;
  labelDraft = '';
  gapLimit = DEFAULT_GAP_LIMIT;
  scriptType = { name: '', code: '' };
  path: string | undefined;
  /** A bare xpub/tpub wallet, whose address type was chosen or guessed at import and can be changed. */
  scriptTypeChangeable = false;
  /** The address type picked for a bare xpub/tpub wallet; null for any other wallet. */
  scriptTypeDraft: ScriptType | null = null;
  networkName = '';
  confirmingForget = false;

  constructor(
    private session: WalletSessionService,
    private stateService: StateService,
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    const previous = changes.view?.previousValue as WalletView | undefined;
    if (previous?.wallet !== this.view.wallet) {
      const wallet = this.view.wallet;
      this.descriptorWallet = wallet.kind === 'descriptor' ? wallet : null;
      if (this.descriptorWallet) {
        this.gapLimit = this.descriptorWallet.gapLimit;
        const type = this.descriptorWallet.scriptType;
        this.scriptType = { name: scriptTypeName(type), code: describeScriptType(type).code };
        this.scriptTypeChangeable = isBareExtendedKey(this.descriptorWallet.source);
        this.scriptTypeDraft = isBareKeyScriptType(type) ? type : null;
      }
      this.addressListText = wallet.kind === 'address-list' ? wallet.addresses.map((a) => a.address).join('\n') : '';
      this.path = accountPath(wallet);
      // The wallets shown are always the page's network's.
      this.networkName = this.stateService.networkDisplayName;
      if (previous?.wallet.id !== wallet.id) {
        this.editingLabel = false;
        this.confirmingForget = false;
      }
    }
  }

  startRename(): void {
    this.labelDraft = this.view.wallet.label;
    this.editingLabel = true;
    // The input only exists once *ngIf has rendered it.
    setTimeout(() => this.renameInput?.nativeElement.focus());
  }

  saveRename(): void {
    this.session.rename(this.labelDraft);
    this.editingLabel = false;
  }

  applyGapLimit(): void {
    this.session.setGapLimit(this.gapLimit);
  }

  applyScriptType(): void {
    if (this.scriptTypeDraft) {
      this.session.changeScriptType(this.scriptTypeDraft);
    }
  }

  forget(): void {
    this.session.forget();
    this.forgotten.emit();
  }
}
