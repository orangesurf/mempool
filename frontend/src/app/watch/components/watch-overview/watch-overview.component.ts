import { Component, ElementRef, ViewChild } from '@angular/core';
import { WatchSectionComponent } from '../watch-section.component';

@Component({
  selector: 'app-watch-overview',
  templateUrl: './watch-overview.component.html',
  styleUrls: ['./watch-overview.component.scss'],
  standalone: false,
})
export class WatchOverviewComponent extends WatchSectionComponent {
  @ViewChild('renameInput') renameInput?: ElementRef<HTMLInputElement>;

  startRename(): void {
    this.run('startRename');
    setTimeout(() => this.renameInput?.nativeElement.focus());
  }
}
