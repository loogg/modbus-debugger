import { describe, expect, it } from 'vitest';
import { decodeSlaveRequest, executeSlaveRequest, SlaveRequestError } from '../../src/domain/protocol/slave';
import { RtuStreamingFramer, TcpStreamingFramer, type FramerEvent } from '../../src/domain/protocol/framer';
import { buildRtuAdu, buildTcpAdu } from '../../src/domain/protocol';
import { commandSchema } from '../../src/shared/commands';
import { migrateWorkspace, workspaceSchema } from '../../src/domain/model';
import { FakeClock, hex, unhex } from '../support/fake';
import { slaveWorkspace } from '../support/slave-workspace';

const adus = (events: FramerEvent[]) => events.filter(event => event.type === 'adu').map(event => event.type === 'adu' ? hex(event.bytes) : '');
const bytes = (fc: number, address: number, quantity: number, extra: number[] = []) => new Uint8Array([fc, address >> 8, address & 255, quantity >> 8, quantity & 255, ...extra]);

describe('slave PDU validation', () => {
  it.each([
    ['0100000009', { kind: 'read', fc: 1, address: 0, quantity: 9 }],
    ['0200100001', { kind: 'read', fc: 2, address: 16, quantity: 1 }],
    ['03ffff0001', { kind: 'read', fc: 3, address: 65535, quantity: 1 }],
    ['040000007d', { kind: 'read', fc: 4, address: 0, quantity: 125 }],
    ['050001ff00', { kind: 'writeCoil', fc: 5, address: 1, value: true }],
    ['060002abcd', { kind: 'writeRegister', fc: 6, address: 2, value: 43981 }],
    ['0f00000009025501', { kind: 'writeCoils', fc: 15, address: 0, values: [true, false, true, false, true, false, true, false, true] }],
    ['1000010002041234abcd', { kind: 'writeRegisters', fc: 16, address: 1, values: [0x1234, 0xabcd] }],
  ])('decodes independent request vector %s', (pdu, request) => { expect(decodeSlaveRequest(unhex(pdu as string))).toEqual(request); });

  it.each([
    ['0700000001', 1], ['0300000000', 3], ['03ffff0002', 2], ['01000007d1', 3], ['040000007e', 3],
    ['0500000001', 3], ['060000', 3], ['060000000100', 3], ['0f000000090101', 3],
    ['1000000002041234', 3], ['1000000002041234567800', 3],
  ])('rejects invalid vector %s with exception %s', (pdu, code) => {
    try { decodeSlaveRequest(unhex(pdu)); throw new Error('expected rejection'); }
    catch (error) { expect(error).toBeInstanceOf(SlaveRequestError); expect((error as SlaveRequestError).code).toBe(code); }
  });

  it('accepts exact quantity limits and rejects max+1, validating before memory mutation', () => {
    expect(decodeSlaveRequest(bytes(1, 0, 2000))).toMatchObject({ quantity: 2000 });
    expect(decodeSlaveRequest(bytes(15, 0, 1968, [246, ...Array(246).fill(0)]))).toMatchObject({ values: expect.any(Array) });
    expect(decodeSlaveRequest(bytes(16, 0, 123, [246, ...Array(246).fill(0)]))).toMatchObject({ values: expect.any(Array) });
    expect(() => decodeSlaveRequest(bytes(15, 0, 1969, [247, ...Array(247).fill(0)]))).toThrow(SlaveRequestError);
    expect(() => decodeSlaveRequest(bytes(16, 0, 124, [248, ...Array(248).fill(0)]))).toThrow(SlaveRequestError);
    expect(() => decodeSlaveRequest(new Uint8Array(254))).toThrow(SlaveRequestError);
  });

  it('encodes read bit packing, big endian registers and write echo from independent expected values', () => {
    const memory = { read: () => [0x1234, 0xabcd], write: () => true };
    expect(hex(executeSlaveRequest(decodeSlaveRequest(unhex('0300000002')), memory))).toBe('03041234abcd');
    expect(hex(executeSlaveRequest(decodeSlaveRequest(unhex('060002abcd')), memory))).toBe('060002abcd');
    expect(hex(executeSlaveRequest(decodeSlaveRequest(unhex('0100000009')), { ...memory, read: () => [1, 0, 1, 0, 1, 0, 1, 0, 1] }))).toBe('01025501');
    expect(() => executeSlaveRequest(decodeSlaveRequest(unhex('0300000001')), { ...memory, read: () => null })).toThrow(SlaveRequestError);
  });
});

describe('passive request streaming', () => {
  it.each(['rtu', 'tcp'] as const)('%s handles every split point and repeated requests in one chunk', kind => {
    const request = kind === 'rtu' ? buildRtuAdu(1, unhex('1000000002041234abcd')) : buildTcpAdu(42, 1, unhex('1000000002041234abcd'));
    for (let split = 1; split < request.length; split++) {
      const framer = kind === 'rtu' ? new RtuStreamingFramer({ requestFrames: true }) : new TcpStreamingFramer();
      expect(adus([...framer.push(request.slice(0, split)), ...framer.push(request.slice(split))])).toEqual([hex(request)]);
    }
    const framer = kind === 'rtu' ? new RtuStreamingFramer({ requestFrames: true }) : new TcpStreamingFramer();
    const chunk = Buffer.concat(Array.from({ length: 300 }, () => Buffer.from(request)));
    expect(adus(framer.push(chunk))).toEqual(Array(300).fill(hex(request)));
    expect(framer.pendingBytes()).toBe(0);
  });

  it('RTU recovers after a CRC error, noise and a partial request', () => {
    const framer = new RtuStreamingFramer({ requestFrames: true });
    const request = buildRtuAdu(1, unhex('0300000002'));
    const bad = request.slice(); bad[7]! ^= 0xff;
    const events = framer.push(Buffer.concat([bad, Buffer.from([255, 254, 253]), request.slice(0, 3)]));
    expect(adus(events)).toEqual([]);
    expect(adus(framer.push(request.slice(3)))).toEqual([hex(request)]);
  });

  it('TCP preserves a legal following request after a truncated declared length expires', () => {
    const clock = new FakeClock();
    const framer = new TcpStreamingFramer({ clock, incompleteTimeoutMs: 100 });
    const request = buildTcpAdu(45, 1, unhex('0300000002'));
    const events = framer.push(Buffer.concat([Buffer.from('0001000000fa0103', 'hex'), request]));
    expect(adus(events)).toEqual([]);
    clock.advance(101);
    expect(adus(framer.tick())).toEqual([hex(request)]);
  });

  it('RTU bounds continuous noise while retaining a split valid request after overflow', () => {
    const framer = new RtuStreamingFramer({ requestFrames: true, maxBuffer: 300 });
    const request = buildRtuAdu(1, unhex('0300000001'));
    const events = framer.push(Buffer.concat([Buffer.alloc(300, 255), request.slice(0, 3)]));
    expect(events.some(event => event.type === 'parse-error' && event.kind === 'overflow')).toBe(true);
    expect(framer.pendingBytes()).toBeLessThanOrEqual(300);
    expect(adus(framer.push(request.slice(3)))).toEqual([hex(request)]);
  });
});

it('keeps old workspace roles compatible and validates local memory commands and persisted bits', () => {
  const workspace = slaveWorkspace();
  delete workspace.connections[0]!.role;
  expect(migrateWorkspace(workspace).connections[0]!.role ?? 'master').toBe('master');
  expect(commandSchema.safeParse({ type: 'slave.setValues', slaveId: 's1', blockId: 'b1', offset: -1, values: [1] }).success).toBe(false);
  workspace.slaves[0]!.initialValues = [{ blockId: 'b1', area: 1, start: 0, values: [2] }];
  expect(workspaceSchema.safeParse(workspace).success).toBe(false);
});
