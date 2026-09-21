import { Component } from '@angular/core';
import { WatchSectionComponent } from '../watch-section.component';

@Component({
  selector: 'app-watch-addresses',
  templateUrl: './watch-addresses.component.html',
  styleUrls: ['./watch-addresses.component.scss'],
  standalone: false,
})
export class WatchAddressesComponent extends WatchSectionComponent {}
