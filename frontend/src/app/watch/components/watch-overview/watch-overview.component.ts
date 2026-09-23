import { Component, Input } from '@angular/core';
import type { WatchOverviewModel } from '../watch-section.types';

@Component({
  selector: 'app-watch-overview',
  templateUrl: './watch-overview.component.html',
  styleUrls: ['./watch-overview.component.scss'],
  standalone: false,
})
export class WatchOverviewComponent {
  @Input({ required: true }) model!: WatchOverviewModel;}
