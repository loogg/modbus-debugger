import { encodeResponsePdu } from './pdu';
import { FC, LIMITS, type FunctionCode, type ModbusRequest } from './types';

export class SlaveRequestError extends Error {
  constructor(readonly code: 1 | 2 | 3, message: string) { super(message); }
}

const word = (pdu: Uint8Array, offset: number) => ((pdu[offset]! << 8) | pdu[offset + 1]!);
const invalid = (message: string): never => { throw new SlaveRequestError(3, message); };

/** Decode an untrusted master request; validate the entire PDU before any memory access. */
export function decodeSlaveRequest(pdu: Uint8Array): ModbusRequest {
  if (pdu.length === 0 || pdu.length > LIMITS.MAX_PDU) invalid('PDU length out of range');
  const fc = pdu[0]!;
  if (![1, 2, 3, 4, 5, 6, 15, 16].includes(fc)) throw new SlaveRequestError(1, 'Unsupported function');
  if (pdu.length < 5) invalid('Truncated request');
  const address = word(pdu, 1);
  const value = word(pdu, 3);
  if (fc <= 6 && pdu.length !== 5) invalid('Invalid request length');
  if (fc <= 4) {
    if (value < 1 || value > (fc <= 2 ? 2000 : 125)) invalid('Invalid read quantity');
    if (address + value > 65536) throw new SlaveRequestError(2, 'Address overflow');
    return { kind: 'read', fc: fc as 1 | 2 | 3 | 4, address, quantity: value };
  }
  if (fc === 5) {
    if (value !== 0 && value !== 0xff00) invalid('Invalid coil value');
    return { kind: 'writeCoil', fc: FC.WriteSingleCoil, address, value: value === 0xff00 };
  }
  if (fc === 6) return { kind: 'writeRegister', fc: FC.WriteSingleRegister, address, value };
  if (value < 1 || value > (fc === 15 ? 1968 : 123)) invalid('Invalid write quantity');
  const byteCount = fc === 15 ? Math.ceil(value / 8) : value * 2;
  if (pdu[5] !== byteCount || pdu.length !== 6 + byteCount) invalid('Invalid byte count or request length');
  if (address + value > 65536) throw new SlaveRequestError(2, 'Address overflow');
  if (fc === 15) return { kind: 'writeCoils', fc: FC.WriteMultipleCoils, address, values: Array.from({ length: value }, (_, i) => Boolean(pdu[6 + (i >> 3)]! & (1 << (i & 7)))) };
  return { kind: 'writeRegisters', fc: FC.WriteMultipleRegisters, address, values: Array.from({ length: value }, (_, i) => word(pdu, 6 + i * 2)) };
}

export interface SlaveMemory {
  /** Null means at least one address is undefined. Writes must be atomic across the range. */
  read(area: 1 | 2 | 3 | 4, start: number, quantity: number): number[] | null;
  write(area: 1 | 3, start: number, values: number[]): boolean;
}

export function slaveRequestRange(request: ModbusRequest): { area: 1 | 2 | 3 | 4; start: number; quantity: number; write: boolean } {
  return {
    area: request.kind === 'read' ? request.fc : request.kind === 'writeCoil' || request.kind === 'writeCoils' ? 1 : 3,
    start: request.address,
    quantity: request.kind === 'read' ? request.quantity : request.kind === 'writeCoils' || request.kind === 'writeRegisters' ? request.values.length : 1,
    write: request.kind !== 'read',
  };
}

/** Pure server PDU execution, using a Main-owned memory adapter. */
export function executeSlaveRequest(request: ModbusRequest, memory: SlaveMemory): Uint8Array {
  const range = slaveRequestRange(request);
  if (request.kind === 'read') {
    const values = memory.read(range.area, range.start, range.quantity);
    if (!values) throw new SlaveRequestError(2, 'Undefined address');
    return encodeResponsePdu(request.fc <= 2
      ? { kind: 'bits', fc: request.fc, bits: values.map(Boolean) }
      : { kind: 'registers', fc: request.fc, registers: values });
  }
  const values = request.kind === 'writeCoil' ? [Number(request.value)] : request.kind === 'writeRegister' ? [request.value]
    : request.kind === 'writeCoils' ? request.values.map(Number) : request.values;
  if (!memory.write(range.area as 1 | 3, range.start, values)) throw new SlaveRequestError(2, 'Undefined address');
  return encodeResponsePdu({ kind: 'writeAck', fc: request.fc, address: request.address,
    extra: request.kind === 'writeCoil' ? request.value ? 0xff00 : 0 : request.kind === 'writeRegister' ? request.value : values.length });
}

export function slaveExceptionPdu(functionCode: number, code: number): Uint8Array {
  return encodeResponsePdu({ kind: 'exception', fc: functionCode as FunctionCode, code });
}
