import { Component, ElementRef, ViewChild } from '@angular/core';
import { WatchSectionComponent } from '../watch-section.component';

@Component({
  selector: 'app-watch-send',
  templateUrl: './watch-send.component.html',
  styleUrls: ['./watch-send.component.scss'],
  standalone: false,
})
export class WatchSendComponent extends WatchSectionComponent {
  @ViewChild('psbtQrVideo') psbtQrVideo?: ElementRef<HTMLVideoElement>;

  startQrScan(): void {
    this.run('startSignedPsbtQrScan', () => this.psbtQrVideo?.nativeElement);
  }
}
