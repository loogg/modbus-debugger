import { FC, LIMITS, type FunctionCode, type ModbusRequest, type ModbusResponse, type ReadFC } from './types';

export class ProtocolError extends Error {
  constructor(
    message: string,
    public readonly reason: string,
    public readonly raw?: Uint8Array,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}

function u16(buf: Uint8Array, off: number): number {
  return ((buf[off] as number) << 8) | (buf[off + 1] as number);
}
function put16(out: Uint8Array, off: number, v: number): void {
  out[off] = (v >> 8) & 0xff;
  out[off + 1] = v & 0xff;
}

export function encodeRequestPdu(req: ModbusRequest): Uint8Array {
  switch (req.kind) {
    case 'read': {
      if (req.address < 0 || req.address > 0xffff) throw new ProtocolError('address out of range', 'address');
      const isBits = req.fc === FC.ReadCoils || req.fc === FC.ReadDiscreteInputs;
      const max = isBits ? LIMITS.MAX_READ_COILS : LIMITS.MAX_READ_REGS;
      if (req.quantity < 1 || req.quantity > max) throw new ProtocolError('quantity out of range', 'quantity');
      const out = new Uint8Array(5);
      out[0] = req.fc;
      put16(out, 1, req.address);
      put16(out, 3, req.quantity);
      return out;
    }
    case 'writeCoil': {
      const out = new Uint8Array(5);
      out[0] = FC.WriteSingleCoil;
      put16(out, 1, req.address);
      put16(out, 3, req.value ? 0xff00 : 0x0000);
      return out;
    }
    case 'writeRegister': {
      if (req.value < 0 || req.value > 0xffff) throw new ProtocolError('register value out of range', 'value');
      const out = new Uint8Array(5);
      out[0] = FC.WriteSingleRegister;
      put16(out, 1, req.address);
      put16(out, 3, req.value);
      return out;
    }
    case 'writeCoils': {
      const n = req.values.length;
      if (n < 1 || n > LIMITS.MAX_WRITE_COILS) throw new ProtocolError('coil count out of range', 'quantity');
      const bytes = Math.ceil(n / 8);
      const out = new Uint8Array(6 + bytes);
      out[0] = FC.WriteMultipleCoils;
      put16(out, 1, req.address);
      put16(out, 3, n);
      out[5] = bytes;
      for (let i = 0; i < n; i++) {
        if (req.values[i]) out[6 + (i >> 3)] = (out[6 + (i >> 3)] ?? 0) | (1 << (i & 7));
      }
      return out;
    }
    case 'writeRegisters': {
      const n = req.values.length;
      if (n < 1 || n > LIMITS.MAX_WRITE_REGS) throw new ProtocolError('register count out of range', 'quantity');
      for (const v of req.values) if (v < 0 || v > 0xffff) throw new ProtocolError('register value out of range', 'value');
      const out = new Uint8Array(6 + n * 2);
      out[0] = FC.WriteMultipleRegisters;
      put16(out, 1, req.address);
      put16(out, 3, n);
      out[5] = n * 2;
      for (let i = 0; i < n; i++) put16(out, 6 + i * 2, req.values[i] as number);
      return out;
    }
  }
}

export function isExceptionPdu(pdu: Uint8Array): boolean {
  return pdu.length >= 2 && ((pdu[0] as number) & 0x80) !== 0;
}

/** Decode a response PDU. `reqFc` is the function code of the in-flight request. */
export function decodeResponsePdu(pdu: Uint8Array, reqFc: FunctionCode): ModbusResponse {
  if (pdu.length < 1) throw new ProtocolError('empty PDU', 'malformed', pdu);
  const fc = pdu[0] as number;
  if ((fc & 0x80) !== 0) {
    if (pdu.length < 2) throw new ProtocolError('truncated exception PDU', 'malformed', pdu);
    return { kind: 'exception', fc: (fc & 0x7f) as FunctionCode, code: pdu[1] as number };
  }
  if (fc !== reqFc) {
    // Structurally valid but not matching the request: Unexpected Response (not malformed).
    throw new ProtocolError(`function code mismatch: got 0x${fc.toString(16)} expected 0x${reqFc.toString(16)}`, 'unexpected', pdu);
  }
  switch (fc) {
    case FC.ReadCoils:
    case FC.ReadDiscreteInputs: {
      if (pdu.length < 2) throw new ProtocolError('truncated read response', 'malformed', pdu);
      const bc = pdu[1] as number;
      if (pdu.length < 2 + bc) throw new ProtocolError('read response shorter than byte count', 'malformed', pdu);
      const bits: boolean[] = [];
      for (let i = 0; i < bc * 8; i++) bits.push(((pdu[2 + (i >> 3)] as number) >> (i & 7)) & 1 ? true : false);
      return { kind: 'bits', fc: fc as ReadFC, bits };
    }
    case FC.ReadHoldingRegisters:
    case FC.ReadInputRegisters: {
      if (pdu.length < 2) throw new ProtocolError('truncated read response', 'malformed', pdu);
      const bc = pdu[1] as number;
      if (bc % 2 !== 0 || pdu.length < 2 + bc) throw new ProtocolError('bad register byte count', 'malformed', pdu);
      const regs: number[] = [];
      for (let i = 0; i + 1 < bc; i += 2) regs.push(u16(pdu, 2 + i));
      return { kind: 'registers', fc: fc as ReadFC, registers: regs };
    }
    case FC.WriteSingleCoil:
    case FC.WriteSingleRegister: {
      if (pdu.length < 5) throw new ProtocolError('truncated write echo', 'malformed', pdu);
      return { kind: 'writeAck', fc: fc as FunctionCode, address: u16(pdu, 1), extra: u16(pdu, 3) };
    }
    case FC.WriteMultipleCoils:
    case FC.WriteMultipleRegisters: {
      if (pdu.length < 5) throw new ProtocolError('truncated write ack', 'malformed', pdu);
      return { kind: 'writeAck', fc: fc as FunctionCode, address: u16(pdu, 1), extra: u16(pdu, 3) };
    }
    default:
      throw new ProtocolError('unsupported function code 0x' + Number(fc).toString(16), 'malformed', pdu);
  }
}

/** Encode a response PDU (used by the in-repo fake transport and by tests of the decoder). */
export function encodeResponsePdu(res: ModbusResponse): Uint8Array {
  switch (res.kind) {
    case 'exception': {
      const out = new Uint8Array(2);
      out[0] = (res.fc | 0x80) & 0xff;
      out[1] = res.code;
      return out;
    }
    case 'bits': {
      const bytes = Math.ceil(res.bits.length / 8);
      const out = new Uint8Array(2 + bytes);
      out[0] = res.fc;
      out[1] = bytes;
      res.bits.forEach((b, i) => {
        if (b) out[2 + (i >> 3)] = (out[2 + (i >> 3)] ?? 0) | (1 << (i & 7));
      });
      return out;
    }
    case 'registers': {
      const out = new Uint8Array(2 + res.registers.length * 2);
      out[0] = res.fc;
      out[1] = res.registers.length * 2;
      res.registers.forEach((r, i) => put16(out, 2 + i * 2, r));
      return out;
    }
    case 'writeAck': {
      const out = new Uint8Array(5);
      out[0] = res.fc;
      put16(out, 1, res.address);
      put16(out, 3, res.extra);
      return out;
    }
  }
}