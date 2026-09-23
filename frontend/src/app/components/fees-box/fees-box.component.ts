import { Component, OnInit, ChangeDetectionStrategy, OnDestroy, ChangeDetectorRef, EventEmitter, Input, Output } from '@angular/core';
import { StateService } from '@app/services/state.service';
import { Observable, combineLatest, Subscription } from 'rxjs';
import { Recommendedfees } from '@interfaces/websocket.interface';
import { feeLevels } from '@app/app.constants';
import { map, startWith, tap } from 'rxjs/operators';
import { ThemeService } from '@app/services/theme.service';

@Component({
  selector: 'app-fees-box',
  templateUrl: './fees-box.component.html',
  styleUrls: ['./fees-box.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false,
})
export class FeesBoxComponent implements OnInit, OnDestroy {
  @Input() showFiat = true;
  @Input() transactionVsize: number | null = null;
  @Input() markerFeeRate: number | null = null;
  @Input() selectable = false;
  @Output() feeRateSelected = new EventEmitter<number>();
  isLoading$: Observable<boolean>;
  recommendedFees$: Observable<Recommendedfees>;
  themeStateSubscription: Subscription;
  gradient = 'linear-gradient(to right, var(--skeleton-bg), var(--skeleton-bg))';
  noPriority = 'var(--skeleton-bg)';
  fees: Recommendedfees;

  constructor(
    private stateService: StateService,
    private themeService: ThemeService,
    private cd: ChangeDetectorRef,
  ) { }

  ngOnInit(): void {
    this.isLoading$ = combineLatest(
      this.stateService.isLoadingWebSocket$.pipe(startWith(false)),
      this.stateService.loadingIndicators$.pipe(startWith({ mempool: 0 })),
    ).pipe(map(([socket, indicators]) => {
      return socket || (indicators.mempool != null && indicators.mempool !== 100);
    }));
    this.recommendedFees$ = this.stateService.recommendedFees$
      .pipe(
        tap((fees) => {
          this.fees = fees;
          this.setFeeGradient();
        }
      )
    );
    this.themeStateSubscription = this.themeService.themeState$.subscribe((state) => {
      if (!state.loading) {
        this.setFeeGradient();
      }
    });
  }

  setFeeGradient() {
    if (!this.fees || !this.themeService.mempoolFeeColors) {
      return;
    }
    let feeLevelIndex = feeLevels.slice().reverse().findIndex((feeLvl) => this.fees.minimumFee >= feeLvl);
    feeLevelIndex = feeLevelIndex >= 0 ? feeLevels.length - feeLevelIndex : feeLevelIndex;
    const startColor = '#' + (this.themeService.mempoolFeeColors[feeLevelIndex - 1] || this.themeService.mempoolFeeColors[this.themeService.mempoolFeeColors.length - 1]);

    feeLevelIndex = feeLevels.slice().reverse().findIndex((feeLvl) => this.fees.fastestFee >= feeLvl);
    feeLevelIndex = feeLevelIndex >= 0 ? feeLevels.length - feeLevelIndex : feeLevelIndex;
    const endColor = '#' + (this.themeService.mempoolFeeColors[feeLevelIndex - 1] || this.themeService.mempoolFeeColors[this.themeService.mempoolFeeColors.length - 1]);

    this.gradient = `linear-gradient(to right, ${startColor}, ${endColor})`;
    this.noPriority = startColor;

    this.cd.markForCheck();
  }

  markerPosition(fees: Recommendedfees): number {
    const rate = Number(this.markerFeeRate);
    if (!Number.isFinite(rate)) return 12.5;
    // The four figures below the bar are four equal-width cells. Interpolate within each
    // neighbouring recommendation pair so the marker lands over the figures' actual centres,
    // rather than treating their fee rates as one continuous 0–100 scale.
    const points: Array<[number, number]> = [
      [12.5, fees.economyFee], [37.5, fees.hourFee],
      [62.5, fees.halfHourFee], [87.5, fees.fastestFee],
    ];
    if (rate <= points[0][1]) return points[0][0];
    for (let index = 1; index < points.length; index++) {
      const [upperPosition, upperRate] = points[index];
      const [lowerPosition, lowerRate] = points[index - 1];
      if (rate <= upperRate) {
        if (upperRate <= lowerRate) return upperPosition;
        const fraction = Math.min(1, Math.max(0, (rate - lowerRate) / (upperRate - lowerRate)));
        return lowerPosition + fraction * (upperPosition - lowerPosition);
      }
    }
    return points[points.length - 1][0];
  }

  absoluteFee(rate: number): number {
    return Math.ceil(rate * (this.transactionVsize ?? 140));
  }

  selectFee(rate: number): void {
    if (this.selectable) this.feeRateSelected.emit(rate);
  }

  ngOnDestroy(): void {
    this.themeStateSubscription.unsubscribe();
  }
}
