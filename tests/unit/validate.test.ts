import { describe, expect, it } from 'vitest';
import { validateAdu, type RequestContext } from '../../src/domain/protocol/validate';
import { buildRtuAdu } from '../../src/domain/protocol/rtu';
import { buildTcpAdu } from '../../src/domain/protocol/tcp';
import { encodeResponsePdu } from '../../src/domain/protocol/pdu';
import { appendCrc } from '../../src/domain/protocol/crc';
import { expectedResponseAduLength } from '../../src/domain/protocol/types';

const req = { kind: 'read', fc: 0x03, address: 0, quantity: 4 } as const;

function rtuCtx(): RequestContext {
  return { transport: 'rtu', unitId: 1, fc: 0x03, expectedAduLength: expectedResponseAduLength(req, 'rtu') };
}
function tcpCtx(tid: number): RequestContext {
  return { transport: 'tcp', unitId: 1, fc: 0x03, expectedAduLength: expectedResponseAduLength(req, 'tcp'), tid };
}

describe('ADU validator classification', () => {
  it('ok for matching response', () => {
    const adu = buildRtuAdu(1, encodeResponsePdu({ kind: 'registers', fc: 0x03, registers: [1, 2, 3, 4] }));
    expect(validateAdu(adu, rtuCtx()).type).toBe('ok');
  });

  it('legal exception response is classified as exception, not malformed', () => {
    const adu = buildRtuAdu(1, encodeResponsePdu({ kind: 'exception', fc: 0x03, code: 0x02 }));
    const v = validateAdu(adu, rtuCtx());
    expect(v.type).toBe('exception');
  });

  it('CRC error is crc-error', () => {
    const adu = buildRtuAdu(1, encodeResponsePdu({ kind: 'registers', fc: 0x03, registers: [1, 2, 3, 4] }));
    adu[2] = (adu[2] ?? 0) ^ 0xff;
    expect(validateAdu(adu, rtuCtx()).type).toBe('crc-error');
  });

  it('RTU unit mismatch is unexpected, not malformed', () => {
    const adu = buildRtuAdu(7, encodeResponsePdu({ kind: 'registers', fc: 0x03, registers: [1, 2, 3, 4] }));
    const v = validateAdu(adu, rtuCtx());
    expect(v.type).toBe('unexpected');
  });

  it('RTU function mismatch is unexpected', () => {
    const adu = buildRtuAdu(1, encodeResponsePdu({ kind: 'registers', fc: 0x04, registers: [1, 2, 3, 4] }));
    expect(validateAdu(adu, rtuCtx()).type).toBe('unexpected');
  });

  it('RTU length mismatch vs expected response is unexpected', () => {
    const adu = buildRtuAdu(1, encodeResponsePdu({ kind: 'registers', fc: 0x03, registers: [1, 2] }));
    expect(validateAdu(adu, rtuCtx()).type).toBe('unexpected');
  });

  it('TCP transaction id mismatch is unexpected and not associated', () => {
    const adu = buildTcpAdu(99, 1, encodeResponsePdu({ kind: 'registers', fc: 0x03, registers: [1, 2, 3, 4] }));
    const v = validateAdu(adu, tcpCtx(5));
    expect(v.type).toBe('unexpected');
  });

  it('TCP matching tid is ok', () => {
    const adu = buildTcpAdu(5, 1, encodeResponsePdu({ kind: 'registers', fc: 0x03, registers: [1, 2, 3, 4] }));
    expect(validateAdu(adu, tcpCtx(5)).type).toBe('ok');
  });

  it('TCP bad protocol id is malformed', () => {
    const adu = buildTcpAdu(5, 1, encodeResponsePdu({ kind: 'registers', fc: 0x03, registers: [1, 2, 3, 4] }));
    adu[3] = 0x01;
    expect(validateAdu(adu, tcpCtx(5)).type).toBe('malformed');
  });

  it('short RTU adu is malformed', () => {
    expect(validateAdu(appendCrc(new Uint8Array([1, 3])), rtuCtx()).type).toBe('malformed');
  });
});