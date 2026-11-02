import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { ScanProgress } from '@app/watch/services/wallet-scanner.service';

/** One line of scan progress: what has been found so far, or why the scan is waiting. */
@Component({
  selector: 'app-watch-scan-status',
  templateUrl: './watch-scan-status.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false,
})
export class WatchScanStatusComponent {
  @Input({ required: true }) progress!: ScanProgress;
  /**
   * False while refreshing a wallet that is already on screen: the running totals of the
   * new scan would contradict the figures shown, so say only that it is updating.
   */
  @Input() showCounts = true;
}
