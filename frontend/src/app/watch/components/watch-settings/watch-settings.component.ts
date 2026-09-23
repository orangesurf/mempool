import { Component, ElementRef, Input, ViewChild } from '@angular/core';
import type { WatchSettingsModel } from '../watch-section.types';

@Component({
  selector: 'app-watch-settings',
  templateUrl: './watch-settings.component.html',
  styleUrls: ['./watch-settings.component.scss'],
  standalone: false,
})
export class WatchSettingsComponent {
  @Input({ required: true }) model!: WatchSettingsModel;
  @ViewChild('renameInput') renameInput?: ElementRef<HTMLInputElement>;

  startRename(): void {
    this.model.startRename();
    setTimeout(() => this.renameInput?.nativeElement.focus());
  }
}
