import { Buffer } from 'buffer';
import { UR, URDecoder, UREncoder } from '@ngraveio/bc-ur';
import { joinQRs, splitQRs } from 'bbqr';
import type { Version } from 'bbqr';
import { base64ToBytes, normalizePsbtText } from './psbt.utils';

export type PsbtQrEncoding = 'ur' | 'bbqr';
export type PsbtQrProtocol = PsbtQrEncoding | 'plain';

export interface PsbtQrFrames {
  protocol: PsbtQrEncoding;
  frames: string[];
  /** Source fragments needed to reconstruct the payload. UR may include extra fountain frames. */
  partCount: number;
  frameBudget: number;
  qrVersion?: number;
}

export interface PsbtQrDecodeProgress {
  protocol: PsbtQrProtocol;
  received: number;
  needed: number;
  percent: number;
  bytes?: Uint8Array;
}

/** 180 bytes keeps bytewords UR frames readily scannable on a phone-sized 320px QR. */
export const UR_PSBT_FRAGMENT_BYTES = 180;
/** BBQr is alphanumeric-efficient; cap it at version 15 instead of making very dense QRs. */
export const BBQR_MIN_VERSION: Version = 8;
export const BBQR_MAX_VERSION: Version = 15;

// bc-ur targets both Node and browsers but expects the browser Buffer shim to be global.
const urGlobal = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
urGlobal.Buffer ??= Buffer;

function assertPsbt(bytes: Uint8Array): void {
  if (bytes.length < 5 || bytes[0] !== 0x70 || bytes[1] !== 0x73 || bytes[2] !== 0x62
      || bytes[3] !== 0x74 || bytes[4] !== 0xff) {
    throw new Error('The scanned QR does not contain a PSBT.');
  }
}

/** crypto-psbt is a CBOR byte string containing the raw BIP-174 packet. */
function encodeCborByteString(bytes: Uint8Array): Buffer {
  const length = bytes.length;
  let header: number[];
  if (length < 24) {
    header = [0x40 + length];
  } else if (length <= 0xff) {
    header = [0x58, length];
  } else if (length <= 0xffff) {
    header = [0x59, length >>> 8, length & 0xff];
  } else if (length <= 0xffffffff) {
    header = [0x5a, length >>> 24, length >>> 16, length >>> 8, length].map((value, index) =>
      index ? value & 0xff : value,
    );
  } else {
    throw new Error('The PSBT is too large for animated QR transport.');
  }
  return Buffer.concat([Buffer.from(header), Buffer.from(bytes)]);
}

function decodeCborByteString(cbor: Uint8Array): Uint8Array {
  if (!cbor.length || (cbor[0] >>> 5) !== 2) {
    throw new Error('The crypto-psbt UR payload is not a CBOR byte string.');
  }
  const additional = cbor[0] & 0x1f;
  let offset = 1;
  let length: number;
  if (additional < 24) {
    length = additional;
  } else if (additional === 24) {
    length = cbor[offset++];
  } else if (additional === 25) {
    length = cbor[offset++] * 0x100 + cbor[offset++];
  } else if (additional === 26) {
    length = cbor[offset++] * 0x1000000 + cbor[offset++] * 0x10000
      + cbor[offset++] * 0x100 + cbor[offset++];
  } else {
    throw new Error('The crypto-psbt UR uses an unsupported CBOR length.');
  }
  if (!Number.isSafeInteger(length) || length < 0 || offset + length !== cbor.length) {
    throw new Error('The crypto-psbt UR payload length is invalid.');
  }
  return Uint8Array.from(cbor.subarray(offset));
}

export function encodeUrPsbt(bytes: Uint8Array, fragmentBytes = UR_PSBT_FRAGMENT_BYTES): PsbtQrFrames {
  assertPsbt(bytes);
  const encoder = new UREncoder(new UR(encodeCborByteString(bytes), 'crypto-psbt'), fragmentBytes);
  const partCount = encoder.fragmentsLength;
  const frameCount = partCount === 1 ? 1 : partCount * 2;
  return {
    protocol: 'ur',
    frames: Array.from({ length: frameCount }, () => encoder.nextPart()),
    partCount,
    frameBudget: fragmentBytes,
  };
}

export function encodeBbqrPsbt(
  bytes: Uint8Array,
  options: { minVersion?: Version; maxVersion?: Version } = {},
): PsbtQrFrames {
  assertPsbt(bytes);
  const split = splitQRs(bytes, 'P', {
    encoding: 'Z',
    minVersion: options.minVersion ?? BBQR_MIN_VERSION,
    maxVersion: options.maxVersion ?? BBQR_MAX_VERSION,
  });
  return {
    protocol: 'bbqr',
    frames: split.parts,
    partCount: split.parts.length,
    frameBudget: Math.max(...split.parts.map((part) => part.length - 8)),
    qrVersion: Number(split.version),
  };
}

/** Accumulates one UR, BBQr, or plain PSBT session. Call reset() before scanning another. */
export class AnimatedPsbtQrDecoder {
  private protocol: PsbtQrProtocol | null = null;
  private urDecoder: URDecoder | null = null;
  private urFrames = new Set<string>();
  private bbqrPrefix = '';
  private bbqrParts = new Map<number, string>();

  reset(): void {
    this.protocol = null;
    this.urDecoder = null;
    this.urFrames.clear();
    this.bbqrPrefix = '';
    this.bbqrParts.clear();
  }

  receivePart(value: string): PsbtQrDecodeProgress {
    const part = value.trim();
    if (!part) {
      throw new Error('The QR code is empty.');
    }
    if (/^ur:/i.test(part)) {
      return this.receiveUr(part);
    }
    if (/^B\$/i.test(part)) {
      return this.receiveBbqr(part);
    }
    return this.receivePlain(part);
  }

  private useProtocol(protocol: PsbtQrProtocol): void {
    if (this.protocol && this.protocol !== protocol) {
      throw new Error('This QR belongs to a different animated-QR session. Reset the scan and try again.');
    }
    this.protocol = protocol;
  }

  private receiveUr(part: string): PsbtQrDecodeProgress {
    if (!/^ur:crypto-psbt\//i.test(part)) {
      throw new Error('Expected a ur:crypto-psbt QR.');
    }
    this.useProtocol('ur');
    this.urDecoder ??= new URDecoder();
    const normalized = part.toLowerCase();
    if (!this.urFrames.has(normalized)) {
      if (!this.urDecoder.receivePart(normalized)) {
        throw new Error('This UR frame does not match the current PSBT.');
      }
      this.urFrames.add(normalized);
    }
    const needed = this.urDecoder.expectedPartCount() || 1;
    if (this.urDecoder.isComplete()) {
      if (!this.urDecoder.isSuccess() || this.urDecoder.resultUR().type !== 'crypto-psbt') {
        throw new Error(this.urDecoder.resultError() || 'The crypto-psbt UR could not be decoded.');
      }
      const bytes = decodeCborByteString(this.urDecoder.resultUR().cbor);
      assertPsbt(bytes);
      return { protocol: 'ur', received: needed, needed, percent: 1, bytes };
    }
    return {
      protocol: 'ur',
      received: this.urDecoder.receivedPartIndexes().length,
      needed,
      percent: this.urDecoder.estimatedPercentComplete(),
    };
  }

  private receiveBbqr(part: string): PsbtQrDecodeProgress {
    const normalized = part.toUpperCase();
    if (!/^B\$[HZ2]P[0-9A-Z]{4}/.test(normalized)) {
      throw new Error('Expected a BBQr PSBT frame.');
    }
    const prefix = normalized.slice(0, 6);
    const needed = parseInt(normalized.slice(4, 6), 36);
    const index = parseInt(normalized.slice(6, 8), 36);
    if (!needed || index >= needed) {
      throw new Error('The BBQr frame header is invalid.');
    }
    this.useProtocol('bbqr');
    if (this.bbqrPrefix && this.bbqrPrefix !== prefix) {
      throw new Error('This BBQr frame belongs to a different PSBT. Reset the scan and try again.');
    }
    this.bbqrPrefix = prefix;
    const existing = this.bbqrParts.get(index);
    if (existing && existing !== normalized) {
      throw new Error('A duplicate BBQr part has different data.');
    }
    this.bbqrParts.set(index, normalized);
    if (this.bbqrParts.size === needed) {
      const joined = joinQRs([...this.bbqrParts.values()]);
      if (joined.fileType !== 'P') {
        throw new Error('The BBQr payload is not a PSBT.');
      }
      assertPsbt(joined.raw);
      return { protocol: 'bbqr', received: needed, needed, percent: 1, bytes: joined.raw };
    }
    return {
      protocol: 'bbqr',
      received: this.bbqrParts.size,
      needed,
      percent: this.bbqrParts.size / needed,
    };
  }

  private receivePlain(part: string): PsbtQrDecodeProgress {
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(normalizePsbtText(part));
    } catch {
      throw new Error('Expected a PSBT QR encoded as UR, BBQr, base64, or hex.');
    }
    assertPsbt(bytes);
    this.useProtocol('plain');
    return { protocol: 'plain', received: 1, needed: 1, percent: 1, bytes };
  }
}
