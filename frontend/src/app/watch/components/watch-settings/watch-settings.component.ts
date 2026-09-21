import { Component } from '@angular/core';
import { WatchSectionComponent } from '../watch-section.component';

@Component({
  selector: 'app-watch-settings',
  templateUrl: './watch-settings.component.html',
  styleUrls: ['./watch-settings.component.scss'],
  standalone: false,
})
export class WatchSettingsComponent extends WatchSectionComponent {}
