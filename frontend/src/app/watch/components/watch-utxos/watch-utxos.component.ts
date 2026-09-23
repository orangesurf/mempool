import { Component, Input } from '@angular/core';
import type { WatchUtxosModel } from '../watch-section.types';

@Component({
  selector: 'app-watch-utxos',
  templateUrl: './watch-utxos.component.html',
  styleUrls: ['./watch-utxos.component.scss'],
  standalone: false,
})
export class WatchUtxosComponent {
  @Input({ required: true }) model!: WatchUtxosModel;}
