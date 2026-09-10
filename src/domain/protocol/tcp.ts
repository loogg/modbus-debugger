import { LIMITS } from './types';

export const MBAP_LENGTH = 6;
export const TCP_PROTO_ID = 0x0000;

export function buildTcpAdu(transactionId: number, unitId: number, pdu: Uint8Array): Uint8Array {
  const len = pdu.length + 1;
  const out = new Uint8Array(MBAP_LENGTH + len);
  out[0] = (transactionId >> 8) & 0xff;
  out[1] = transactionId & 0xff;
  out[2] = 0;
  out[3] = 0;
  out[4] = (len >> 8) & 0xff;
  out[5] = len & 0xff;
  out[6] = unitId;
  out.set(pdu, 7);
  return out;
}

export interface TcpAduParts {
  transactionId: number;
  protocolId: number;
  length: number;
  unitId: number;
  pdu: Uint8Array;
}

export function parseMbap(buf: Uint8Array, offset = 0): TcpAduParts {
  return {
    transactionId: ((buf[offset] as number) << 8) | (buf[offset + 1] as number),
    protocolId: ((buf[offset + 2] as number) << 8) | (buf[offset + 3] as number),
    length: ((buf[offset + 4] as number) << 8) | (buf[offset + 5] as number),
    unitId: buf[offset + 6] as number,
    pdu: buf.subarray(offset + 7, offset + MBAP_LENGTH + (((buf[offset + 4] as number) << 8) | (buf[offset + 5] as number))),
  };
}

export function mbapLengthValid(length: number): boolean {
  return length >= 1 && length <= LIMITS.MAX_TCP_MBAP_LENGTH;
}

export const TCP_MAX_ADU = LIMITS.MAX_TCP_ADU;