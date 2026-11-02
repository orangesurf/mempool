import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { DEFAULT_GAP_LIMIT, WalletPageState, WalletSessionService } from '@app/watch/services/wallet-session.service';
import { countListedAddresses, looksLikeAddressList } from '@app/watch/address-list';
import { BARE_KEY_SCRIPT_OPTIONS, scriptTypeName } from '@app/watch/script-type-name';
import { isBareExtendedKey, looksLikeDescriptor } from '@app/watch/watch-key.utils';
import { ScriptType } from '@app/watch/watch.types';

/** Import form: a wallet name plus a descriptor, address list or extended public key; Load appears once both are filled in. */
@Component({
  selector: 'app-watch-import',
  templateUrl: './watch-import.component.html',
  styleUrls: ['./watch-import.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false,
})
export class WatchImportComponent {
  @Input({ required: true }) state!: WalletPageState;

  readonly scriptTypes = BARE_KEY_SCRIPT_OPTIONS;
  readonly scriptTypeName = scriptTypeName;

  keyInput = '';
  label = '';
  scriptTypeHint: ScriptType = 'wpkh';
  /**
   * True once the user has picked an address type. Until then a bare xpub's type is looked
   * up from on-chain history, and the picker's default is used only if none has any.
   */
  scriptTypeChosen = false;

  constructor(public session: WalletSessionService) {}

  /** The Load button appears once both fields are filled in. */
  get canLoad(): boolean {
    return !!this.label.trim() && !!this.keyInput.trim();
  }

  /** A bare xpub/tpub does not say which script type it uses, so we ask. */
  get needsScriptTypeHint(): boolean {
    const input = this.keyInput.trim();
    return input.startsWith('xpub') || input.startsWith('tpub');
  }

  /** The address types that had history, worded for the "choose one" prompt. */
  choiceNames(types: ScriptType[]): string {
    return types.map((t) => scriptTypeName(t)).join(', ');
  }

  chooseScriptType(type: ScriptType): void {
    this.scriptTypeHint = type;
    this.scriptTypeChosen = true;
  }

  /** Load as one of the types offered after several had history. */
  async importAs(type: ScriptType): Promise<void> {
    this.chooseScriptType(type);
    await this.import();
  }

  /**
   * Preview of what was pasted. The worker gives the authoritative answer on import; the
   * prefix is enough for a hint.
   */
  get detectedInput(): string {
    const input = this.keyInput.trim();
    if (!input) {
      return '';
    }
    if (looksLikeDescriptor(input)) {
      return $localize`:@@watch.detected-descriptor:Output descriptor`;
    }
    if (looksLikeAddressList(input)) {
      const count = countListedAddresses(input);
      return count === 1
        ? $localize`:@@watch.detected-address-list-one:Address list (1 address)`
        : $localize`:@@watch.detected-address-list:Address list (${count}:count: addresses)`;
    }
    if (this.needsScriptTypeHint) {
      return $localize`:@@watch.detected-xpub:Extended public key`;
    }
    if (/^[zv]pub/.test(input)) {
      return scriptTypeName('wpkh');
    }
    if (/^[yu]pub/.test(input)) {
      return scriptTypeName('sh_wpkh');
    }
    return '';
  }

  async import(): Promise<void> {
    // Enter in the name field submits the form even while the Load button is hidden.
    if (!this.canLoad) {
      return;
    }
    const bareKey = this.needsScriptTypeHint;
    await this.session.importWallet({
      input: this.keyInput,
      label: this.label,
      gapLimit: DEFAULT_GAP_LIMIT,
      scriptTypeHint: bareKey ? this.scriptTypeHint : undefined,
      detectScriptType: bareKey && !this.scriptTypeChosen && isBareExtendedKey(this.keyInput),
    });
    if (!this.session.state.error && !this.session.state.scriptTypeChoices) {
      this.keyInput = '';
      this.scriptTypeChosen = false;
    }
  }
}
