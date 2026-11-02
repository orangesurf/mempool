import { ChangeDetectionStrategy, Component, OnDestroy, OnInit } from '@angular/core';
import { SeoService } from '@app/services/seo.service';
import { StateService } from '@app/services/state.service';
import { ThemeService } from '@app/services/theme.service';
import { WebsocketService } from '@app/services/websocket.service';
import { merge, Observable, of, Subscription } from 'rxjs';
import { distinctUntilChanged, filter, map } from 'rxjs/operators';
import { WalletSessionService } from '@app/watch/services/wallet-session.service';
import { WalletTrackerService } from '@app/watch/services/wallet-tracker.service';

export type WatchTab = 'overview' | 'transactions' | 'utxos' | 'addresses' | 'settings';

/**
 * The /wallet page: the import form when there is no wallet (or another is being added),
 * otherwise the active wallet's tabs.
 */
@Component({
  selector: 'app-watch',
  templateUrl: './watch.component.html',
  styleUrls: ['./watch.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false,
  // Page-scoped, so live tracking stops when the user leaves the page.
  providers: [WalletSessionService, WalletTrackerService],
})
export class WatchComponent implements OnInit, OnDestroy {
  activeTab: WatchTab = 'overview';
  /** The light theme gets the logo with the navy wordmark. */
  readonly isLightMode$: Observable<boolean>;
  private subscription: Subscription;

  constructor(
    public session: WalletSessionService,
    private stateService: StateService,
    private websocketService: WebsocketService,
    private seoService: SeoService,
    themeService: ThemeService,
  ) {
    this.isLightMode$ = themeService.themeState$.pipe(
      filter((state) => !state.loading),
      map((state) => state.theme === 'nymkappa'),
      distinctUntilChanged(),
    );
  }

  ngOnInit(): void {
    this.seoService.setTitle($localize`:@@watch.title:Wallet`);
    this.seoService.setDescription($localize`:@@meta.description.wallet:Follow a Bitcoin wallet from its descriptor, extended public key or address list: balance, transactions, UTXOs and addresses. Addresses are derived in your browser and the key is never sent.`);
    let firstNetwork = true;
    // networkChanged$ does not emit for mainnet on first load, so start from the current value.
    this.subscription = merge(of(this.stateService.network), this.stateService.networkChanged$)
      .pipe(distinctUntilChanged())
      .subscribe((network) => {
        // The backend sends blocks only to connections that ask for them; the wallet
        // refreshes on each one. A network change opens a new connection that has not asked
        // yet, while want() skips a request equal to the last one, hence the force.
        this.websocketService.want(['blocks'], !firstNetwork);
        firstNetwork = false;
        this.activeTab = 'overview';
        this.session.setNetwork(network);
      });
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
    this.seoService.resetTitle();
    this.seoService.resetDescription();
  }
}
