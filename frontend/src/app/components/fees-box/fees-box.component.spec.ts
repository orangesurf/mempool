import { FeesBoxComponent } from './fees-box.component';

describe('FeesBoxComponent', () => {
  const fees = {
    minimumFee: 1,
    economyFee: 2,
    hourFee: 4,
    halfHourFee: 8,
    fastestFee: 16,
  } as any;

  function component(rate: number): FeesBoxComponent {
    const instance = new FeesBoxComponent({} as any, {} as any, {} as any);
    instance.markerFeeRate = rate;
    return instance;
  }

  it('anchors recommendation rates to the centres of their independent value cells', () => {
    expect(component(2).markerPosition(fees)).toBe(12.5);
    expect(component(4).markerPosition(fees)).toBe(37.5);
    expect(component(8).markerPosition(fees)).toBe(62.5);
    expect(component(16).markerPosition(fees)).toBe(87.5);
  });

  it('interpolates only between adjacent recommendation cells', () => {
    expect(component(3).markerPosition(fees)).toBe(25);
    expect(component(6).markerPosition(fees)).toBe(50);
  });
});
