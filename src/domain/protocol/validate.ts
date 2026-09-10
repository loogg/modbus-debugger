import { decodeResponsePdu, isExceptionPdu } from './pdu';
import { checkCrc } from './crc';
import { splitRtuAdu } from './rtu';
import { parseMbap } from './tcp';
import type { FunctionCode, ModbusResponse } from './types';

export interface RequestContext {
  transport: 'rtu' | 'tcp';
  unitId: number;
  fc: FunctionCode;
  /** Expected full ADU length of the normal (non-exception) response. */
  expectedAduLength: number;
  /** TCP MBAP transaction id of the in-flight request. */
  tid?: number;
}

export type AduVerdict =
  | { type: 'ok'; response: ModbusResponse }
  | { type: 'exception'; response: ModbusResponse }
  | { type: 'unexpected'; reason: string; raw: Uint8Array }
  | { type: 'crc-error'; raw: Uint8Array }
  | { type: 'malformed'; reason: string; raw: Uint8Array };

/** ADU Validator: classifies a complete candidate ADU against the in-flight request context. */
export function validateAdu(adu: Uint8Array, ctx: RequestContext): AduVerdict {
  if (ctx.transport === 'rtu') {
    if (adu.length < 4) return { type: 'malformed', reason: 'RTU ADU too short', raw: adu };
    if (!checkCrc(adu)) return { type: 'crc-error', raw: adu };
    const { unitId, pdu } = splitRtuAdu(adu);
    if (unitId !== ctx.unitId) {
      return { type: 'unexpected', reason: `unit id mismatch: got ${unitId}, expected ${ctx.unitId}`, raw: adu };
    }
    return classifyPdu(pdu, ctx, adu);
  }
  if (adu.length < 8) return { type: 'malformed', reason: 'TCP ADU too short', raw: adu };
  const mbap = parseMbap(adu);
  if (mbap.protocolId !== 0) return { type: 'malformed', reason: `bad protocol id ${mbap.protocolId}`, raw: adu };
  if (mbap.transactionId !== ctx.tid) {
    return { type: 'unexpected', reason: `transaction id mismatch: got ${mbap.transactionId}, expected ${ctx.tid}`, raw: adu };
  }
  if (mbap.unitId !== ctx.unitId) {
    return { type: 'unexpected', reason: `unit id mismatch: got ${mbap.unitId}, expected ${ctx.unitId}`, raw: adu };
  }
  return classifyPdu(mbap.pdu, ctx, adu);
}

/** Structural sanity of a normal response PDU for its function code. */
function pduShapeValid(pdu: Uint8Array): boolean {
  const fc = pdu[0] as number;
  switch (fc) {
    case 0x01:
    case 0x02:
    case 0x03:
    case 0x04: {
      if (pdu.length < 4) return false;
      const bc = pdu[1] as number;
      return pdu.length === 2 + bc && bc >= 1;
    }
    case 0x05:
    case 0x06:
    case 0x0f:
    case 0x10:
      return pdu.length === 5;
    default:
      return false;
  }
}

function classifyPdu(pdu: Uint8Array, ctx: RequestContext, raw: Uint8Array): AduVerdict {
  if (pdu.length < 1) return { type: 'malformed', reason: 'empty PDU', raw };
  const fc = pdu[0] as number;
  const isExc = isExceptionPdu(pdu);
  if ((fc & 0x7f) !== ctx.fc) {
    return {
      type: 'unexpected',
      reason: `function code mismatch: got 0x${fc.toString(16)}, expected 0x${ctx.fc.toString(16)}`,
      raw,
    };
  }
  if (isExc) {
    if (pdu.length !== 2) return { type: 'malformed', reason: 'exception PDU must be 2 bytes', raw };
  } else if (!pduShapeValid(pdu)) {
    return { type: 'malformed', reason: `impossible PDU length ${pdu.length} for FC 0x${(pdu[0] as number).toString(16)}`, raw };
  } else if (raw.length !== ctx.expectedAduLength) {
    return {
      type: 'unexpected',
      reason: `response length mismatch: got ${raw.length} bytes, expected ${ctx.expectedAduLength}`,
      raw,
    };
  }
  try {
    const response = decodeResponsePdu(pdu, ctx.fc);
    return response.kind === 'exception' ? { type: 'exception', response } : { type: 'ok', response };
  } catch {
    return { type: 'malformed', reason: 'PDU decode failed', raw };
  }
}