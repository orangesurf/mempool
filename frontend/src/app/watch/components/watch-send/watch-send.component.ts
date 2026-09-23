import { Component, ElementRef, Input, ViewChild } from '@angular/core';
import type { WalletSendController } from '../../services/wallet-send.controller';
import type { WatchSendModel } from '../watch-section.types';

@Component({
  selector: 'app-watch-send',
  templateUrl: './watch-send.component.html',
  styleUrls: ['./watch-send.component.scss'],
  standalone: false,
})
export class WatchSendComponent {
  @Input({ required: true }) send!: WalletSendController;
  @Input({ required: true }) model!: WatchSendModel;
  @ViewChild('psbtQrVideo') psbtQrVideo?: ElementRef<HTMLVideoElement>;

  startQrScan(): void {
    this.send.startSignedPsbtQrScan(() => this.psbtQrVideo?.nativeElement);
  }
}
