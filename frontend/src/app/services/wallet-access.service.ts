import { Injectable, Injector } from '@angular/core';
import { Observable, of } from 'rxjs';
import { distinctUntilChanged, map, shareReplay } from 'rxjs/operators';
import { StateService } from '@app/services/state.service';
import { IUser, ServicesApiServices } from '@app/services/services-api.service';

/** The mempool.space account feature that invites a user to the wallet. */
const WALLET_INVITE_FEATURE = 'mempool-wallet';

/**
 * Whether an account has the wallet invite. `features` is a comma-separated list with no
 * spaces, possibly starting with an empty entry. Match whole names only: `wallet` and
 * `apiwallet` are other features.
 */
export function hasWalletInvite(user: IUser | null | undefined): boolean {
  return typeof user?.features === 'string' && user.features.split(',').includes(WALLET_INVITE_FEATURE);
}

/**
 * The mempool networks the wallet runs on ('' is mainnet). Not Liquid, whose confidential
 * transactions need blinding keys, not testnet4, where /testnet4/wallet is the address-group
 * page, and not regtest, whose addresses the wallet does not derive.
 */
const WALLET_NETWORKS = ['', 'testnet', 'signet'];

/**
 * Whether this visitor may use the watch-only wallet at /wallet: WALLET_ENABLED, either no
 * invite is required or the account has the invite, and the network is one the wallet runs on.
 *
 * The route guard and the navigation link both read this, so they cannot disagree. It
 * holds no wallet code, so it is safe to inject anywhere without loading the wallet.
 */
@Injectable({
  providedIn: 'root'
})
export class WalletAccessService {
  /** Emits once the answer is known (after the account lookup, when an invite is required), then on login changes. */
  readonly walletAvailable$: Observable<boolean>;

  constructor(private stateService: StateService, injector: Injector) {
    const { WALLET_ENABLED, WALLET_REQUIRES_INVITE } = stateService.env;
    if (WALLET_ENABLED !== true) {
      this.walletAvailable$ = of(false);
    } else if (WALLET_REQUIRES_INVITE !== true) {
      this.walletAvailable$ = of(true);
    } else {
      // Only looked up when needed, so instances without a services backend never touch it.
      // userSubject$ replays the account fetched at startup (null when logged out) and
      // emits again when the login changes.
      this.walletAvailable$ = injector.get(ServicesApiServices).userSubject$.pipe(
        map(hasWalletInvite),
        distinctUntilChanged(),
        shareReplay({ bufferSize: 1, refCount: false }),
      );
    }
  }

  /** Whether the wallet runs on a mempool network ('' is mainnet, as in StateService.network). */
  runsOn(network: string): boolean {
    return WALLET_NETWORKS.includes(network);
  }

  /**
   * The mempool network of a URL, read the way StateService.setNetworkBasedonUrl reads it.
   * The route guard needs it because StateService.network can still hold the previous page's
   * network while routes are matched, notably on the first load.
   */
  networkOfUrl(url: string): string {
    const env = this.stateService.env;
    const match = url.match(/^\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?(?:preview\/)?(testnet4?|signet|regtest)(?:$|[/?#])/);
    const network = match?.[1] ?? env.ROOT_NETWORK ?? '';
    if (env.BASE_MODULE === 'liquid') {
      return network === 'testnet' ? 'liquidtestnet' : 'liquid';
    }
    return network;
  }
}
