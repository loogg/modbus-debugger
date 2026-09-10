import { appendCrc, checkCrc } from './crc';
import { LIMITS } from './types';

export function buildRtuAdu(unitId: number, pdu: Uint8Array): Uint8Array {
  const frame = new Uint8Array(pdu.length + 1);
  frame[0] = unitId;
  frame.set(pdu, 1);
  return appendCrc(frame);
}

export interface RtuAduParts {
  unitId: number;
  pdu: Uint8Array;
}

/** Structural parse only (CRC already assumed checked by caller or checked here). */
export function splitRtuAdu(adu: Uint8Array): RtuAduParts {
  return { unitId: adu[0] as number, pdu: adu.subarray(1, adu.length - 2) };
}

export { checkCrc as rtuCrcOk };

export const RTU_MAX_ADU = LIMITS.MAX_RTU_ADU;

/** t1.5 / t3.5 character-interval boundaries in milliseconds for a baud rate. */
export function rtuTimings(baudRate: number): { t15: number; t35: number } {
  if (baudRate > 19200) return { t15: 0.75, t35: 1.75 };
  const charMs = (11 / baudRate) * 1000;
  return { t15: charMs * 1.5, t35: charMs * 3.5 };
}