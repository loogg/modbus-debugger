import path from 'node:path';
import { expect, it } from 'vitest';
import { workspaceSchema } from '../../src/domain/model';
import { RuntimeManager } from '../../src/main/runtime/manager';
import { WorkspaceService } from '../../src/main/services/workspace';
import { HistoryStore } from '../../src/main/services/history';
import { FakeTransport } from '../support/fake';
import { createScratch } from '../../tools/test-paths.mjs';
import { buildTcpAdu, encodeResponsePdu, parseMbap, type ModbusRequest } from '../../src/domain/protocol';
import { decodeSlaveRequest, executeSlaveRequest, SlaveRequestError } from '../../src/domain/protocol/slave';
import type { PointWriteResult } from '../../src/shared/contracts';

async function waitFor(condition: () => boolean) { const end = Date.now() + 1500; while (!condition()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 5)); } }
async function setup() {
  const directory = createScratch('write-ack-'); const workspace = new WorkspaceService(path.join(directory, 'data'));
  const map = (offset: number, rawType = 'UInt16', registerCount = 1) => ({ offset, rawType, registerCount, wordOrder: 'ABCD', byteSelector: 'low', bitOffset: 0, bitWidth: 1, stringLength: rawType === 'String' ? 7 : 0, stringEncoding: 'ascii' });
  workspace.adopt(workspaceSchema.parse({ name: 'Ack', connections: [{ id: 'c', name: 'c', transport: 'tcp', tcp: { host: '127.0.0.1', port: 50525 }, timeoutMs: 50, retries: 0, reconnect: 'manual' }],
    templates: [{ id: 't', name: 't', blocks: [{ id: 'b', name: 'mixed', area: 3, start: 0, length: 10, periodMs: 60000 }, { id: 'w', name: 'commands', area: 3, start: 100, length: 4, periodMs: 0 }], points: [
      { id: 'a', name: 'A', blockId: 'b', access: 'rw', mapping: map(0) }, { id: 'b', name: 'B', blockId: 'b', access: 'ro', mapping: map(4) },
      { id: 'command', name: 'Command', blockId: 'b', access: 'wo', mapping: map(3) }, { id: 'mask', name: 'Mask', blockId: 'b', access: 'wo', mapping: map(6, 'Bool') },
      { id: 'text', name: 'Text', blockId: 'w', access: 'wo', mapping: map(0, 'String', 4) },
    ] }], slaves: [{ id: 's', name: 's', unitId: 1, connectionId: 'c', templateId: 't', enabled: true }], trendGroups: [{ id: 'g', name: 'g', signals: ['a', 'b'].map(id => ({ id, pointRef: { connectionId: 'c', slaveId: 's', pointId: id } })) }] }), null);
  const transport = new FakeTransport('tcp'); const requests: ModbusRequest[] = [];
  const memory = new Array<number>(200).fill(0); memory[0] = 10; memory[4] = 20; memory[6] = 0xab00;
  let failRange = false; let rejectWrite = false; let wrongEcho = false;
  let holdWrite = false;
  let heldReply: Uint8Array | null = null;
  transport.onResponse(adu => {
    const frame = parseMbap(adu); const request = decodeSlaveRequest(frame.pdu); requests.push(request);
    let pdu: Uint8Array;
    try {
      if (request.kind !== 'read' && rejectWrite) throw new SlaveRequestError(3, 'Rejected');
      pdu = executeSlaveRequest(request, {
        read: (_area, start, length) => start <= 3 && start + length > 3 || start <= 6 && start + length > 6 || start >= 100 || failRange && start === 4 ? null : memory.slice(start, start + length),
        write: (_area, start, values) => { memory.splice(start, values.length, ...values); if (start === 3) memory[3] = 0; return true; },
        maskWrite: (address, and, or) => { memory[address] = (memory[address]! & and) | (or & ~and & 65535); return true; },
      });
      if (wrongEcho && request.kind === 'writeRegister') pdu = encodeResponsePdu({ kind: 'writeAck', fc: 6, address: request.address + 1, extra: request.value });
    } catch (error) { pdu = encodeResponsePdu({ kind: 'exception', fc: request.fc, code: error instanceof SlaveRequestError ? error.code : 4 }); }
    const reply = buildTcpAdu(frame.transactionId, frame.unitId, pdu);
    if (holdWrite && request.kind !== 'read') { heldReply = reply; return null; }
    return [reply];
  });
  const manager = new RuntimeManager(workspace, await HistoryStore.open(path.join(directory, 'history.db')), { transportFactory: () => transport }); manager.start();
  await waitFor(() => requests.filter(request => request.kind === 'read').length >= 3);
  const write = async (pointId: string, value: number | boolean | string) => {
    const result = await manager.handleCommand({ type: 'point.write', slaveId: 's', pointId, engineering: typeof value === 'number' ? value : null, boolValue: typeof value === 'boolean' ? value : null, stringValue: typeof value === 'string' ? value : null });
    if (!result.ok) throw new Error(result.error); return result.value as PointWriteResult;
  };
  return { manager, workspace, requests, memory, write,
    set holdWrite(value: boolean) { holdWrite = value; }, releaseWrite() { if (heldReply) transport.inject(heldReply); heldReply = null; },
    get failRange() { return failRange; }, set failRange(value: boolean) { failRange = value; }, set reject(value: boolean) { rejectWrite = value; }, set wrongEcho(value: boolean) { wrongEcho = value; } };
}

it('invalidates an in-flight command when point configuration changes and changes back', async () => {
  const h = await setup();
  try {
    h.holdWrite = true;
    const pending = h.manager.handleCommand({ type: 'point.write', slaveId: 's', pointId: 'a', engineering: 99, boolValue: null, stringValue: null });
    await waitFor(() => h.requests.some(request => request.kind === 'writeRegister'));
    for (const scale of [2, 1]) {
      const point = h.workspace.current.templates[0]!.points.find(item => item.id === 'a')!;
      expect(await h.manager.handleCommand({ type: 'template.upsertPoint', templateId: 't', point: { ...point, scale }, expected: point })).toMatchObject({ ok: true });
    }
    h.releaseWrite();
    await expect(pending).rejects.toThrow('点位配置已改变');
    expect(h.manager.buildSnapshot().points['s::a']).toMatchObject({ engNumber: 10 });
    expect(h.manager.buildSnapshot().points['s::a']!.lastWrite).toBeUndefined();
  } finally { h.releaseWrite(); await h.manager.stop(); }
});

it('accepts a normal write response without changing sampled values or issuing read-back', async () => {
  const h = await setup();
  try {
    const reads = h.requests.length;
    expect(await h.write('a', 99)).toMatchObject({ phase: 'confirmed' });
    expect(h.requests.slice(reads).map(request => request.kind)).toEqual(['writeRegister']);
    expect(h.manager.buildSnapshot().points['s::a']).toMatchObject({ engNumber: 10, lastWrite: { accepted: { value: 99 }, phase: 'confirmed' } });
    expect(h.manager.sampleBuffers.info({ slaveId: 's', pointId: 'a' }).count).toBe(1);
    await h.manager.runtimeFor('c')!.refresh('s', 'b');
    expect(h.manager.buildSnapshot().points['s::a']!.engNumber).toBe(99);
    expect(h.manager.sampleBuffers.info({ slaveId: 's', pointId: 'a' }).count).toBe(2);
    expect(h.manager.sampleBuffers.info({ slaveId: 's', pointId: 'b' }).count).toBe(2);
  } finally { await h.manager.stop(); }
});

it('writes self-clearing, multi-register and masked write-only points without reads or fabricated values', async () => {
  const h = await setup();
  try {
    const before = h.requests.length;
    expect(await h.write('command', 1)).toMatchObject({ phase: 'confirmed' });
    expect(h.memory[3]).toBe(0);
    expect(await h.write('text', 'READY')).toMatchObject({ phase: 'confirmed' });
    expect(await h.write('mask', true)).toMatchObject({ phase: 'confirmed' });
    expect(h.memory[6]).toBe(0xab01);
    expect(h.requests.slice(before).map(request => request.kind)).toEqual(['writeRegister', 'writeRegisters', 'maskWrite']);
    const values = h.manager.buildSnapshot().points;
    expect(values['s::command']).toMatchObject({ hasValue: false, lastWrite: { accepted: { value: 1 } } });
    expect(values['s::mask']).toMatchObject({ hasValue: false, lastWrite: { accepted: { value: true } } });
    expect(h.manager.cache.get('s::b')!.valid[3]).toBe(false);
    expect(h.manager.cache.get('s::w')!.valid.every(valid => !valid)).toBe(true);
  } finally { await h.manager.stop(); }
});

it('reports rejection and invalid-echo timeout while preserving the last successful command', async () => {
  const h = await setup();
  try {
    await h.write('command', 1); h.reject = true;
    expect(await h.write('command', 2)).toMatchObject({ phase: 'rejected', exceptionCode: 3 });
    expect(h.manager.buildSnapshot().points['s::command']!.lastWrite).toMatchObject({ attempted: '2', accepted: { value: 1 } });
    h.reject = false; h.wrongEcho = true;
    const before = h.requests.length;
    expect(await h.write('command', 3)).toMatchObject({ phase: 'unknown' });
    expect(h.requests.slice(before)).toHaveLength(1);
    expect(h.manager.buildSnapshot().points['s::command']!.lastWrite).toMatchObject({ attempted: '3', accepted: { value: 1 } });
  } finally { await h.manager.stop(); }
});

it('retains one fragment after another fails and never samples unchanged points in other fragments', async () => {
  const h = await setup();
  try {
    h.failRange = true; h.memory[0] = 11; h.memory[4] = 22;
    await h.manager.runtimeFor('c')!.refresh('s', 'b');
    const values = h.manager.buildSnapshot().points;
    expect(values['s::a']!.engNumber).toBe(11); expect(values['s::b']!.engNumber).toBe(20);
    expect(h.manager.sampleBuffers.info({ slaveId: 's', pointId: 'a' }).count).toBe(2);
    expect(h.manager.sampleBuffers.info({ slaveId: 's', pointId: 'b' }).count).toBe(1);
    expect(h.manager.cache.get('s::b')!.status).toBe('exception');
  } finally { await h.manager.stop(); }
});
