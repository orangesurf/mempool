import { Component } from '@angular/core';
import { WatchSectionComponent } from '../watch-section.component';

@Component({
  selector: 'app-watch-addresses',
  templateUrl: './watch-addresses.component.html',
  styleUrls: ['./watch-addresses.component.scss'],
  standalone: false,
})
export class WatchAddressesComponent extends WatchSectionComponent {
  qrAddress: string | null = null;
  private pinnedQrAddress: string | null = null;

  showAddressQr(address: string): void {
    this.qrAddress = address;
  }

  hideAddressQr(address: string): void {
    if (this.qrAddress === address && this.pinnedQrAddress !== address) {
      this.qrAddress = null;
    }
  }

  toggleAddressQr(address: string): void {
    if (this.pinnedQrAddress === address) {
      this.pinnedQrAddress = null;
      this.qrAddress = null;
    } else {
      this.pinnedQrAddress = address;
      this.qrAddress = address;
    }
  }
}
