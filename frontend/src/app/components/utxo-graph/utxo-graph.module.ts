import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgxEchartsModule } from 'ngx-echarts';
import { SharedModule } from '@app/shared/shared.module';
import { UtxoGraphComponent } from '@components/utxo-graph/utxo-graph.component';

/**
 * UtxoGraphComponent used to be declared directly in GraphsModule, so the only way to reuse
 * it was to import GraphsModule — dragging in GraphsRoutingModule and its route table.
 *
 * Extracting it (exactly as AddressGraphModule already did for the balance-history chart)
 * lets the watch-only wallet render the same UTXO bubble graph the address page shows,
 * without pulling in the graphs route tree.
 *
 * Note this imports NgxEchartsModule but does NOT call forRoot(): the echarts config provider
 * is supplied by whichever feature module loads the chart (GraphsModule already does; the
 * WatchModule does its own). echarts itself stays lazily imported.
 */
@NgModule({
  declarations: [
    UtxoGraphComponent,
  ],
  imports: [
    CommonModule,
    SharedModule,
    NgxEchartsModule,
  ],
  exports: [
    UtxoGraphComponent,
  ],
})
export class UtxoGraphModule {}
