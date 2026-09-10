import type { RawType } from './mapping';

export interface ScaleOffset {
  scale: number;
  offset: number;
}

export type ScaleResult = { ok: true; value: number } | { ok: false; reason: string };

export function toEngineering(raw: number, so: ScaleOffset): number {
  return raw * so.scale + so.offset;
}

/** Engineering -> Raw (double precision). Rejects Scale=0 and non-finite results. */
export function inverseToRaw(engineering: number, so: ScaleOffset): ScaleResult {
  if (!Number.isFinite(engineering)) return { ok: false, reason: 'engineering value is not finite' };
  if (so.scale === 0) return { ok: false, reason: 'Scale = 0 is an invalid configuration' };
  const raw = (engineering - so.offset) / so.scale;
  if (!Number.isFinite(raw)) return { ok: false, reason: 'inverse transform produced NaN / Infinity' };
  return { ok: true, value: raw };
}

export function rawRange(rawType: RawType, bitWidth: number): { min: number; max: number } | null {
  switch (rawType) {
    case 'Bool':
      return { min: 0, max: 1 };
    case 'BitField':
      return { min: 0, max: bitWidth >= 16 ? 0xffff : (1 << bitWidth) - 1 };
    case 'Int8':
      return { min: -128, max: 127 };
    case 'UInt8':
      return { min: 0, max: 255 };
    case 'Int16':
      return { min: -32768, max: 32767 };
    case 'UInt16':
      return { min: 0, max: 65535 };
    case 'Int32':
      return { min: -2147483648, max: 2147483647 };
    case 'UInt32':
      return { min: 0, max: 4294967295 };
    default:
      return null;
  }
}

/** Round-half-to-nearest representable integer, then range check. */
export function quantize(rawDouble: number, rawType: RawType, bitWidth: number): ScaleResult {
  const range = rawRange(rawType, bitWidth);
  if (range === null) {
    if (!Number.isFinite(rawDouble)) return { ok: false, reason: 'raw value is not finite' };
    return { ok: true, value: rawDouble };
  }
  const q = Math.round(rawDouble);
  if (q < range.min || q > range.max) {
    return { ok: false, reason: `raw value ${q} outside ${rawType} range [${range.min}, ${range.max}]` };
  }
  return { ok: true, value: q };
}

/** Full write-side conversion: engineering -> validated raw integer/float. */
export function engineeringToRaw(
  engineering: number,
  so: ScaleOffset,
  rawType: RawType,
  bitWidth: number,
): ScaleResult {
  const inv = inverseToRaw(engineering, so);
  if (!inv.ok) return inv;
  return quantize(inv.value, rawType, bitWidth);
}