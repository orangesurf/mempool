import { AnimatedPsbtQrDecoder, encodeBbqrPsbt, encodeUrPsbt } from './psbt-qr.utils';

const KNOWN_PSBT = 'cHNidP8BAHECAAAAARERERERERERERERERERERERERERERERERERERERERERAAAAAAD9////AkCcAAAAAAAAFgAUnJD5NOpR+g9lBBdwQ+CQjaaSmYNG6QAAAAAAABYAFD40mF3Kb93J+zaZQOTH2OKHP1KcAAAAAAABAR+ghgEAAAAAABYAFMDOvNbD08qMddxexi6+VTMO+RDiIgIDMNVP0N1CCm5fjTYk9fNILK41D3nV8HU79b7vnC2RrzxIMEUCIQD4PXanha+qezOhjAr78JDwpirMecjwsrwz+9dYfWVUlQIgG04xIUL4CXBrLKTVXAZp1+8ZSHxYj2ZKebIbMXZAKAsBIgYDMNVP0N1CCm5fjTYk9fNILK41D3nV8HU79b7vnC2RrzwYc8XaClQAAIAAAACAAAAAgAAAAAAAAAAAAAAiAgMCUySIjkKauOPbrx94AmSLnNAem0GEhcX6TBubVwDhphhzxdoKVAAAgAAAAIAAAACAAQAAAAAAAAAA';

describe('animated PSBT QR transport', () => {
  const psbt = Uint8Array.from(Buffer.from(KNOWN_PSBT, 'base64'));

  it('round-trips the exact PSBT bytes through UR fountain parts', () => {
    const encoded = encodeUrPsbt(psbt, 45);
    expect(encoded.partCount).toBeGreaterThan(1);
    expect(encoded.frames.length).toBeGreaterThan(encoded.partCount);

    const decoder = new AnimatedPsbtQrDecoder();
    const order = [encoded.frames[encoded.partCount], ...encoded.frames.slice(0, encoded.partCount).reverse()];
    let decoded: Uint8Array | undefined;
    for (const frame of order) {
      decoded = decoder.receivePart(frame).bytes ?? decoded;
    }

    expect(decoded).toBeDefined();
    expect(Buffer.from(decoded!)).toEqual(Buffer.from(psbt));
  });

  it('round-trips the exact PSBT bytes through BBQr parts', () => {
    const encoded = encodeBbqrPsbt(psbt, { minVersion: 5, maxVersion: 5 });
    expect(encoded.frames.length).toBeGreaterThan(1);

    const decoder = new AnimatedPsbtQrDecoder();
    let decoded: Uint8Array | undefined;
    for (const frame of [...encoded.frames].reverse()) {
      decoded = decoder.receivePart(frame).bytes ?? decoded;
    }

    expect(decoded).toBeDefined();
    expect(Buffer.from(decoded!)).toEqual(Buffer.from(psbt));
  });

  it('accepts single-frame UR, BBQr, and plain PSBT QRs', () => {
    const small = Uint8Array.from([0x70, 0x73, 0x62, 0x74, 0xff, 0x00]);
    const frames = [encodeUrPsbt(small).frames[0], encodeBbqrPsbt(small).frames[0], '70736274ff00'];

    for (const frame of frames) {
      const decoded = new AnimatedPsbtQrDecoder().receivePart(frame).bytes;
      expect(Buffer.from(decoded!)).toEqual(Buffer.from(small));
    }
  });
});
