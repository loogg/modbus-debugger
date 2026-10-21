import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { SlaveRuntime } from '../../src/main/runtime/slave-runtime';
import { BlockCache } from '../../src/main/runtime/block-cache';
import { DiagnosticsStore } from '../../src/main/runtime/diagnostics';
import { SerialTransport, type SerialPortLike } from '../../src/main/runtime/transport';
import { RuntimeManager } from '../../src/main/runtime/manager';
import { WorkspaceService } from '../../src/main/services/workspace';
import { HistoryStore } from '../../src/main/services/history';
import { buildRtuAdu, buildTcpAdu } from '../../src/domain/protocol';
import { createScratch } from '../../tools/test-paths.mjs';
import { slaveWorkspace } from '../support/slave-workspace';
import { FakeClock, hex, unhex } from '../support/fake';
import type { ConnectionDef } from '../../src/domain/model';
import type { AppDelta } from '../../src/shared/snapshot';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const waitFor = async (condition: () => boolean, timeout = 2500) => {
  const started = Date.now();
  while (!condition()) { if (Date.now() - started > timeout) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
};
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
async function connect(port: number): Promise<net.Socket> {
  const socket = net.connect({ host: '127.0.0.1', port });
  cleanup.push(() => { socket.destroy(); });
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  return socket;
}
function exchange(socket: net.Socket, chunks: Uint8Array[], count = 1): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const frames: string[] = [];
    const timer = setTimeout(() => { socket.off('data', receive); reject(new Error(`Expected ${count} frames, got ${frames.length}`)); }, 3000);
    const receive = (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 7) {
        const total = 6 + buffer.readUInt16BE(4);
        if (buffer.length < total) break;
        frames.push(buffer.subarray(0, total).toString('hex'));
        buffer = buffer.subarray(total);
      }
      if (frames.length >= count) { clearTimeout(timer); socket.off('data', receive); resolve(frames); }
    };
    socket.on('data', receive);
    for (const chunk of chunks) socket.write(chunk);
  });
}
const request = (pdu: string, tid = 0x1234, unit = 1) => buildTcpAdu(tid, unit, unhex(pdu));

async function runtimeHarness(config?: ConnectionDef) {
  const workspace = slaveWorkspace(await freePort());
  const connection = config ?? workspace.connections[0]!;
  const cache = new BlockCache();
  const diagnostics = new DiagnosticsStore();
  const runtime = new SlaveRuntime({ config: connection, cache, diagnostics, hooks: { onChange() {}, onState() {} } });
  cleanup.push(() => runtime.stop());
  runtime.configure(workspace.slaves.flatMap(slave => workspace.templates[0]!.blocks.map(block => ({ slave, block }))));
  await runtime.start();
  expect(runtime.state).toBe('online');
  return { runtime, workspace, cache, diagnostics, port: connection.tcp!.port };
}

describe('real TCP slave server', () => {
  it('serves all eight function codes and keeps input areas and Units independent', async () => {
    const h = await runtimeHarness();
    h.runtime.setValues('s1', 'b2', 0, [1, 0, 1]);
    h.runtime.setValues('s1', 'b4', 0, [0xabcd]);
    const socket = await connect(h.port);
    const send = async (pdu: string, unit = 1) => (await exchange(socket, [request(pdu, 0x1234, unit)]))[0]!.slice(14);
    expect(await send('050000ff00')).toBe('050000ff00');
    expect(await send('0100000003')).toBe('010101');
    expect(await send('0200000003')).toBe('020105');
    expect(await send('0600001234')).toBe('0600001234');
    expect(await send('0300000001')).toBe('03021234');
    expect(await send('0400000001')).toBe('0402abcd');
    expect(await send('0f00000009025501')).toBe('0f00000009');
    expect(await send('0100000009')).toBe('01025501');
    expect(await send('1000000002041234abcd')).toBe('1000000002');
    expect(await send('0300000002')).toBe('03041234abcd');
    expect(await send('0300000002', 2)).toBe('030400000000');
    expect(h.diagnostics.recentTransactions().every(tx => tx.sourceKind === 'slave' && tx.mbapTransactionId === 0x1234 && tx.requestPduHex)).toBe(true);
  });

  it('writes across adjacent blocks atomically and rejects malformed/gapped ranges without mutation', async () => {
    const h = await runtimeHarness();
    const socket = await connect(h.port);
    const send = async (pdu: string) => (await exchange(socket, [request(pdu)]))[0]!.slice(14);
    expect(await send('10000f000306123456789abc')).toBe('10000f0003');
    expect(await send('03000f0003')).toBe('0306123456789abc');
    expect(await send('100011000306111122223333')).toBe('9002');
    expect(await send('0300110001')).toBe('03029abc');
    expect(await send('100000000204ffff')).toBe('9003');
    expect(await send('0300000001')).toBe('03020000');
    expect(await send('0500000001')).toBe('8503');
    expect(await send('0700000001')).toBe('8701');
    expect(await send('03ffff0002')).toBe('8302');
    expect(await send('0300000000')).toBe('8303');
  });

  it('isolates fragmented streams and transaction IDs for simultaneous masters, and recovers garbage', async () => {
    const h = await runtimeHarness();
    const a = await connect(h.port), b = await connect(h.port);
    const frame = request('0300000001', 7);
    const pending = exchange(a, [frame.slice(0, 4)]);
    const replyB = await exchange(b, [request('060000002a', 99)]);
    a.write(frame.slice(4));
    expect(replyB[0]!.slice(0, 4)).toBe('0063');
    expect((await pending)[0]).toBe('000700000005010302002a');
    const good1 = request('0300000001', 8), good2 = request('0300000001', 9);
    const replies = await exchange(a, [Buffer.concat([Buffer.from('ffffffffffffffff', 'hex'), good1, good2])], 2);
    expect(replies.map(reply => reply.slice(0, 4))).toEqual(['0008', '0009']);
    expect(h.diagnostics.recentParseEvents().length).toBeGreaterThan(0);
  });

  it('releases clients and port on stop, preserves memory on restart, and reports port conflicts', async () => {
    const h = await runtimeHarness();
    h.runtime.setValues('s1', 'b3', 0, [77]);
    const socket = await connect(h.port);
    await waitFor(() => h.runtime.clientCount === 1);
    const conflict = new SlaveRuntime({ config: h.workspace.connections[0]!, cache: new BlockCache(), diagnostics: new DiagnosticsStore(), hooks: { onChange() {}, onState() {} } });
    cleanup.push(() => conflict.stop());
    await conflict.start();
    expect(conflict.state).toBe('error');
    expect(conflict.detail).toMatch(/EADDRINUSE/);
    await h.runtime.stop();
    await waitFor(() => socket.destroyed);
    expect(h.runtime.clientCount).toBe(0);
    await h.runtime.start();
    const reopened = await connect(h.port);
    expect((await exchange(reopened, [request('0300000001')]))[0]!.slice(14)).toBe('0302004d');
    const stopping = h.runtime.stop();
    const restarting = h.runtime.start();
    await Promise.all([stopping, restarting]);
    expect(h.runtime.state).toBe('online');
  });

  it('interoperates with an independent PyModbus master for all eight function codes', async () => {
    const h = await runtimeHarness();
    h.runtime.setValues('s1', 'b2', 0, [1]); h.runtime.setValues('s1', 'b4', 0, [456]);
    const script = path.resolve('tools/simulator/slave_client_check.py');
    const child = spawn('python', [script, '--port', String(h.port)], { windowsHide: true });
    let output = '';
    child.stdout.on('data', data => { output += String(data); }); child.stderr.on('data', data => { output += String(data); });
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    expect(output).toContain('SLAVE_INTEROP_OK'); expect(code, output).toBe(0);
  }, 15000);
});

class TestSerialPort extends EventEmitter implements SerialPortLike {
  isOpen = false;
  sent: Buffer[] = [];
  open(callback: (error: Error | null) => void) { this.isOpen = true; callback(null); }
  flush(callback: (error?: Error | null) => void) { callback(null); }
  write(data: Buffer, callback?: (error: Error | null) => void) { this.sent.push(data); callback?.(null); return true; }
  close(callback?: (error: Error | null) => void) { this.isOpen = false; callback?.(null); }
}

it('uses the formal SerialTransport for RTU fragmentation, broadcast, disabled Units and stop/restart', async () => {
  const workspace = slaveWorkspace(); let port = new TestSerialPort(); const clock = new FakeClock();
  const config: ConnectionDef = { ...workspace.connections[0]!, transport: 'rtu', tcp: undefined, rtu: { port: 'test', baudRate: 19200, dataBits: 8, parity: 'none', stopBits: 1 } };
  const cache = new BlockCache(), diagnostics = new DiagnosticsStore();
  const serial = new SerialTransport(config.rtu!, () => { port = new TestSerialPort(); return port; });
  const runtime = new SlaveRuntime({ config, serial, cache, diagnostics, clock, hooks: { onChange() {}, onState() {} } });
  cleanup.push(() => runtime.stop());
  workspace.slaves[1]!.enabled = false;
  runtime.configure(workspace.slaves.flatMap(slave => workspace.templates[0]!.blocks.map(block => ({ slave, block }))));
  await runtime.start();
  expect(port.sent).toHaveLength(0);
  const broadcast = buildRtuAdu(0, unhex('0600000042'));
  for (const byte of broadcast) port.emit('data', Buffer.from([byte]));
  expect(cache.get('s1::b3')!.memory).toEqual({ kind: 'registers', registers: new Uint16Array([66, ...Array(15).fill(0)]) });
  expect(port.sent).toHaveLength(0);
  const read = buildRtuAdu(1, unhex('0300000001'));
  const bad = read.slice(); bad[7]! ^= 255;
  port.emit('data', Buffer.concat([bad, read.slice(0, 4)])); port.emit('data', Buffer.from(read.slice(4)));
  await waitFor(() => port.sent.length === 1);
  expect(hex(port.sent[0]!)).toBe(hex(buildRtuAdu(1, unhex('03020042'))));
  port.emit('data', Buffer.from(buildRtuAdu(2, unhex('0600000055'))));
  port.emit('data', Buffer.from(buildRtuAdu(0, unhex('0300000001'))));
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(port.sent).toHaveLength(1);
  clock.advance(1100);
  const firstResponse = hex(port.sent[0]!);
  await runtime.stop(); expect(serial.connected).toBe(false);
  await runtime.start(); expect(serial.connected).toBe(true);
  port.emit('data', Buffer.from(read)); await waitFor(() => port.sent.length === 1);
  expect(hex(port.sent[0]!)).toBe(firstResponse);
});

it('Main commands publish confirmed values, persist initial memory, record samples and prevent master-only requests', async () => {
  const dir = createScratch('slave-manager-');
  const workspace = slaveWorkspace(await freePort());
  const service = new WorkspaceService(dir); service.adopt(workspace, null);
  const history = await HistoryStore.open(path.join(dir, 'history.db'));
  const manager = new RuntimeManager(service, history); manager.start(); cleanup.push(() => manager.stop());
  const deltas: AppDelta[] = []; manager.onDelta = delta => deltas.push(delta);
  expect(manager.buildSnapshot().connections.server!.state).toBe('offline');
  expect(manager.diagnostics.transactionTotal).toBe(0);
  expect((await manager.handleCommand({ type: 'slave.setValues', slaveId: 's1', blockId: 'b4', offset: 0, values: [123] })).ok).toBe(true);
  expect(manager.buildSnapshot().points['s1::p4']?.engNumber).toBe(123);
  expect((await manager.handleCommand({ type: 'slave.setValues', slaveId: 's1', blockId: 'b1', offset: 0, values: [2] })).ok).toBe(false);
  expect(manager.buildSnapshot().points['s1::p1']?.boolValue).toBe(false);
  expect((await manager.handleCommand({ type: 'point.write', slaveId: 's1', pointId: 'p3', engineering: 321, boolValue: null, stringValue: null })).ok).toBe(true);
  const save = await manager.handleCommand({ type: 'slave.saveInitialValues', slaveId: 's1' }); expect(save.ok).toBe(true);
  expect(deltas.some(delta => delta.workspacePath === service.currentPath && delta.workspacePath !== null)).toBe(true);
  expect(JSON.parse(fs.readFileSync(service.currentPath!, 'utf8')).slaves[0].initialValues.find((value: { blockId: string }) => value.blockId === 'b3').values[0]).toBe(321);
  expect((await manager.handleCommand({ type: 'device.temporaryRead', connectionId: 'server', unitId: 1, area: 3, start: 0, quantity: 1 })).ok).toBe(false);
  expect((await manager.handleCommand({ type: 'device.scan', connectionId: 'server', from: 1, to: 2 })).ok).toBe(false);
  expect(manager.startRecording('trend').ok).toBe(true);
  await waitFor(() => manager.buildSnapshot().recording!.sampleCount > 0);
  const sessionId = manager.buildSnapshot().recording!.sessionId;
  manager.stopRecording();
  expect(history.readSamples(sessionId).some(sample => sample.value === 321)).toBe(true);
  const secondService = new WorkspaceService(path.join(dir, 'second')); secondService.adopt(service.current, null);
  const secondHistory = await HistoryStore.open(path.join(dir, 'second-history.db'));
  const second = new RuntimeManager(secondService, secondHistory); second.start(); cleanup.push(() => second.stop());
  expect(second.buildSnapshot().points['s1::p3']?.engNumber).toBe(321);
  expect(manager.diagnostics.transactionTotal).toBe(0);
  const current = service.current;
  service.set({ ...current, templates: current.templates.map(template => ({ ...template, points: template.points.map(point => point.id === 'p3' ? { ...point, enumMap: { '0': '停止' } } : point) })) });
  manager.workspaceChanged();
  for (const engineering of [Infinity, 65536, -1]) {
    expect((await manager.handleCommand({ type: 'point.write', slaveId: 's1', pointId: 'p3', engineering, boolValue: null, stringValue: null })).ok).toBe(false);
  }
  expect(manager.buildSnapshot().points['s1::p3']?.engNumber).toBe(321);
});

it.skipIf(!process.env.MODBUS_SLAVE_RTU_PORT || !process.env.MODBUS_SLAVE_MASTER_PORT)('interoperates with PyModbus over the explicitly selected virtual serial pair', async () => {
  const workspace = slaveWorkspace();
  const config: ConnectionDef = { ...workspace.connections[0]!, transport: 'rtu', tcp: undefined,
    rtu: { port: process.env.MODBUS_SLAVE_RTU_PORT!, baudRate: 19200, dataBits: 8, parity: 'none', stopBits: 1 } };
  const runtime = new SlaveRuntime({ config, cache: new BlockCache(), diagnostics: new DiagnosticsStore(),
    serial: new SerialTransport(config.rtu!), hooks: { onChange() {}, onState() {} } });
  cleanup.push(() => runtime.stop());
  runtime.configure(workspace.slaves.flatMap(slave => workspace.templates[0]!.blocks.map(block => ({ slave, block }))));
  runtime.setValues('s1', 'b2', 0, [1]); runtime.setValues('s1', 'b4', 0, [456]);
  await runtime.start(); expect(runtime.state, runtime.detail ?? '').toBe('online');
  const child = spawn('python', [path.resolve('tools/simulator/slave_client_check.py'), '--serial', process.env.MODBUS_SLAVE_MASTER_PORT!, '--broadcast-check'], { windowsHide: true });
  let output = ''; child.stdout.on('data', data => { output += String(data); }); child.stderr.on('data', data => { output += String(data); });
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  expect(code, output).toBe(0); expect(output).toContain('SLAVE_INTEROP_OK'); expect(output).toContain('RTU_BROADCAST_OK');
  await runtime.stop(); await runtime.start(); expect(runtime.state, runtime.detail ?? '').toBe('online');
}, 20000);
