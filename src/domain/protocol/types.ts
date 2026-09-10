export const FC = {
  ReadCoils: 0x01,
  ReadDiscreteInputs: 0x02,
  ReadHoldingRegisters: 0x03,
  ReadInputRegisters: 0x04,
  WriteSingleCoil: 0x05,
  WriteSingleRegister: 0x06,
  WriteMultipleCoils: 0x0f,
  WriteMultipleRegisters: 0x10,
} as const;

export type ReadFC = 0x01 | 0x02 | 0x03 | 0x04;
export type AreaCode = 1 | 2 | 3 | 4;
export type FunctionCode = (typeof FC)[keyof typeof FC];

export const ExceptionCode = {
  IllegalFunction: 0x01,
  IllegalDataAddress: 0x02,
  IllegalDataValue: 0x03,
  SlaveDeviceFailure: 0x04,
  Acknowledge: 0x05,
  SlaveDeviceBusy: 0x06,
  MemoryParityError: 0x08,
  GatewayPathUnavailable: 0x0a,
  GatewayTargetFailed: 0x0b,
} as const;
export type ExceptionCode = (typeof ExceptionCode)[keyof typeof ExceptionCode];

export const EXCEPTION_NAMES: Record<number, string> = {
  0x01: 'Illegal Function',
  0x02: 'Illegal Data Address',
  0x03: 'Illegal Data Value',
  0x04: 'Slave Device Failure',
  0x05: 'Acknowledge',
  0x06: 'Slave Device Busy',
  0x08: 'Memory Parity Error',
  0x0a: 'Gateway Path Unavailable',
  0x0b: 'Gateway Target Failed',
};

export type ModbusRequest =
  | { kind: 'read'; fc: ReadFC; address: number; quantity: number }
  | { kind: 'writeCoil'; fc: 0x05; address: number; value: boolean }
  | { kind: 'writeCoils'; fc: 0x0f; address: number; values: boolean[] }
  | { kind: 'writeRegister'; fc: 0x06; address: number; value: number }
  | { kind: 'writeRegisters'; fc: 0x10; address: number; values: number[] };

export type ModbusResponse =
  | { kind: 'bits'; fc: ReadFC; bits: boolean[] }
  | { kind: 'registers'; fc: ReadFC; registers: number[] }
  | { kind: 'writeAck'; fc: FunctionCode; address: number; extra: number }
  | { kind: 'exception'; fc: FunctionCode; code: number };

export function requestFunctionCode(req: ModbusRequest): FunctionCode {
  return req.fc;
}

/** Expected response PDU byte length for a request (used as RTU framing context). */
export function expectedResponsePduLength(req: ModbusRequest): number {
  switch (req.kind) {
    case 'read':
      if (req.fc === FC.ReadCoils || req.fc === FC.ReadDiscreteInputs) {
        return 2 + Math.ceil(req.quantity / 8);
      }
      return 2 + req.quantity * 2;
    case 'writeCoil':
    case 'writeRegister':
      return 5;
    case 'writeCoils':
    case 'writeRegisters':
      return 5;
  }
}

export function expectedResponseAduLength(req: ModbusRequest, transport: 'rtu' | 'tcp'): number {
  const pdu = expectedResponsePduLength(req);
  return transport === 'rtu' ? pdu + 3 : pdu + 7;
}

export const LIMITS = {
  MAX_PDU: 253,
  MAX_RTU_ADU: 256,
  MAX_TCP_ADU: 260,
  MAX_TCP_MBAP_LENGTH: 254,
  MAX_READ_COILS: 2000,
  MAX_READ_REGS: 125,
  MAX_WRITE_COILS: 1968,
  MAX_WRITE_REGS: 123,
} as const;