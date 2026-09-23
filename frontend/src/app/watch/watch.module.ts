import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule, Routes } from '@angular/router';
import { SharedModule } from '@app/shared/shared.module';
import { NgxEchartsModule } from 'ngx-echarts';
import { AddressGraphModule } from '@components/address-graph/address-graph.module';
import { UtxoGraphModule } from '@components/utxo-graph/utxo-graph.module';
import { WatchComponent } from './watch.component';
import { DerivationService } from './services/derivation.service';
import { WalletScannerService } from './services/wallet-scanner.service';
import { WalletTrackerService } from './services/wallet-tracker.service';
import { WatchOverviewComponent } from './components/watch-overview/watch-overview.component';
import { WatchTransactionsComponent } from './components/watch-transactions/watch-transactions.component';
import { WatchUtxosComponent } from './components/watch-utxos/watch-utxos.component';
import { WatchAddressesComponent } from './components/watch-addresses/watch-addresses.component';
import { WatchSendComponent } from './components/watch-send/watch-send.component';
import { WatchSettingsComponent } from './components/watch-settings/watch-settings.component';

const routes: Routes = [
  {
    path: '',
    component: WatchComponent,
  },
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule],
})
export class WatchRoutingModule {}

/**
 * Lazy-loaded watch-only wallet module.
 *
 * DerivationService and WalletScannerService are provided *here*, not in root, so nothing
 * outside this route can pull in the derivation worker (and with it the 8.5 MB WASM).
 * WalletService and WalletStorageService are root-provided instead — they hold only address
 * strings, which is what the rest of the site needs for "is this output mine?" highlighting.
 */
@NgModule({
  declarations: [
    WatchComponent,
    WatchOverviewComponent,
    WatchTransactionsComponent,
    WatchUtxosComponent,
    WatchAddressesComponent,
    WatchSendComponent,
    WatchSettingsComponent,
  ],
  imports: [
    CommonModule,
    FormsModule,
    SharedModule,
    WatchRoutingModule,
    AddressGraphModule,
    UtxoGraphModule,
    // Supplies the echarts config in this lazy injector. echarts itself stays lazily
    // imported, so /watch only pays for it when the chart actually renders.
    NgxEchartsModule.forRoot({
      echarts: () => import('@app/graphs/echarts').then(m => m.echarts),
    }),
  ],
  providers: [
    DerivationService,
    WalletScannerService,
    WalletTrackerService,
  ],
})
export class WatchModule {}
