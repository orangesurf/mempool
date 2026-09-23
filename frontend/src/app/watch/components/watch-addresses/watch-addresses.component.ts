import { Component, Input } from '@angular/core';
import type { WatchAddressesModel } from '../watch-section.types';

@Component({
  selector: 'app-watch-addresses',
  templateUrl: './watch-addresses.component.html',
  styleUrls: ['./watch-addresses.component.scss'],
  standalone: false,
})
export class WatchAddressesComponent {
  @Input({ required: true }) model!: WatchAddressesModel;
}
