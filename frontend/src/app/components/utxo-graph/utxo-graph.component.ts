import { ChangeDetectionStrategy, ChangeDetectorRef, Component, EventEmitter, Input, NgZone, OnChanges, OnDestroy, Output, SimpleChanges } from '@angular/core';
import { EChartsOption } from '@app/graphs/echarts';
import { Subscription } from 'rxjs';
import { Utxo } from '@interfaces/electrs.interface';
import { StateService } from '@app/services/state.service';
import { Router } from '@angular/router';
import { RelativeUrlPipe } from '@app/shared/pipes/relative-url/relative-url.pipe';
import { renderSats } from '@app/shared/common.utils';
import { colorToHex, hexToColor, mix } from '@components/block-overview-graph/utils';
import { TimeService } from '@app/services/time.service';
import { WebsocketService } from '@app/services/websocket.service';
import { Acceleration } from '@interfaces/node-api.interface';
import { defaultAuditColors } from '@components/block-overview-graph/utils';

const newColorHex = '1BF4AF';
const oldColorHex = '3C39F4';
const pendingColorHex = 'eba814';
const frozenColorHex = '9CC8D8';
const selectedFallbackColor = '#007cfa';
const selectableFallbackColor = '#6225b2';
const frostHighlightColor = '#e6fbff';
const frostTransitionColor = '#d5f2f7';
const transparentFrostColor = 'rgba(230, 251, 255, 0)';
const newColor = hexToColor(newColorHex);
const oldColor = hexToColor(oldColorHex);

interface Circle {
  x: number,
  y: number,
  r: number,
  i: number,
}

interface UtxoCircle extends Circle {
  utxo: Utxo;
}

function sortedInsert(positions: { c1: Circle, c2: Circle, d: number, p: number, side?: boolean }[], newPosition: { c1: Circle, c2: Circle, d: number, p: number }): void {
  let left = 0;
  let right = positions.length;
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (positions[mid].p > newPosition.p) {
      right = mid;
    } else {
      left = mid + 1;
    }
  }
  positions.splice(left, 0, newPosition, {...newPosition, side: true });
}
@Component({
  selector: 'app-utxo-graph',
  templateUrl: './utxo-graph.component.html',
  styleUrls: ['./utxo-graph.component.scss'],
  styles: [`
    .loadingGraphs {
      position: absolute;
      top: 50%;
      left: calc(50% - 15px);
      z-index: 99;
    }
  `],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UtxoGraphComponent implements OnChanges, OnDestroy {
  @Input() utxos: Utxo[];
  @Input() height: number = 200;
  @Input() right: number | string = 10;
  @Input() left: number | string = 70;
  @Input() widget: boolean = false;
  @Input() frozenOutpoints: Set<string> = new Set();
  @Input() selectedOutpoints: Set<string> | null = null;
  @Input() labels: Record<string, string> = {};
  /** Extra, already-captioned tooltip lines such as `Transaction: Payroll`. */
  @Input() labelDetails: Record<string, string[]> = {};
  @Input() labelSlots: Set<string> = new Set();
  @Input() selectable: boolean = false;
  @Output() utxoClick = new EventEmitter<Utxo>();

  subscription: Subscription;
  accelerationsSubscription: Subscription;
  lastUpdate: number = 0;
  updateInterval;
  accelerationMap: Record<string, Acceleration> = {};

  chartOptions: EChartsOption = {};
  chartInitOptions = {
    renderer: 'svg',
  };

  error: any;
  isLoading = true;
  chartInstance: any = undefined;
  private freezeAnimations = new Map<string, 'freeze' | 'thaw'>();
  private freezeAnimationTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    public stateService: StateService,
    private cd: ChangeDetectorRef,
    private zone: NgZone,
    private router: Router,
    private relativeUrlPipe: RelativeUrlPipe,
    private timeService: TimeService,
    private websocketService: WebsocketService,
  ) {
    // re-render the chart every 10 seconds, to keep the age colors up to date
    this.updateInterval = setInterval(() => {
      if (this.lastUpdate < Date.now() - 10000 && this.utxos) {
        this.prepareChartOptions(this.utxos);
      }
    }, 10000);

    this.websocketService.startTrackAccelerations();
    this.accelerationsSubscription = this.stateService.liveAccelerations$.subscribe((accelerations) => {
      this.accelerationMap = accelerations.reduce((acc, acceleration) => {
        acc[acceleration.txid] = acceleration;
        return acc;
      }, {});

      this.applyAccelerations();
      this.prepareChartOptions(this.utxos);
    });

  }

  ngOnChanges(changes: SimpleChanges): void {
    this.isLoading = true;
    if (!this.utxos) {
      return;
    }
    const reducedMotion = this.prefersReducedMotion();
    if (reducedMotion) {
      this.freezeAnimations.clear();
    }
    if (changes.frozenOutpoints && !changes.frozenOutpoints.firstChange && !reducedMotion) {
      const before = changes.frozenOutpoints.previousValue as Set<string>;
      const after = changes.frozenOutpoints.currentValue as Set<string>;
      for (const outpoint of after) {
        if (!before.has(outpoint)) this.freezeAnimations.set(outpoint, 'freeze');
      }
      for (const outpoint of before) {
        if (!after.has(outpoint)) this.freezeAnimations.set(outpoint, 'thaw');
      }
      if (this.freezeAnimationTimer) {
        clearTimeout(this.freezeAnimationTimer);
      }
      this.freezeAnimationTimer = setTimeout(() => this.freezeAnimations.clear(), 700);
    }
    if (changes.utxos || changes.frozenOutpoints || changes.selectedOutpoints || changes.labels || changes.labelDetails || changes.labelSlots) {
      this.applyAccelerations();
      this.prepareChartOptions(this.utxos);
    }
  }

  applyAccelerations(): void {
    if (!this.utxos) {
      return;
    }
    for (const utxo of this.utxos) {
      delete utxo.status['accelerated'];
      if (this.accelerationMap[utxo.txid]) {
        utxo.status['accelerated'] = true;
      }
    }
  }

  prepareChartOptions(utxos: Utxo[]): void {
    if (!utxos || utxos.length === 0) {
      return;
    }

    this.isLoading = false;

    // Helper functions
    const distance = (x1: number, y1: number, x2: number, y2: number): number => Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
    const intersection = (c1: Circle, c2: Circle, d: number, r: number, side: boolean): { x: number, y: number} => {
      const d1 = c1.r + r;
      const d2 = c2.r + r;
      const a = (d1 * d1 - d2 * d2 + d * d) / (2 * d);
      const h = Math.sqrt(d1 * d1 - a * a);
      const x3 = c1.x + a * (c2.x - c1.x) / d;
      const y3 = c1.y + a * (c2.y - c1.y) / d;
      return side
        ? { x: x3 + h * (c2.y - c1.y) / d, y: y3 - h * (c2.x - c1.x) / d }
        : { x: x3 - h * (c2.y - c1.y) / d, y: y3 + h * (c2.x - c1.x) / d };
    };

    // ~Linear algorithm to pack circles as tightly as possible without overlaps
    const placedCircles: UtxoCircle[] = [];
    const positions: { c1: Circle, c2: Circle, d: number, p: number, side?: boolean }[] = [];
    // Pack in descending order of value, and limit to the top 500 to preserve performance
    const sortedUtxos = [...utxos].sort((a, b) => {
      if (a.value === b.value) {
        if (a.status.confirmed && !b.status.confirmed) {
          return -1;
        } else if (!a.status.confirmed && b.status.confirmed) {
          return 1;
        } else {
          return a.status.block_height - b.status.block_height;
        }
      }
      return b.value - a.value;
    }).slice(0, 500);
    const maxR = Math.sqrt(sortedUtxos.reduce((max, utxo) => Math.max(max, utxo.value), 0));
    sortedUtxos.forEach((utxo, index) => {
      // area proportional to value
      const r = Math.sqrt(utxo.value);

      // special cases for the first two utxos
      if (index === 0) {
        placedCircles.push({ x: 0, y: 0, r, utxo, i: index });
        return;
      }
      if (index === 1) {
        const c = placedCircles[0];
        placedCircles.push({ x: c.r + r, y: 0, r, utxo, i: index });
        sortedInsert(positions, { c1: c, c2: placedCircles[1], d: c.r + r, p: 0 });
        return;
      }
      if (index === 2) {
        const c = placedCircles[0];
        placedCircles.push({ x: -c.r - r, y: 0, r, utxo, i: index });
        sortedInsert(positions, { c1: c, c2: placedCircles[2], d: c.r + r, p: 0 });
        return;
      }

      // The best position will be touching two other circles
      // find the closest such position to the center of the graph
      // where the circle can be placed without overlapping other circles
      const numCircles = placedCircles.length;
      let newCircle: UtxoCircle = null;
      while (positions.length > 0) {
        const position = positions.shift();
        // if the circles are too far apart, skip
        if (position.d > (position.c1.r + position.c2.r + r + r)) {
          continue;
        }

        const { x, y } = intersection(position.c1, position.c2, position.d, r, position.side);
        if (isNaN(x) || isNaN(y)) {
          // should never happen
          continue;
        }

        // check if the circle would overlap any other circles here
        let valid = true;
        const nearbyCircles: { c: UtxoCircle, d: number, s: number }[] = [];
        for (let k = 0; k < numCircles; k++) {
          const c = placedCircles[k];
          if (k === position.c1.i || k === position.c2.i) {
            nearbyCircles.push({ c, d: c.r + r, s: 0 });
            continue;
          }
          const d = distance(x, y, c.x, c.y);
          if (d < (r + c.r)) {
            valid = false;
            break;
          } else {
            nearbyCircles.push({ c, d, s: d - c.r - r });
          }
        }
        if (valid) {
          newCircle = { x, y, r, utxo, i: index };
          // add new positions to the candidate list
          const nearest = nearbyCircles.sort((a, b) => a.s - b.s).slice(0, 5);
          for (const n of nearest) {
            if (n.d < (n.c.r + r + maxR + maxR)) {
              sortedInsert(positions, { c1: newCircle, c2: n.c, d: n.d, p: distance((n.c.x + x) / 2, (n.c.y + y), 0, 0) });
            }
          }
          break;
        }
      }
      if (newCircle) {
        placedCircles.push(newCircle);
      } else {
        // should never happen
        return;
      }
    });

    // Precompute the bounding box of the graph
    const minX = Math.min(...placedCircles.map(d => d.x - d.r));
    const maxX = Math.max(...placedCircles.map(d => d.x + d.r));
    const minY = Math.min(...placedCircles.map(d => d.y - d.r));
    const maxY = Math.max(...placedCircles.map(d => d.y + d.r));
    const width = maxX - minX;
    const height = maxY - minY;

    const data = placedCircles.map((circle) => [
      this.outpoint(circle.utxo),
      circle.utxo,
      circle.x,
      circle.y,
      circle.r,
    ]);

    // ECharts' SVG animator cannot interpolate CSS var() values. Resolve the Mempool theme
    // colors before handing them to zrender so selection updates never pass through an invalid
    // or transparent intermediate fill.
    const selectedColor = this.themeColor('--primary', selectedFallbackColor);
    const selectableColor = this.themeColor('--tertiary', selectableFallbackColor);
    const selectionOutlineColor = this.themeColor('--fg', '#ffffff');

    this.chartOptions = {
      series: [{
        type: 'custom',
        coordinateSystem: undefined,
        // ngx-echarts replaces `options` rather than merging it. Suppress the custom series'
        // implicit enter/update fade; the deliberate freeze keyframes below remain enabled.
        animation: true,
        animationDuration: 0,
        animationDurationUpdate: 0,
        data: data,
        encode: {
          itemName: 0,
          x: 2,
          y: 3,
          r: 4,
        },
        renderItem: (params, api) => {
          const chartWidth = api.getWidth();
          const chartHeight = api.getHeight();
          const scale = Math.min(chartWidth / width, chartHeight / height);
          const scaledWidth = width * scale;
          const scaledHeight = height * scale;
          const offsetX = (chartWidth - scaledWidth) / 2 - minX * scale;
          const offsetY = (chartHeight - scaledHeight) / 2 - minY * scale;

          const datum = data[params.dataIndex];
          const utxo = datum[1] as Utxo;
          const x = datum[2] as number;
          const y = datum[3] as number;
          const r = datum[4] as number;
          if (r * scale < 2) {
            // skip items too small to render cleanly
            return;
          }

          const valueStr = renderSats(utxo.value, this.stateService.network);
          const outpoint = this.outpoint(utxo);
          const label = this.labels[outpoint];
          const hasLabelSlot = !!label || this.labelSlots.has(outpoint);
          const selected = this.selectedOutpoints?.has(outpoint) ?? false;
          const frozen = this.frozenOutpoints.has(outpoint);
          const freezeAnimation = this.freezeAnimations.get(outpoint);
          const radius = (r * scale) - 1;
          const unfrozenFill = this.selectable
            ? (selected ? 'var(--primary)' : 'var(--tertiary)')
            : '#' + this.baseColor(utxo);
          const resolvedUnfrozenFill = this.selectable
            ? (selected ? selectedColor : selectableColor)
            : unfrozenFill;
          const fill = frozen ? '#' + frozenColorHex : resolvedUnfrozenFill;
          const selectionLineWidth = Math.min(4, Math.max(2, radius * .04));
          const frozenLineWidth = Math.min(3, Math.max(1.5, radius * .03));
          const restingStroke = selected ? selectionOutlineColor : transparentFrostColor;
          const restingLineWidth = selected ? selectionLineWidth : 0;
          const elements: any[] = [
            {
              type: 'circle',
              name: 'surface',
              autoBatch: !freezeAnimation && !this.selectable,
              shape: {
                r: radius,
              },
              style: {
                fill,
                opacity: 1,
                stroke: frozen ? frostHighlightColor : restingStroke,
                lineWidth: frozen ? frozenLineWidth : restingLineWidth,
              },
              emphasis: this.selectable ? {
                z2: 2,
                style: {
                  fill,
                  opacity: 1,
                  stroke: selectionOutlineColor,
                  lineWidth: Math.max(selectionLineWidth, 2.5),
                },
              } : { style: { opacity: 1 } },
              keyframeAnimation: freezeAnimation ? {
                duration: 520,
                easing: 'cubicInOut',
                keyframes: freezeAnimation === 'freeze'
                  ? [
                    { percent: 0, scaleX: 1, scaleY: 1, style: { fill: resolvedUnfrozenFill, stroke: restingStroke, lineWidth: restingLineWidth } },
                    { percent: .48, scaleX: .985, scaleY: .985, style: { fill: frostTransitionColor, stroke: frostHighlightColor, lineWidth: frozenLineWidth } },
                    { percent: 1, scaleX: 1, scaleY: 1, style: { fill: '#' + frozenColorHex, stroke: frostHighlightColor, lineWidth: frozenLineWidth } },
                  ]
                  : [
                    { percent: 0, scaleX: 1, scaleY: 1, style: { fill: '#' + frozenColorHex, stroke: frostHighlightColor, lineWidth: frozenLineWidth } },
                    { percent: .48, scaleX: 1.015, scaleY: 1.015, style: { fill: frostTransitionColor, stroke: frostHighlightColor, lineWidth: frozenLineWidth } },
                    { percent: 1, scaleX: 1, scaleY: 1, style: { fill: resolvedUnfrozenFill, stroke: restingStroke, lineWidth: restingLineWidth } },
                  ],
              } : undefined,
            },
          ];
          if (freezeAnimation) {
            elements.push({
              type: 'circle',
              name: 'state-pulse',
              silent: true,
              shape: { r: radius * .9 },
              style: {
                fill: 'transparent',
                stroke: frostHighlightColor,
                lineWidth: Math.min(3, Math.max(1, radius * .025)),
                opacity: 0,
              },
              keyframeAnimation: {
                duration: freezeAnimation === 'freeze' ? 560 : 440,
                easing: 'cubicInOut',
                keyframes: freezeAnimation === 'freeze'
                  ? [
                    { percent: 0, scaleX: .88, scaleY: .88, style: { opacity: 0 } },
                    { percent: .58, scaleX: 1, scaleY: 1, style: { opacity: .62 } },
                    { percent: 1, scaleX: 1.06, scaleY: 1.06, style: { opacity: 0 } },
                  ]
                  : [
                    { percent: 0, scaleX: 1, scaleY: 1, style: { opacity: .55 } },
                    { percent: 1, scaleX: 1.08, scaleY: 1.08, style: { opacity: 0 } },
                  ],
              },
            });
          }
          const labelFontSize = Math.min(36, r * scale * 0.3);
          if (labelFontSize > 8) {
            if (label) {
              elements.push({
                type: 'text',
                name: 'label',
                silent: true,
                y: -labelFontSize * 0.7,
                style: {
                  text: label.length > 24 ? label.slice(0, 23) + '…' : label,
                  fontSize: Math.max(8, labelFontSize * 0.62),
                  fontWeight: 600,
                  fill: '#fff',
                  align: 'center',
                  verticalAlign: 'middle',
                },
                emphasis: { style: { fill: '#fff', opacity: 1 } },
                blur: { style: { fill: '#fff', opacity: 1 } },
                select: { style: { fill: '#fff', opacity: 1 } },
              });
            }
            elements.push({
              type: 'text',
              name: 'amount',
              silent: true,
              y: hasLabelSlot ? labelFontSize * 0.45 : 0,
              style: {
                text: valueStr,
                fontSize: labelFontSize,
                fill: '#fff',
                align: 'center',
                verticalAlign: 'middle',
              },
              emphasis: { style: { fill: '#fff', opacity: 1 } },
              blur: { style: { fill: '#fff', opacity: 1 } },
              select: { style: { fill: '#fff', opacity: 1 } },
            });
          }
          return {
            type: 'group',
            id: `utxo-${outpoint}`,
            name: outpoint,
            $mergeChildren: 'byName',
            x: (x * scale) + offsetX,
            y: (y * scale) + offsetY,
            cursor: 'pointer',
            focus: 'none',
            emphasis: { style: { opacity: 1 } },
            blur: { style: { opacity: 1 } },
            select: { style: { opacity: 1 } },
            enterAnimation: { duration: 0 },
            updateAnimation: { duration: 0 },
            children: elements,
          };
        },
      }],
      tooltip: {
        backgroundColor: 'rgba(17, 19, 31, 1)',
        borderRadius: 4,
        shadowColor: 'rgba(0, 0, 0, 0.5)',
        textStyle: {
          color: 'var(--tooltip-grey)',
          align: 'left',
        },
        borderColor: '#000',
        formatter: (params: any): string => {
          const utxo = params.data[1] as Utxo;
          const valueStr = renderSats(utxo.value, this.stateService.network);
          const outpoint = this.outpoint(utxo);
          const label = this.labels[outpoint];
          const escapedLabel = label ? this.escapeHtml(label) : '';
          const labelDetails = [...new Set(this.labelDetails[outpoint] ?? [])]
            .filter((detail): detail is string => typeof detail === 'string' && !!detail.trim())
            .map((detail) => `<br><span style="color: var(--tooltip-grey);">${this.escapeHtml(detail)}</span>`)
            .join('');
          return `
          <b style="color: white;">${utxo.txid.slice(0, 6)}...${utxo.txid.slice(-6)}:${utxo.vout}</b>
          ${escapedLabel ? `<br><b style="color: white;">${escapedLabel}</b>` : ''}
          ${labelDetails}
          <br>
          ${valueStr}
          <br>
          ${this.frozenOutpoints.has(outpoint)
            ? 'Frozen'
            : utxo.status.confirmed
            ? (utxo.status.block_time
                ? 'Confirmed ' + this.timeService.calculate(utxo.status.block_time, 'since', true, 1, 'minute').text
                : 'Confirmed')
            : utxo.status['accelerated']
              ? 'Accelerated'
              : 'Pending'
          }
          `;
        },
      }
    };
    this.lastUpdate = Date.now();

    this.cd.markForCheck();
  }

  getColor(utxo: Utxo): string {
    if (this.frozenOutpoints.has(this.outpoint(utxo))) {
      return frozenColorHex;
    }
    return this.baseColor(utxo);
  }

  private baseColor(utxo: Utxo): string {
    if (utxo.status['accelerated']) {
      return colorToHex(defaultAuditColors.accelerated);
    } else if (utxo.status.confirmed) {
      if (!utxo.status.block_time) {
        // Confirmed but no block time (e.g. a source that only knows the output exists, not
        // when) — age is unknown, so fall back to the oldest colour rather than compute NaN.
        return oldColorHex;
      }
      const age = Date.now() / 1000 - utxo.status.block_time;
      const oneHour = 60 * 60;
      const fourYears = 4 * 365 * 24 * 60 * 60;

      if (age < oneHour) {
        return newColorHex;
      } else if (age >= fourYears) {
        return oldColorHex;
      } else {
        // Logarithmic scale between 1 hour and 4 years
        const logAge = Math.log(age / oneHour);
        const logMax = Math.log(fourYears / oneHour);
        const t = logAge / logMax;
        return colorToHex(mix(newColor, oldColor, t));
      }
    } else {
      return pendingColorHex;
    }
  }

  onChartClick(e): void {
    if (e.data?.[1]?.txid) {
      this.zone.run(() => {
        if (this.selectable) {
          this.utxoClick.emit(e.data[1] as Utxo);
          return;
        }
        const url = this.relativeUrlPipe.transform(`/tx/${e.data[1].txid}`);
        if (e.event.event.shiftKey || e.event.event.ctrlKey || e.event.event.metaKey) {
          window.open(url + '?mode=details#vout=' + e.data[1].vout);
        } else {
          this.router.navigate([url], { fragment: `vout=${e.data[1].vout}` });
        }
      });
    }
  }

  private outpoint(utxo: Utxo): string {
    return `${utxo.txid}:${utxo.vout}`;
  }

  private escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
  }

  private themeColor(property: string, fallback: string): string {
    if (!this.stateService.isBrowser || typeof window === 'undefined' || typeof document === 'undefined') {
      return fallback;
    }
    const element = this.chartInstance?.getDom?.() ?? document.documentElement;
    return window.getComputedStyle(element).getPropertyValue(property).trim() || fallback;
  }

  private prefersReducedMotion(): boolean {
    return this.stateService.isBrowser
      && typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  onChartInit(ec): void {
    this.chartInstance = ec;
    this.chartInstance.on('click', 'series', this.onChartClick.bind(this));
  }

  ngOnDestroy(): void {
    if (this.subscription) {
      this.subscription.unsubscribe();
    }
    clearInterval(this.updateInterval);
    if (this.freezeAnimationTimer) {
      clearTimeout(this.freezeAnimationTimer);
    }
    this.websocketService.stopTrackAccelerations();
    this.accelerationsSubscription.unsubscribe();
  }

  isMobile(): boolean {
    return (window.innerWidth <= 767.98);
  }
}
