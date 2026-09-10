import type { AreaCode } from './protocol/types';

export const AREAS: Record<AreaCode, string> = {
  1: 'Coil (01)',
  2: 'Discrete Input (02)',
  3: 'Holding Register (03)',
  4: 'Input Register (04)',
};

export const AREA_SHORT: Record<AreaCode, string> = {
  1: '01',
  2: '02',
  3: '03',
  4: '04',
};

export interface PlcReference {
  area: AreaCode;
  /** 0-based protocol address */
  address: number;
}

/**
 * Import-layer only: convert PLC style references (40001 / 30001 / 10001 / 00001 and
 * 6-digit variants) into area + 0-based address. Core model never stores PLC numbers.
 */
export function parsePlcReference(input: string | number): PlcReference | null {
  const text = String(input).trim();
  const m = /^(\d+)$/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  const table: Array<[number, number, AreaCode]> = [
    [400001, 400001, 3],
    [300001, 300001, 4],
    [40001, 499999, 3],
    [30001, 399999, 4],
    [10001, 19999, 2],
    [1, 9999, 1],
  ];
  if (n >= 400001 && n <= 465536) return { area: 3, address: n - 400001 };
  if (n >= 300001 && n <= 365536) return { area: 4, address: n - 300001 };
  for (const [lo, hi, area] of table) {
    if (n >= lo && n <= hi) {
      const base = area === 3 ? 40001 : area === 4 ? 30001 : area === 2 ? 10001 : 1;
      return { area, address: n - base };
    }
  }
  return null;
}

export function toPlcReference(area: AreaCode, address: number): number {
  const base = area === 3 ? 40001 : area === 4 ? 30001 : area === 2 ? 10001 : 1;
  return base + address;
}