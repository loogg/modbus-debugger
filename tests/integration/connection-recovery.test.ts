import { EventEmitter } from 'node:events';
import net from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { connectionSchema, type ConnectionDef } from '../../src/domain/model';
import { ConnectionRuntime } from '../../src/main/runtime/connection-runtime';
import { SlaveRuntime } from '../../src/main/runtime/slave-runtime';
import { BlockCache } from '../../src/main/runtime/block-cache';
import { DiagnosticsStore } from '../../src/main/runtime/diagnostics';
import { type Transport } from '../../src/main/runtime/transport';
import { FakeTransport } from '../support/fake';

const config: ConnectionDef = {
  id: 'c', name: 'test', transport: 'tcp', timeoutMs: 500, retries: 0,
  reconnect: 'auto', reconnectIntervalMs: 25, connectTimeoutMs: 90,
  interFrameMs: 0, rtsControl: 'none', logLevel: 'info',
};
const runtimes: Array<ConnectionRuntime | SlaveRuntime> = [];
const hooks = { onChange() {}, onState() {} };

function master(overrides: Partial<ConnectionDef> = {}) {
  const current = { ...config, ...overrides };
  const wire = new FakeTransport(current.transport);
  const transport: Transport = wire;
  const runtime = new ConnectionRuntime({ config: current, transport, clock: { now: () => Date.now() },
    cache: new BlockCache(), diagnostics: new DiagnosticsStore(), hooks });
  runtimes.push(runtime);
  return { runtime, wire, transport };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.stop()));
  vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers();
});

it('validates new timing values while accepting older workspace connections', () => {
  expect(connectionSchema.parse({ ...config, connectTimeoutMs: undefined, reconnectIntervalMs: undefined }).connectTimeoutMs).toBeUndefined();
  for (const value of [1, 3000, 60000]) expect(connectionSchema.safeParse({ ...config, connectTimeoutMs: value }).success).toBe(true);
  for (const value of [0, -1, 1.5, 60001]) expect(connectionSchema.safeParse({ ...config, connectTimeoutMs: value }).success).toBe(false);
  for (const value of [0, 1, 1000, 60000]) expect(connectionSchema.safeParse({ ...config, reconnectIntervalMs: value }).success).toBe(true);
  for (const value of [-1, 1.5, 60001]) expect(connectionSchema.safeParse({ ...config, reconnectIntervalMs: value }).success).toBe(false);
});

it.each(['tcp', 'rtu'] as const)('uses a fixed interval after repeated %s connection failures and forwards the connect timeout', async transport => {
  const h = master({ transport });
  const starts: number[] = [];
  const open = vi.spyOn(h.transport, 'connect').mockImplementation(async () => {
    starts.push(Date.now());
    throw new Error('unavailable');
  });
  await h.runtime.start();
  await vi.advanceTimersByTimeAsync(81);
  expect(starts).toEqual([0, 25, 50, 75]);
  expect(open.mock.calls.every(args => args[0] === 90)).toBe(true);
  await h.runtime.stop();
  await vi.advanceTimersByTimeAsync(100);
  expect(starts).toHaveLength(4);
});

it('preserves the first reconnect deadline across duplicate transport error/close events', async () => {
  const h = master();
  const open = vi.spyOn(h.transport, 'connect');
  await h.runtime.start();
  h.wire.drop();
  await vi.advanceTimersByTimeAsync(12);
  h.wire.drop();
  await vi.advanceTimersByTimeAsync(13);
  expect(open).toHaveBeenCalledTimes(2);
  expect(h.runtime.state).toBe('online');
});

it('allows a zero reconnect interval without losing the deadline at monotonic time zero', async () => {
  const h = master({ reconnectIntervalMs: 0 });
  const open = vi.spyOn(h.transport, 'connect').mockRejectedValue(new Error('unavailable'));
  await h.runtime.start();
  await vi.advanceTimersByTimeAsync(11);
  expect(open.mock.calls.length).toBeGreaterThan(1);
  expect(open.mock.calls.length).toBeLessThanOrEqual(4);
});

it('uses legacy default timing values consistently after repeated failures', async () => {
  const h = master({ connectTimeoutMs: undefined, reconnectIntervalMs: undefined });
  const starts: number[] = [];
  const open = vi.spyOn(h.transport, 'connect').mockImplementation(async () => { starts.push(Date.now()); throw new Error('unavailable'); });
  await h.runtime.start();
  await vi.advanceTimersByTimeAsync(3001);
  expect(starts).toEqual([0, 1000, 2000, 3000]);
  expect(open.mock.calls.every(args => args[0] === 3000)).toBe(true);
});

it.each([0, 25])('uses the fixed interval %i for RTU server recovery', async reconnectIntervalMs => {
  const serial: Transport = new FakeTransport('rtu');
  const starts: number[] = [];
  const open = vi.spyOn(serial, 'connect').mockImplementation(async () => { starts.push(Date.now()); throw new Error('unavailable'); });
  const runtime = new SlaveRuntime({ config: { ...config, transport: 'rtu', role: 'slave', reconnectIntervalMs }, serial,
    cache: new BlockCache(), diagnostics: new DiagnosticsStore(), hooks, clock: { now: () => Date.now() } });
  runtimes.push(runtime);
  await runtime.start();
  await vi.advanceTimersByTimeAsync(81);
  expect(starts).toEqual([0, 25, 50, 75]);
  expect(open.mock.calls.every(args => args[0] === 90)).toBe(true);
});

class DeferredServer extends EventEmitter {
  listening = false;
  callback: (() => void) | null = null;
  listen(_options: unknown, callback: () => void) { this.callback = callback; return this; }
  close(callback?: () => void) { this.listening = false; callback?.(); return this; }
}

it.each(['timeout', 'cancel'])('settles a pending TCP server startup on %s and ignores a late listen callback', async reason => {
  const server = new DeferredServer();
  vi.spyOn(net, 'createServer').mockReturnValue(server as unknown as net.Server);
  const runtime = new SlaveRuntime({ config: { ...config, role: 'slave', tcp: { host: '127.0.0.1', port: 15000 }, reconnect: 'manual', connectTimeoutMs: 40 },
    cache: new BlockCache(), diagnostics: new DiagnosticsStore(), hooks });
  runtimes.push(runtime);
  const opening = runtime.start();
  await vi.advanceTimersByTimeAsync(1);
  if (reason === 'cancel') await runtime.stop(); else await vi.advanceTimersByTimeAsync(40);
  await opening;
  expect(runtime.state).toBe(reason === 'cancel' ? 'offline' : 'error');
  server.listening = true;
  server.callback?.();
  expect(server.listening).toBe(false);
  expect(runtime.state).toBe(reason === 'cancel' ? 'offline' : 'error');
});
