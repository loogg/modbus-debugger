import { EventEmitter } from 'node:events';
import net from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SerialTransport, TcpTransport, type SerialPortLike, type Transport } from '../../src/main/runtime/transport';
import { ConnectionRuntime } from '../../src/main/runtime/connection-runtime';
import { SlaveRuntime } from '../../src/main/runtime/slave-runtime';
import { BlockCache } from '../../src/main/runtime/block-cache';
import { DiagnosticsStore } from '../../src/main/runtime/diagnostics';
import type { ConnectionDef } from '../../src/domain/model';

class SocketDouble extends EventEmitter {
  closed = false;
  destroyed = false;
  setNoDelay() { return this; }
  destroy() {
    if (!this.closed) { this.closed = true; this.destroyed = true; this.emit('close'); }
    return this;
  }
}

class DeferredPort extends EventEmitter implements SerialPortLike {
  isOpen = false;
  closes = 0;
  openCallback: ((error: Error | null) => void) | null = null;
  flushCallback: ((error?: Error | null) => void) | null = null;
  deferFlush = false;
  open(callback: (error: Error | null) => void) { this.openCallback = callback; }
  finishOpen(error: Error | null = null) { this.isOpen = !error; this.openCallback?.(error); }
  flush(callback: (error?: Error | null) => void) {
    if (this.deferFlush) this.flushCallback = callback; else callback();
  }
  close(callback?: (error: Error | null) => void) {
    this.isOpen = false;
    this.closes++;
    this.emit('close');
    callback?.(null);
  }
  write(_data: Buffer, callback?: (error: Error | null) => void) { callback?.(null); return true; }
}

const settings = { port: 'test', baudRate: 115200, dataBits: 8 as const, parity: 'none' as const, stopBits: 1 as const };
const transports: Transport[] = [];
const handlers = () => ({ onData: vi.fn(), onOpen: vi.fn(), onError: vi.fn(), onClose: vi.fn() });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => {
  for (const transport of transports.splice(0)) {
    const closed = transport.close();
    await vi.advanceTimersByTimeAsync(21);
    await closed;
  }
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

function tcp() {
  const socket = new SocketDouble();
  const connect = vi.spyOn(net, 'connect').mockReturnValue(socket as unknown as net.Socket);
  const transport = new TcpTransport({ host: '127.0.0.1', port: 15000 });
  const events = handlers();
  transport.setHandlers(events);
  transports.push(transport);
  return { transport, socket, connect, events };
}

function serial() {
  const ports: DeferredPort[] = [];
  const factory = vi.fn(() => { const port = new DeferredPort(); ports.push(port); return port; });
  const transport = new SerialTransport(settings, factory);
  const events = handlers();
  transport.setHandlers(events);
  transports.push(transport);
  return { transport, ports, factory, events };
}

it('bounds TCP connection time and destroys a timed-out attempt before ignoring a late connect', async () => {
  const h = tcp();
  const failed = expect(h.transport.connect(40)).rejects.toThrow('40 ms');
  await vi.advanceTimersByTimeAsync(40);
  await failed;
  expect(h.socket.destroyed).toBe(true);
  h.socket.emit('connect');
  expect(h.transport.connected).toBe(false);
  expect(h.events.onOpen).not.toHaveBeenCalled();
});

it('cancels an opening TCP socket promptly and lets a later connection remain authoritative', async () => {
  const h = tcp();
  const cancelled = expect(h.transport.connect(60000)).rejects.toThrow('cancelled');
  await h.transport.close();
  await cancelled;
  const next = new SocketDouble();
  h.connect.mockReturnValue(next as unknown as net.Socket);
  const opened = h.transport.connect(30);
  next.emit('connect');
  await opened;
  h.socket.emit('error', new Error('old socket'));
  h.socket.emit('close');
  h.socket.emit('connect');
  await vi.advanceTimersByTimeAsync(40);
  expect(h.transport.connected).toBe(true);
  expect(h.events.onOpen).toHaveBeenCalledTimes(1);
  expect(h.events.onError).not.toHaveBeenCalled();
  expect(h.events.onClose).not.toHaveBeenCalled();
});

it('settles a refused TCP connection and clears its connection timeout', async () => {
  const h = tcp();
  const failed = expect(h.transport.connect(60000)).rejects.toThrow('refused');
  h.socket.emit('error', new Error('refused'));
  await failed;
  expect(vi.getTimerCount()).toBe(0);
  expect(h.transport.connected).toBe(false);
});

it('bounds a pending serial open, closes its late success and prevents accumulating driver opens', async () => {
  const h = serial();
  const failed = expect(h.transport.connect(40)).rejects.toThrow('40 ms');
  await vi.advanceTimersByTimeAsync(40);
  await failed;
  await expect(h.transport.connect(40)).rejects.toThrow('still completing');
  expect(h.factory).toHaveBeenCalledTimes(1);
  h.ports[0]!.finishOpen();
  await vi.advanceTimersByTimeAsync(21);
  expect(h.ports[0]!.closes).toBe(1);
  expect(h.events.onOpen).not.toHaveBeenCalled();
  const opened = h.transport.connect(40);
  h.ports[1]!.finishOpen();
  await opened;
  h.ports[0]!.emit('error', new Error('retired port'));
  h.ports[0]!.emit('close');
  expect(h.transport.connected).toBe(true);
  expect(h.events.onOpen).toHaveBeenCalledTimes(1);
  expect(h.events.onError).not.toHaveBeenCalled();
});

it('cancels a serial open and closes the late driver handle', async () => {
  const h = serial();
  const cancelled = expect(h.transport.connect(60000)).rejects.toThrow('cancelled');
  await h.transport.close();
  await cancelled;
  h.ports[0]!.finishOpen();
  await vi.advanceTimersByTimeAsync(21);
  expect(h.ports[0]!.closes).toBe(1);
  expect(h.transport.connected).toBe(false);
  expect(h.events.onOpen).not.toHaveBeenCalled();
});

it('includes serial flush readiness in the connection timeout and ignores a late flush', async () => {
  const h = serial();
  const failed = expect(h.transport.connect(40)).rejects.toThrow('timeout');
  h.ports[0]!.deferFlush = true;
  h.ports[0]!.finishOpen();
  await vi.advanceTimersByTimeAsync(61);
  await failed;
  const opened = h.transport.connect(40);
  h.ports[1]!.finishOpen();
  await opened;
  h.ports[0]!.flushCallback?.();
  expect(h.events.onOpen).toHaveBeenCalledTimes(1);
  expect(h.transport.connected).toBe(true);
});

it('releases a failed serial open so the next fixed-interval attempt can succeed', async () => {
  const h = serial();
  const failed = expect(h.transport.connect(40)).rejects.toThrow('missing port');
  h.ports[0]!.finishOpen(new Error('missing port'));
  await failed;
  const opened = h.transport.connect(40);
  h.ports[1]!.finishOpen();
  await opened;
  await vi.advanceTimersByTimeAsync(50);
  expect(h.transport.connected).toBe(true);
  expect(h.events.onOpen).toHaveBeenCalledTimes(1);
});

it.each(['master', 'slave'] as const)('cancels a pending RTU %s open and can restart after the late handle is released', async role => {
  const h = serial();
  const config: ConnectionDef = { id: 'rtu', name: 'RTU', role, transport: 'rtu', rtu: settings,
    timeoutMs: 500, connectTimeoutMs: 60000, retries: 0, reconnect: 'manual', interFrameMs: 0, rtsControl: 'none', logLevel: 'info' };
  const common = { config, cache: new BlockCache(), diagnostics: new DiagnosticsStore(), hooks: { onChange() {}, onState() {} } };
  const runtime = role === 'master'
    ? new ConnectionRuntime({ ...common, transport: h.transport })
    : new SlaveRuntime({ ...common, serial: h.transport });
  try {
    const opening = runtime.start();
    await vi.advanceTimersByTimeAsync(1);
    await runtime.stop();
    await opening;
    h.ports[0]!.finishOpen();
    await vi.advanceTimersByTimeAsync(21);
    expect(runtime.state).toBe('offline');
    expect(h.ports[0]!.closes).toBe(1);
    const restarted = runtime.start();
    await vi.advanceTimersByTimeAsync(1);
    h.ports[1]!.finishOpen();
    await restarted;
    expect(runtime.state).toBe('online');
  } finally {
    const stopping = runtime.stop();
    await vi.advanceTimersByTimeAsync(21);
    await stopping;
  }
});
