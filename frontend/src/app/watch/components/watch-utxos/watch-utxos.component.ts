import { Component } from '@angular/core';
import { WatchSectionComponent } from '../watch-section.component';

@Component({
  selector: 'app-watch-utxos',
  templateUrl: './watch-utxos.component.html',
  styleUrls: ['./watch-utxos.component.scss'],
  standalone: false,
})
export class WatchUtxosComponent extends WatchSectionComponent {}
