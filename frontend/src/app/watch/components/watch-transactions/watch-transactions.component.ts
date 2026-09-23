import { Component, Input } from '@angular/core';
import type { WatchTransactionsModel } from '../watch-section.types';

@Component({
  selector: 'app-watch-transactions',
  templateUrl: './watch-transactions.component.html',
  styleUrls: ['./watch-transactions.component.scss'],
  standalone: false,
})
export class WatchTransactionsComponent {
  @Input({ required: true }) model!: WatchTransactionsModel;}
