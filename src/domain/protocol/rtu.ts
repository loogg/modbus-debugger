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

