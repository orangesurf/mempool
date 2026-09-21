import { Component } from '@angular/core';
import { WatchSectionComponent } from '../watch-section.component';

@Component({
  selector: 'app-watch-transactions',
  templateUrl: './watch-transactions.component.html',
  styleUrls: ['./watch-transactions.component.scss'],
  standalone: false,
})
export class WatchTransactionsComponent extends WatchSectionComponent {}
