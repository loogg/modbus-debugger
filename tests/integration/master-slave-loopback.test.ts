import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { loopbackWorkspace, loopVectors, goldenWords, type LoopVector } from '../support/loopback-workspace';
import { RuntimeManager } from '../../src/main/runtime/manager';
import { WorkspaceService } from '../../src/main/services/workspace';
import { HistoryStore } from '../../src/main/services/history';
import { createScratch } from '../../tools/test-paths.mjs';
import type { PointViewState } from '../../src/shared/snapshot';
import type { Command } from '../../src/shared/commands';
import type { ModbusRequest } from '../../src/domain/protocol';

const waitFor = async (predicate: () => boolean, message: string, timeout = 12000) => {
  const started = Date.now();
  while (!predicate()) { if (Date.now() - started > timeout) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 20)); }
};
async function freePort() { const server = net.createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const port = (server.address() as net.AddressInfo).port; await new Promise<void>(resolve => server.close(() => resolve())); return port; }

function expectValue(view: PointViewState | undefined, vector: LoopVector, raw: number | boolean | string) {
  expect(view?.hasValue, vector.id).toBe(true);
  if (typeof raw === 'boolean') expect(view?.boolValue, vector.id).toBe(raw);
  else if (typeof raw === 'string') expect(view?.stringValue, vector.id).toBe(raw);
  else if (vector.enumMap) { expect(view?.rawNumber, vector.id).toBe(raw); expect(view?.enumLabel, vector.id).toBe(vector.enumMap[String(raw)] ?? null); }
  else expect(view?.engNumber, vector.id).toBeCloseTo(raw * (vector.scale ?? 1) + (vector.offset ?? 0), 10);
}

for (const transport of ['tcp', 'rtu'] as const) describe.skipIf(transport === 'rtu' && process.env.MODBUS_SELF_RTU !== '1')(`actual ${transport.toUpperCase()} master <-> slave in the same application`, () => {
  let manager: RuntimeManager, history: HistoryStore, root: string;
  let expected: number[];
  const masterId = `${transport}-master-1`, serverId = `${transport}-server-1`;
  const point = (id: string, slaveId = masterId) => manager.buildSnapshot().points[`${slaveId}::${id}`];
  const registers = () => {
    const memory = manager.cache.get(`${serverId}::holding`)!.memory;
    if (memory.kind !== 'registers') throw new Error('wrong memory kind');
    return Array.from(memory.registers);
  };
  const command = async (cmd: Command) => { const result = await manager.handleCommand(cmd); expect(result.ok, result.ok ? '' : result.error).toBe(true); return result; };
  const refresh = () => command({ type: 'device.refresh', slaveId: masterId });
  const write = (id: string, value: number | boolean | string, slaveId = masterId) => command({ type: 'point.write', slaveId, pointId: id,
    engineering: typeof value === 'number' ? value : null, boolValue: typeof value === 'boolean' ? value : null, stringValue: typeof value === 'string' ? value : null });
  const wire = (request: ModbusRequest, unit = 1) => {
    const runtime = manager.runtimeFor(`${transport}-master`)!;
    let result: Awaited<ReturnType<typeof runtime.executeRequest>>;
    return runtime.enqueue(1, 'self-test-wire', async () => { result = await runtime.executeRequest(unit, request, { sourceKind: 'temporary-read', sourceId: null }); }).then(() => result!);
  };
  beforeAll(async () => {
    root = createScratch(`loopback-${transport}-`);
    const service = new WorkspaceService(path.join(root, 'data'));
    const workspace = loopbackWorkspace({ tcpPort: await freePort(), transports: [transport], masterPort: process.env.MODBUS_SELF_MASTER_PORT ?? 'COM2', slavePort: process.env.MODBUS_SELF_SLAVE_PORT ?? 'COM1' });
    service.adopt(workspace, path.join(root, 'loop.workspace.json'));
    history = await HistoryStore.open(path.join(root, 'history.db'));
    manager = new RuntimeManager(service, history); manager.start();
    await command({ type: 'connection.connect', connectionId: `${transport}-server` });
    await waitFor(() => manager.buildSnapshot().connections[`${transport}-master`]?.state !== 'connecting', 'master connect did not settle');
    await command({ type: 'connection.connect', connectionId: `${transport}-master` });
    await refresh();
    expected = registers();
  }, 25000);
  afterAll(async () => { await manager?.stop(); });

  it('uses real transport requests with independent confirmed caches and reads every input-area type', () => {
    const snapshot = manager.buildSnapshot();
    expect(snapshot.connections[`${transport}-master`]?.state).toBe('online');
    expect(snapshot.connections[`${transport}-server`]?.state).toBe('online');
    expect(manager.cache.get(`${masterId}::holding`)!.memory).not.toBe(manager.cache.get(`${serverId}::holding`)!.memory);
    for (const vector of loopVectors) {
      expectValue(point(`${vector.id}-holding`), vector, vector.initial);
      expectValue(point(`${vector.id}-input`), vector, vector.initial);
    }
    const tx = manager.diagnostics.recentTransactions().find(tx => tx.connectionId === `${transport}-master` && tx.sourceKind === 'poll' && tx.result === 'ok');
    expect(tx).toBeDefined();
    expect(manager.diagnostics.recentTransactions().some(server => server.sourceKind === 'slave' && server.requestAduHex === tx!.requestAduHex && server.responseAduHex === tx!.responseAduHex)).toBe(true);
  });

  for (const vector of loopVectors) it(`writes, reads back, and preserves golden raw memory: ${vector.id}`, async () => {
    const engineering = typeof vector.written === 'number' && !vector.enumMap ? vector.written * (vector.scale ?? 1) + (vector.offset ?? 0) : vector.written;
    const result = await write(`${vector.id}-holding`, engineering);
    expect(result.ok && result.value).toMatchObject({ phase: 'confirmed' });
    expected = goldenWords(vector, vector.written, expected);
    expect(registers(), vector.id).toEqual(expected);
    expectValue(point(`${vector.id}-holding`), vector, vector.written);
    expectValue(point(`${vector.id}-holding`, serverId), vector, vector.written);
    // The same interpretation in input registers remains unchanged.
    expectValue(point(`${vector.id}-input`), vector, vector.initial);
  }, 12000);

  it('covers FC01/02/03/04/05/06/15/16 including exact maximum quantities and address 65535', async () => {
    expect((await wire({ kind: 'writeCoil', fc: 5, address: 0, value: true })).result).toBe('ok');
    expect((await wire({ kind: 'read', fc: 1, address: 0, quantity: 1 })).response).toMatchObject({ kind: 'bits', bits: [true, false, false, false, false, false, false, false] });
    expect((await wire({ kind: 'read', fc: 2, address: 0, quantity: 16 })).result).toBe('ok');
    expect((await wire({ kind: 'writeRegister', fc: 6, address: 65535, value: 0xabcd })).result).toBe('ok');
    expect((await wire({ kind: 'read', fc: 3, address: 65535, quantity: 1 })).response).toMatchObject({ registers: [0xabcd] });
    expect((await wire({ kind: 'read', fc: 4, address: 300, quantity: 125 })).result).toBe('ok');
    const bits = Array.from({ length: 1968 }, (_, index) => index % 3 === 0);
    expect((await wire({ kind: 'writeCoils', fc: 15, address: 1000, values: bits })).result).toBe('ok');
    const readBits = (await wire({ kind: 'read', fc: 1, address: 1000, quantity: 2000 })).response;
    expect(readBits?.kind === 'bits' && readBits.bits.slice(0, 1968)).toEqual(bits);
    const values = Array.from({ length: 123 }, (_, index) => index * 257);
    expect((await wire({ kind: 'writeRegisters', fc: 16, address: 1000, values })).result).toBe('ok');
    expect((await wire({ kind: 'read', fc: 3, address: 1000, quantity: 123 })).response).toMatchObject({ registers: values });
    expect((await wire({ kind: 'writeRegisters', fc: 16, address: 2002, values: [1, 2, 3, 4] })).result).toBe('ok');
    expect((await wire({ kind: 'read', fc: 3, address: 2002, quantity: 4 })).response).toMatchObject({ registers: [1, 2, 3, 4] });
    expect((await wire({ kind: 'writeRegisters', fc: 16, address: 2006, values: [9, 9, 9, 9] })).result).toBe('exception');
    expect((await wire({ kind: 'read', fc: 3, address: 2006, quantity: 2 })).response).toMatchObject({ registers: [0, 0] });
    const fcs = new Set(manager.diagnostics.recentTransactions().filter(tx => tx.connectionId === `${transport}-master` && tx.result === 'ok').map(tx => tx.functionCode));
    expect([...fcs].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 15, 16]);
  }, 15000);

  it('handles empty/max-length String and rejects overflow/invalid encodings without changing either confirmed value', async () => {
    const text = 'A'.repeat(246);
    await write('String-246', text);
    expect(point('String-246')?.stringValue).toBe(text);
    expect(point('String-246', serverId)?.stringValue).toBe(text);
    for (const [id, stringValue] of [['ASCII-holding', '123456789'], ['ASCII-holding', '中文'], ['ASCII-holding', 'A\0B'], ['UTF8-odd-holding', '中文'], ['String-246', 'A'.repeat(247)]] as const) for (const slaveId of [masterId, serverId]) {
      const before = point(id)?.stringValue;
      const previous = registers();
      const result = await manager.handleCommand({ type: 'point.write', slaveId, pointId: id, engineering: null, boolValue: null, stringValue });
      expect(result.ok, `${id}: ${stringValue}`).toBe(false);
      expect(point(id!)?.stringValue).toBe(before); expect(registers()).toEqual(previous);
    }
  }, 15000);

  it('checks numeric min/max and rejects overflow, Float32 infinity and read-only writes before sending', async () => {
    for (const [id, limits] of [['Int8-low', [-128, 127]], ['UInt8-low', [0, 255]], ['Int16', [-32768, 32767]], ['UInt16', [0, 65535]], ['Int32-ABCD', [-2147483648, 2147483647]], ['UInt32-ABCD', [0, 4294967295]]] as const) {
      for (const value of limits) { await write(`${id}-holding`, value); expect(point(`${id}-holding`)?.rawNumber).toBe(value); }
      for (const engineering of [limits[0] - 1, limits[1] + 1]) {
        const result = await manager.handleCommand({ type: 'point.write', slaveId: masterId, pointId: `${id}-holding`, engineering, boolValue: null, stringValue: null });
        expect(result.ok, `${id}: ${engineering}`).toBe(false);
      }
    }
    for (const slaveId of [masterId, serverId]) {
      const before = point('Float32-ABCD-holding', slaveId)?.rawNumber;
      const result = await manager.handleCommand({ type: 'point.write', slaveId, pointId: 'Float32-ABCD-holding', engineering: 1e39, boolValue: null, stringValue: null });
      expect(result.ok).toBe(false); expect(point('Float32-ABCD-holding', slaveId)?.rawNumber).toBe(before);
    }
    const readOnly = await manager.handleCommand({ type: 'point.write', slaveId: masterId, pointId: 'UInt16-input', engineering: 1, boolValue: null, stringValue: null });
    expect(readOnly.ok).toBe(false);
    await command({ type: 'slave.setValues', slaveId: serverId, blockId: 'input', offset: 2, values: [4321] });
    await refresh(); expect(point('UInt16-input')?.engNumber).toBe(4321);
    await command({ type: 'device.refresh', slaveId: `${transport}-master-2` });
    expect(point('UInt16-holding', `${transport}-master-2`)?.engNumber).toBe(2222);
  }, 25000);

  it('scans all four areas, discovers exceptions, stops scanning and restores polling; temporary reads cover four areas', async () => {
    for (const area of [1, 2, 3, 4] as const) {
      const result = await manager.handleCommand({ type: 'device.scan', connectionId: `${transport}-master`, from: 1, to: 2, options: { fc: area, start: area <= 2 ? 0 : area === 3 ? 100 : 300, timeoutMs: 300, retries: 0 } });
      expect(result.ok && result.value).toMatchObject([{ unitId: 1 }, { unitId: 2 }]);
      const read = await manager.handleCommand({ type: 'device.temporaryRead', connectionId: `${transport}-master`, unitId: 1, area, start: area <= 2 ? 0 : area === 3 ? 100 : 300, quantity: 10 });
      expect(read.ok && read.value).toMatchObject({ result: 'ok' });
    }
    const task = manager.handleCommand({ type: 'device.scan', connectionId: `${transport}-master`, from: 1, to: 20, options: { fc: 3, start: 100, timeoutMs: 100, retries: 0 } });
    await waitFor(() => manager.buildSnapshot().connections[`${transport}-master`]?.scan?.checked === 2, 'scanner did not check both real units');
    await command({ type: 'device.stopScan', connectionId: `${transport}-master` }); await task;
    expect(manager.buildSnapshot().connections[`${transport}-master`]?.scan?.phase).toBe('stopped');
    await refresh();
    expect((await wire({ kind: 'read', fc: 3, address: 0, quantity: 1 })).exceptionCode).toBe(2);
  }, 20000);

  it('displays confirmed non-finite device Float32 values without accepting non-finite writes, then recovers', async () => {
    for (const [high, text] of [[0x7fc0, 'NaN'], [0x7f80, 'Infinity'], [0xff80, '-Infinity']] as const) {
      await command({ type: 'slave.setValues', slaveId: serverId, blockId: 'holding', offset: 20, values: [high, 0] });
      await refresh();
      expect(point('Float32-ABCD-holding')?.finite).toBe(false);
      expect(point('Float32-ABCD-holding')?.engNumber).toBeNull();
      expect(point('Float32-ABCD-holding')?.engText).toBe('非有限数值');
      expect(point('Float32-ABCD-holding')?.rawText).toBe(text);
    }
    await write('Float32-ABCD-holding', 12.25);
    expect(point('Float32-ABCD-holding')?.engNumber).toBe(12.25);
  }, 15000);

  it('records Numeric/Bool/Enum/String from both ends and persists raw requests with correct directions', async () => {
    await command({ type: 'prefs.set', patch: { persistRawComm: true } });
    await command({ type: 'trend.startRecording', groupId: `${transport}-trend` });
    const id = manager.buildSnapshot().recording!.sessionId;
    await new Promise(resolve => setTimeout(resolve, 150));
    await write('Float32-ABCD-holding', 12.25); await write('coils-0', false); await write('Enum-holding', 2); await write('UTF8-holding', '闭环🙂');
    await new Promise(resolve => setTimeout(resolve, 200));
    await command({ type: 'trend.stopRecording' });
    const schema = history.getSession(id)!.schema;
    expect(schema).toHaveLength(10);
    expect(history.readSamples(id).some(row => row.value === 12.25)).toBe(true);
    expect(history.readSamples(id).some(row => row.value === 2.345678901234)).toBe(true);
    const events = history.readEvents(id);
    for (const kind of ['bool', 'enum', 'string']) expect(events.some(row => row.kind === kind), kind).toBe(true);
    const metadata = history.readTransactionMetadata(id), raw = history.readRawComm(id);
    for (const tx of metadata) {
      const original = manager.diagnostics.findTransaction(tx.traceId)!;
      const request = raw.find(frame => frame.traceId === tx.traceId && frame.hex === original.requestAduHex)!;
      expect(request.direction, tx.sourceKind).toBe(tx.sourceKind === 'slave' ? 'rx' : 'tx');
      if (original.responseAduHex) expect(raw.find(frame => frame.traceId === tx.traceId && frame.hex === original.responseAduHex && frame.direction === (tx.sourceKind === 'slave' ? 'tx' : 'rx'))).toBeDefined();
    }
    expect(metadata.some(tx => tx.sourceKind === 'slave')).toBe(true);
    const file = path.join(root, 'result.json'); fs.writeFileSync(file, JSON.stringify({ transport, typeCases: loopVectors.map(vector => vector.id), session: history.getSession(id), transactions: metadata.length }, null, 2));
  }, 15000);

  it('handles stopped slave timeouts and recovers without discarding the last confirmed value', async () => {
    const before = point('UInt16-holding')?.engNumber;
    await command({ type: 'connection.disconnect', connectionId: `${transport}-server` });
    if (transport === 'tcp') {
      await waitFor(() => manager.buildSnapshot().connections[`${transport}-master`]?.state === 'error', 'TCP master did not observe server close');
      await expect(manager.handleCommand({ type: 'device.temporaryRead', connectionId: `${transport}-master`, unitId: 1, area: 3, start: 100, quantity: 1 })).rejects.toThrow(/offline/i);
    } else {
      const read = await manager.handleCommand({ type: 'device.temporaryRead', connectionId: `${transport}-master`, unitId: 1, area: 3, start: 100, quantity: 1 });
      expect(read.ok && read.value).toMatchObject({ result: 'timeout' });
    }
    expect(point('UInt16-holding')?.engNumber).toBe(before);
    await command({ type: 'connection.connect', connectionId: `${transport}-server` });
    await command({ type: 'connection.connect', connectionId: `${transport}-master` });
    await refresh(); expect(point('UInt16-holding')?.hasValue).toBe(true);
    await command({ type: 'slave.saveInitialValues', slaveId: serverId });
    expect(fs.existsSync(manager.workspaceService.currentPath!)).toBe(true);
  }, 20000);
});
