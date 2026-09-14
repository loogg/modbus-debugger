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
  // Bare protocol addresses such as 1 or 100 must not become Coil references.
  // PLC notation is explicitly five/six digits, including the leading zero for Coils.
  const match = /^([0134])(\d{4,5})$/.exec(text);
  if (!match) return null;
  const ordinal = Number(match[2]);
  if (ordinal < 1 || ordinal > 65536) return null;
  const area = ({ '0': 1, '1': 2, '3': 4, '4': 3 } as const)[match[1] as '0' | '1' | '3' | '4'];
  return { area, address: ordinal - 1 };
}

export function toPlcReference(area: AreaCode, address: number): number {
  const base = area === 3 ? 40001 : area === 4 ? 30001 : area === 2 ? 10001 : 1;
  return base + address;
}