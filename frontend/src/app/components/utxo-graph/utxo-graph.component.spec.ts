import { of } from 'rxjs';

import { Utxo } from '@interfaces/electrs.interface';
import { UtxoGraphComponent } from './utxo-graph.component';

describe('UtxoGraphComponent', () => {
  let component: UtxoGraphComponent;
  const outpoint = `${'a'.repeat(64)}:1`;
  const utxo: Utxo = {
    txid: 'a'.repeat(64),
    vout: 1,
    value: 100_000,
    status: { confirmed: false },
  };

  beforeEach(() => {
    const stateService = {
      isBrowser: false,
      network: 'mainnet',
      liveAccelerations$: of([]),
    };
    const changeDetector = { markForCheck: jasmine.createSpy('markForCheck') };
    const zone = { run: (callback: () => void) => callback() };
    const router = { navigate: jasmine.createSpy('navigate') };
    const relativeUrlPipe = { transform: (value: string) => value };
    const timeService = { calculate: () => ({ text: 'recently', tooltip: '' }) };
    const websocketService = {
      startTrackAccelerations: jasmine.createSpy('startTrackAccelerations'),
      stopTrackAccelerations: jasmine.createSpy('stopTrackAccelerations'),
    };

    component = new UtxoGraphComponent(
      stateService as any,
      changeDetector as any,
      zone as any,
      router as any,
      relativeUrlPipe as any,
      timeService as any,
      websocketService as any,
    );
    component.utxos = [utxo];
  });

  afterEach(() => component.ngOnDestroy());

  function renderedBubble(): any {
    component.prepareChartOptions(component.utxos);
    const series = (component.chartOptions as any).series[0];
    return series.renderItem(
      { dataIndex: 0 },
      { getWidth: () => 320, getHeight: () => 320 },
    );
  }

  it('uses opaque, concrete theme fallbacks and an outline for selected coins', () => {
    component.selectable = true;
    component.selectedOutpoints = new Set([outpoint]);

    const bubble = renderedBubble();
    const surface = bubble.children.find((child) => child.name === 'surface');
    const series = (component.chartOptions as any).series[0];

    expect(surface.style.fill).toBe('#007cfa');
    expect(surface.style.opacity).toBe(1);
    expect(surface.style.stroke).toBe('#ffffff');
    expect(surface.style.lineWidth).toBeGreaterThan(0);
    expect(series.animationDuration).toBe(0);
    expect(series.animationDurationUpdate).toBe(0);

    component.selectedOutpoints = new Set();
    const unselectedSurface = renderedBubble().children.find((child) => child.name === 'surface');
    expect(unselectedSurface.style.fill).toBe('#6225b2');
    expect(unselectedSurface.style.fill).not.toBe(surface.style.fill);
  });

  it('keeps coin text opaque while the selectable bubble is hovered', () => {
    component.selectable = true;
    component.labels = { [outpoint]: 'Savings' };

    const bubble = renderedBubble();
    const label = bubble.children.find((child) => child.name === 'label');
    const amount = bubble.children.find((child) => child.name === 'amount');

    expect(label.silent).toBe(true);
    expect(label.emphasis.style).toEqual(jasmine.objectContaining({ fill: '#fff', opacity: 1 }));
    expect(amount.silent).toBe(true);
    expect(amount.emphasis.style).toEqual(jasmine.objectContaining({ fill: '#fff', opacity: 1 }));
    expect(bubble.blur.style.opacity).toBe(1);
  });

  it('uses one restrained pulse for freeze transitions', () => {
    component.frozenOutpoints = new Set([outpoint]);
    (component as any).freezeAnimations.set(outpoint, 'freeze');

    const bubble = renderedBubble();
    const surface = bubble.children.find((child) => child.name === 'surface');
    const pulse = bubble.children.filter((child) => child.name === 'state-pulse');

    expect(surface.keyframeAnimation.duration).toBe(520);
    expect(pulse.length).toBe(1);
    expect(bubble.children.some((child) => child.type === 'line')).toBe(false);
  });

  it('escapes and displays all supplied tooltip label details', () => {
    component.labels = { [outpoint]: 'Primary <output>' };
    component.labelDetails = {
      [outpoint]: [
        'Transaction: Pay & receive',
        'Address: Savings <cold>',
      ],
    };
    component.prepareChartOptions(component.utxos);
    const options = component.chartOptions as any;
    const tooltip = options.tooltip.formatter({ data: options.series[0].data[0] });

    expect(tooltip).toContain('Primary &lt;output&gt;');
    expect(tooltip).toContain('Transaction: Pay &amp; receive');
    expect(tooltip).toContain('Address: Savings &lt;cold&gt;');
    expect(tooltip).not.toContain('<cold>');
  });
});
