import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { crc16Modbus, appendCrc, checkCrc } from '../../src/domain/protocol/crc';
import { encodeRequestPdu, decodeResponsePdu, encodeResponsePdu } from '../../src/domain/protocol/pdu';
import { buildRtuAdu } from '../../src/domain/protocol/rtu';
import { buildTcpAdu } from '../../src/domain/protocol/tcp';
import type { ModbusRequest } from '../../src/domain/protocol/types';
import { hex, unhex } from '../support/fake';

const FIX = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'protocol', name), 'utf-8')) as Record<string, unknown>;

describe('CRC-16/MODBUS golden vectors', () => {
  const vectors = FIX('crc-vectors.json') as unknown as Array<{ input: string; crc: string }>;
  it('matches independent check values', () => {
    for (const v of vectors) {
      const crc = crc16Modbus(unhex(v.input));
      const le = hex(new Uint8Array([crc & 0xff, (crc >> 8) & 0xff]));
      expect(le).toBe(v.crc);
    }
  });
  it('check value for "123456789" is 0x4B37', () => {
    expect(crc16Modbus(new TextEncoder().encode('123456789'))).toBe(0x4b37);
  });
  it('appendCrc/checkCrc roundtrip', () => {
    const adu = appendCrc(unhex('010300000020'));
    expect(checkCrc(adu)).toBe(true);
    adu[3] = (adu[3] ?? 0) ^ 0xff;
    expect(checkCrc(adu)).toBe(false);
  });
});

describe('RTU / TCP golden ADU vectors', () => {
  const rtu = FIX('rtu-vectors.json') as unknown as { requests: Record<string, string>; responses: Record<string, string>; exceptions: Record<string, string> };
  const tcp = FIX('tcp-vectors.json') as unknown as Record<string, string>;

  const requests: Array<[ModbusRequest, string, number]> = [
    [{ kind: 'read', fc: 0x03, address: 0, quantity: 0x20 }, rtu.requests.fc03_read_32!, 1],
    [{ kind: 'read', fc: 0x01, address: 0x10, quantity: 8 }, rtu.requests.fc01_read_8_coils!, 2],
    [{ kind: 'writeCoil', fc: 0x05, address: 4, value: true }, rtu.requests.fc05_force_on!, 1],
    [{ kind: 'writeRegister', fc: 0x06, address: 6, value: 1500 }, rtu.requests.fc06_write_single!, 1],
    [{ kind: 'writeRegisters', fc: 0x10, address: 6, values: [1500, 10] }, rtu.requests.fc16_write_two!, 1],
    [{ kind: 'writeCoils', fc: 0x0f, address: 4, values: [true, false, true] }, rtu.requests.fc15_write_three!, 1],
  ];

  it('encodes requests byte-identical to golden fixtures', () => {
    for (const [req, expected, unit] of requests) {
      expect(hex(buildRtuAdu(unit, encodeRequestPdu(req)))).toBe(expected);
    }
  });

  it('decodes golden responses', () => {
    const resp = unhex(rtu.responses.fc03_32_registers!);
    const decoded = decodeResponsePdu(resp.subarray(1, resp.length - 2), 0x03);
    expect(decoded.kind).toBe('registers');
    if (decoded.kind === 'registers') expect(decoded.registers).toEqual(Array.from({ length: 32 }, (_, i) => i));
    const bits = unhex(rtu.responses.fc01_8_coils!);
    const dbits = decodeResponsePdu(bits.subarray(1, bits.length - 2), 0x01);
    expect(dbits.kind).toBe('bits');
    if (dbits.kind === 'bits') expect(dbits.bits.slice(0, 8)).toEqual([true, false, true, false, false, true, false, true]);
    const exc = unhex(rtu.exceptions.illegal_data_address!);
    const dexc = decodeResponsePdu(exc.subarray(1, exc.length - 2), 0x03);
    expect(dexc).toEqual({ kind: 'exception', fc: 0x03, code: 0x02 });
  });

  it('response encoder is inverse of decoder for golden bytes', () => {
    const resp = unhex(rtu.responses.fc03_32_registers!);
    const decoded = decodeResponsePdu(resp.subarray(1, resp.length - 2), 0x03);
    expect(hex(encodeResponsePdu(decoded))).toBe(hex(resp.subarray(1, resp.length - 2)));
  });

  it('TCP MBAP golden vectors', () => {
    const req = unhex(tcp.request_tid7!);
    expect(hex(buildTcpAdu(7, 1, encodeRequestPdu({ kind: 'read', fc: 0x03, address: 0, quantity: 16 })))).toBe(hex(req));
  });
});