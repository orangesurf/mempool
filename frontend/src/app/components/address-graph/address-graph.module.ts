import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgxEchartsModule } from 'ngx-echarts';
import { SharedModule } from '@app/shared/shared.module';
import { AddressGraphComponent } from '@components/address-graph/address-graph.component';

/**
 * AddressGraphComponent used to be declared directly in GraphsModule, which meant the only
 * way to reuse it was to import GraphsModule — dragging in GraphsRoutingModule and its
 * route table with it.
 *
 * Extracting it lets the watch-only wallet render the same balance-history chart over its
 * whole wallet, exactly as the enterprise wallet page already does, without pulling in the
 * graphs route tree.
 *
 * Note this imports NgxEchartsModule but does NOT call forRoot(): the echarts config
 * provider is supplied by whichever feature module loads the chart (GraphsModule already
 * does; WatchModule does its own). echarts itself stays lazily imported.
 */
@NgModule({
  declarations: [
    AddressGraphComponent,
  ],
  imports: [
    CommonModule,
    SharedModule,
    NgxEchartsModule,
  ],
  exports: [
    AddressGraphComponent,
  ],
})
export class AddressGraphModule {}
