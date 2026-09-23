import { Component, Input } from '@angular/core';

@Component({
  selector: 'app-address-qr-copy',
  templateUrl: './address-qr-copy.component.html',
  styleUrls: ['./address-qr-copy.component.scss'],
  standalone: false,
})
export class AddressQrCopyComponent {
  @Input({ required: true }) address = '';
  @Input() clipboardSize: 'small' | 'normal' | 'large' = 'normal';
  @Input() qrSize = 200;
  @Input() qrMargin = 4;

  showQr = false;
  private pinned = false;

  openQr(): void {
    this.showQr = true;
  }

  closeQr(): void {
    if (!this.pinned) {
      this.showQr = false;
    }
  }

  toggleQr(): void {
    this.pinned = !this.pinned;
    this.showQr = this.pinned;
  }
}
