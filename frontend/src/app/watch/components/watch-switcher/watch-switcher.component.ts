import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { WalletPageState, WalletSessionService } from '@app/watch/services/wallet-session.service';
import { WatchWallet } from '@app/watch/watch.types';

/** Dropdown that shows the active wallet and switches between the saved ones. */
@Component({
  selector: 'app-watch-switcher',
  templateUrl: './watch-switcher.component.html',
  styleUrls: ['./watch-switcher.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false,
})
export class WatchSwitcherComponent {
  @Input({ required: true }) state!: WalletPageState;
  @Output() openSettings = new EventEmitter<void>();

  constructor(public session: WalletSessionService) {}

  get activeLabel(): string {
    return this.session.activeWallet?.label ?? '';
  }

  /** Shown beside the name to tell wallets apart; an address list has no key to fingerprint. */
  fingerprintOf(wallet: WatchWallet | null): string {
    return wallet?.kind === 'descriptor' ? wallet.fingerprint ?? '' : '';
  }

  showSettings(id: string): void {
    if (id !== this.state.activeId || this.state.adding) {
      this.session.activate(id);
    }
    this.openSettings.emit();
  }
}
