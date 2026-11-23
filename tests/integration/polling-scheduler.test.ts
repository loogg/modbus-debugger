import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { blockSchema, connectionSchema, type BlockDef, type ConnectionDef, type SlaveDef } from '../../src/domain/model';
import { buildRtuAdu, buildTcpAdu, encodeResponsePdu } from '../../src/domain/protocol';
import { BlockCache } from '../../src/main/runtime/block-cache';
import { ConnectionRuntime } from '../../src/main/runtime/connection-runtime';
import { DiagnosticsStore } from '../../src/main/runtime/diagnostics';
import { FakeTransport } from '../support/fake';

const connection: ConnectionDef = {
  id: 'c', name: 'TCP', transport: 'tcp', timeoutMs: 50, retries: 0,
  reconnect: 'manual', interFrameMs: 0, rtsControl: 'none', logLevel: 'info',
};
const slave: SlaveDef = { id: 's', connectionId: 'c', unitId: 1, name: 'S', templateId: 't', enabled: true };
const block: BlockDef = { id: 'a', name: 'A', area: 3, start: 0, length: 1, periodMs: 60000 };
const runtimes: ConnectionRuntime[] = [];

function setup(overrides: Partial<ConnectionDef> = {}, blocks: BlockDef[] = [block]) {
  const config = { ...connection, ...overrides };
  const transport = new FakeTransport(config.transport);
  const cache = new BlockCache();
  const diagnostics = new DiagnosticsStore();
  const runtime = new ConnectionRuntime({
    config, transport, cache, diagnostics, clock: { now: () => Date.now() },
    hooks: { onChange: () => undefined, onState: () => undefined },
  });
  runtime.configure(blocks.map(item => ({ slave, block: item })));
  runtimes.push(runtime);
  const reply = (request: Uint8Array, value = 7) => {
    const pdu = encodeResponsePdu({ kind: 'registers', fc: 3, registers: [value] });
    return config.transport === 'rtu'
      ? buildRtuAdu(request[0]!, pdu)
      : buildTcpAdu((request[0]! << 8) | request[1]!, request[6]!, pdu);
  };
  return { runtime, transport, cache, diagnostics, reply };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.stop()));
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('accepts zero and millisecond block periods and validates the optional connection retry delay', () => {
  for (const periodMs of [0, 1, 5, 60000]) expect(blockSchema.parse({ ...block, periodMs }).periodMs).toBe(periodMs);
  for (const periodMs of [-1, 0.5, 60001]) expect(blockSchema.safeParse({ ...block, periodMs }).success).toBe(false);
  expect(connectionSchema.parse(connection).retryDelayMs).toBeUndefined();
  for (const retryDelayMs of [0, 1, 50, 60000]) expect(connectionSchema.parse({ ...connection, retryDelayMs }).retryDelayMs).toBe(retryDelayMs);
  for (const retryDelayMs of [-1, 1.5, 60001]) expect(connectionSchema.safeParse({ ...connection, retryDelayMs }).success).toBe(false);
});

it('marks a slave offline only after three exhausted polls and restores it on an illegal-address response', async () => {
  const ctx = setup({ retries: 2, retryDelayMs: 10 });
  ctx.transport.onResponse(request => [ctx.reply(request)]);
  await ctx.runtime.start();
  expect(ctx.runtime.slaveState(slave)).toEqual({ state: 'pending', lastResponseUtc: null });
  await vi.advanceTimersByTimeAsync(4);
  const original = ctx.runtime.slaveState(slave);
  expect(original.state).toBe('online');
  expect(original.lastResponseUtc).not.toBeNull();

  ctx.transport.onResponse(() => null);
  for (let failures = 1; failures <= 3; failures++) {
    const before = ctx.transport.sent.length;
    const refresh = ctx.runtime.refresh(slave.id);
    await vi.advanceTimersByTimeAsync(125);
    expect(ctx.runtime.slaveState(slave)).toEqual(original);
    await vi.advanceTimersByTimeAsync(65);
    await refresh;
    expect(ctx.transport.sent.length - before).toBe(3);
    expect(ctx.runtime.slaveState(slave).state).toBe(failures === 3 ? 'offline' : 'online');
  }
  expect(ctx.runtime.slaveState(slave).lastResponseUtc).toBe(original.lastResponseUtc);
  expect(ctx.runtime.state).toBe('online');

  ctx.transport.onResponse(request => [buildTcpAdu((request[0]! << 8) | request[1]!, slave.unitId,
    encodeResponsePdu({ kind: 'exception', fc: 3, code: 2 }))]);
  const recovery = ctx.runtime.refresh(slave.id);
  await vi.advanceTimersByTimeAsync(5);
  await recovery;
  const recovered = ctx.runtime.slaveState(slave);
  expect(recovered.state).toBe('online');
  expect(Date.parse(recovered.lastResponseUtc!)).toBeGreaterThan(Date.parse(original.lastResponseUtc!));
  expect(ctx.cache.get('s::a')).toMatchObject({ status: 'exception', exceptionCode: 2, valid: [true] });
});

it('keeps the device online while a slow block or readable fragment can answer', async () => {
  const fast = { ...block, periodMs: 8, length: 3 };
  const slow = { ...block, id: 'slow', start: 10, periodMs: 300 };
  const ctx = setup({}, [fast, slow]);
  ctx.runtime.configure([
    { slave, block: fast, readRanges: [{ offset: 0, length: 1 }, { offset: 2, length: 1 }] },
    { slave, block: slow },
  ]);
  let dropFastFragment = false;
  ctx.transport.onResponse(request => {
    if (request[9] === 10 || (request[9] === 2 && !dropFastFragment)) return [ctx.reply(request)];
    return [buildTcpAdu((request[0]! << 8) | request[1]!, slave.unitId, encodeResponsePdu({ kind: 'exception', fc: 3, code: 11 }))];
  });
  await ctx.runtime.start();
  await vi.advanceTimersByTimeAsync(80);
  expect(ctx.runtime.slaveState(slave).state).toBe('online');
  dropFastFragment = true;
  await vi.advanceTimersByTimeAsync(120);
  expect(ctx.runtime.slaveState(slave).state).toBe('online');
  expect(ctx.cache.get('s::a')?.status).toBe('exception');
});

it('round-robins zero-period blocks even when the monotonic clock has equal timestamps', async () => {
  const ctx = setup({}, [0, 1, 2].map(start => ({ ...block, id: String(start), start, periodMs: 0 })));
  ctx.transport.onResponse(request => [ctx.reply(request)]);
  await ctx.runtime.start();
  await vi.advanceTimersByTimeAsync(12);
  const addresses = ctx.transport.sent.slice(0, 9).map(request => request[9]);
  expect(addresses).toEqual([0, 1, 2, 0, 1, 2, 0, 1, 2]);
});

it('yields between readable fragments and measures the complete block cycle period', async () => {
  const mixed = { ...block, length: 3, periodMs: 100 };
  const other = { ...block, id: 'b', start: 10, periodMs: 100 };
  const ctx = setup({}, [mixed, other]);
  ctx.runtime.configure([{ slave, block: mixed, readRanges: [{ offset: 0, length: 1 }, { offset: 2, length: 1 }] }, { slave, block: other }]);
  ctx.transport.onResponse(request => [ctx.reply(request)]);
  await ctx.runtime.start();
  await vi.advanceTimersByTimeAsync(210);
  expect(ctx.transport.sent.slice(0, 3).map(request => request[9])).toEqual([0, 10, 2]);
  const health = ctx.diagnostics.health('c', Date.now(), [{ slaveId: 's', unitId: 1, blockId: 'a', blockName: 'A', configuredPeriodMs: 100 }]);
  expect(health.blocks[0]!.actualPeriodMs).toBe(100);
  expect(ctx.diagnostics.recentTransactions(30).filter(transaction => transaction.sourceId === 'a' && transaction.pollCycleStart)).toHaveLength(3);
});

it('dispatches after a response before the five-millisecond maintenance tick', async () => {
  const ctx = setup({}, [{ ...block, periodMs: 0 }]);
  ctx.transport.onResponse(request => {
    setTimeout(() => ctx.transport.inject(ctx.reply(request)), 1);
    return null;
  });
  await ctx.runtime.start();
  await vi.advanceTimersByTimeAsync(4);
  expect(ctx.transport.sent.length).toBeGreaterThanOrEqual(2);
  expect(ctx.cache.get('s::a')?.revision).toBeGreaterThan(0);
});

it('wakes one- and five-millisecond periods from their own deadlines', async () => {
  const ctx = setup({}, [{ ...block, periodMs: 1 }, { ...block, id: 'b', start: 1, periodMs: 5 }]);
  const starts = new Map<number, number[]>([[0, []], [1, []]]);
  ctx.transport.onResponse(request => {
    starts.get(request[9]!)!.push(Date.now());
    return [ctx.reply(request)];
  });
  await ctx.runtime.start();
  await vi.advanceTimersByTimeAsync(21);
  for (const [address, times] of starts) {
    const period = address === 0 ? 1 : 5;
    expect(times.length).toBeGreaterThanOrEqual(address === 0 ? 8 : 4);
    expect(times.slice(1).every((time, index) => time - times[index]! >= period)).toBe(true);
  }
});

it.each([undefined, 0, 17])('uses connection retry delay %s and retains the legacy default', async retryDelayMs => {
  const ctx = setup({ retries: 1, retryDelayMs });
  const starts: number[] = [];
  ctx.transport.onResponse(request => {
    starts.push(Date.now());
    return starts.length === 1 ? null : [ctx.reply(request)];
  });
  await ctx.runtime.start();
  await vi.advanceTimersByTimeAsync(120);
  expect(starts).toHaveLength(2);
  const earliest = 50 + (retryDelayMs ?? 50);
  expect(starts[1]).toBeGreaterThanOrEqual(earliest);
  expect(starts[1]).toBeLessThanOrEqual(earliest + 2);
  expect(ctx.cache.get('s::a')?.status).toBe('ok');
});

it('lets other due blocks poll while one block is waiting to retry', async () => {
  const ctx = setup({ retries: 1, retryDelayMs: 30 }, [block, { ...block, id: 'b', start: 1, periodMs: 5 }]);
  const starts: Array<{ address: number; time: number }> = [];
  ctx.transport.onResponse(request => {
    const address = request[9]!;
    starts.push({ address, time: Date.now() });
    return address === 0 && starts.filter(item => item.address === 0).length === 1 ? null : [ctx.reply(request)];
  });
  await ctx.runtime.start();
  await vi.advanceTimersByTimeAsync(95);
  expect(starts.filter(item => item.address === 0)).toHaveLength(2);
  expect(starts.filter(item => item.address === 1 && item.time > 50 && item.time < 80).length).toBeGreaterThan(3);
  expect(starts.find(item => item.address === 0 && item.time > 0)?.time).toBeGreaterThanOrEqual(80);
});

it('overlaps request gap and retry delay instead of adding them', async () => {
  const ctx = setup({ retries: 1, retryDelayMs: 15, interFrameMs: 20 });
  const starts: number[] = [];
  ctx.transport.onResponse(request => {
    starts.push(Date.now());
    return starts.length === 1 ? null : [ctx.reply(request)];
  });
  await ctx.runtime.start();
  await vi.advanceTimersByTimeAsync(75);
  expect(starts).toEqual([0, 70]);
});

it('cancels a long manual retry wait on disconnect and settles the caller', async () => {
  const ctx = setup({ retries: 2, retryDelayMs: 60000 }, []);
  await ctx.runtime.start();
  const result = ctx.runtime.temporaryRead(1, 3, 0, 1);
  await vi.advanceTimersByTimeAsync(55);
  await ctx.runtime.stop();
  expect((await result).result).toBe('timeout');
  await vi.advanceTimersByTimeAsync(61000);
  expect(ctx.transport.sent).toHaveLength(1);
});

it('cancels a pending retry when the block binding changes', async () => {
  const ctx = setup({ retries: 1, retryDelayMs: 30 });
  await ctx.runtime.start();
  await vi.advanceTimersByTimeAsync(55);
  ctx.runtime.configure([{ slave, block: { ...block, start: 100 } }]);
  await vi.advanceTimersByTimeAsync(100);
  expect(ctx.transport.sent).toHaveLength(1);
  expect(ctx.cache.get('s::a')?.block.start).toBe(100);
});

it('preserves the block transport-error status when the active connection drops', async () => {
  const ctx = setup();
  await ctx.runtime.start();
  await vi.advanceTimersByTimeAsync(1);
  ctx.transport.drop();
  await vi.advanceTimersByTimeAsync(1);
  expect(ctx.cache.get('s::a')?.status).toBe('transport-error');
});

it('exhausts only the configured retries before the next regular block period', async () => {
  const ctx = setup({ retries: 2, retryDelayMs: 10 });
  await ctx.runtime.start();
  await vi.advanceTimersByTimeAsync(250);
  expect(ctx.transport.sent).toHaveLength(3);
  expect(ctx.cache.get('s::a')?.status).toBe('timeout');
});

it('cancels a long scanner retry wait and resumes queued manual reads', async () => {
  const ctx = setup({ retries: 2, retryDelayMs: 60000 }, []);
  await ctx.runtime.start();
  const scan = ctx.runtime.scanUnits({ from: 1, to: 2 }, { timeoutMs: 50 });
  await vi.advanceTimersByTimeAsync(55);
  ctx.runtime.stopScan();
  expect(await scan).toEqual([]);
  expect(ctx.runtime.scan?.phase).toBe('stopped');
  ctx.transport.onResponse(request => [ctx.reply(request)]);
  const read = ctx.runtime.temporaryRead(1, 3, 0, 1);
  await vi.advanceTimersByTimeAsync(2);
  expect((await read).result).toBe('ok');
  expect(ctx.transport.sent).toHaveLength(2);
});

it('keeps RMW and write contiguous while zero-period blocks are polling', async () => {
  const continuous = { ...block, periodMs: 0 };
  const ctx = setup({}, [continuous]);
  ctx.transport.onResponse(request => {
    const response = request[7] === 6
      ? buildTcpAdu((request[0]! << 8) | request[1]!, 1, encodeResponsePdu({
        kind: 'writeAck', fc: 6, address: 0, extra: (request[10]! << 8) | request[11]!,
      }))
      : ctx.reply(request);
    setTimeout(() => ctx.transport.inject(response), 2);
    return null;
  });
  await ctx.runtime.start();
  await vi.advanceTimersByTimeAsync(3);
  const write = ctx.runtime.writePoint({
    slave, block: continuous, pointId: 'p', rawValue: 1, readBackRange: { start: 0, length: 1 },
    mapping: { rawType: 'BitField', offset: 0, registerCount: 1, wordOrder: 'ABCD', byteSelector: 'low',
      bitOffset: 0, bitWidth: 1, stringLength: 0, stringEncoding: 'ascii' },
  });
  await vi.advanceTimersByTimeAsync(15);
  expect((await write).result).toBe('ok');
  const kinds = ctx.diagnostics.recentTransactions(100).map(transaction => transaction.sourceKind);
  const index = kinds.indexOf('rmw-read');
  expect(index).toBeGreaterThanOrEqual(0);
  expect(kinds.slice(index, index + 2)).toEqual(['rmw-read', 'write']);
  expect(kinds).not.toContain('readback');
});

it('clears a timed-out RTU partial frame and continues without a fixed twenty-millisecond wait', async () => {
  const ctx = setup({ transport: 'rtu', rtu: { port: 'test', baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1 } }, []);
  const starts: number[] = [];
  ctx.transport.onResponse(request => {
    starts.push(Date.now());
    const reply = ctx.reply(request);
    return [starts.length === 1 ? reply.subarray(0, 4) : reply];
  });
  await ctx.runtime.start();
  const first = ctx.runtime.temporaryRead(1, 3, 0, 1);
  const second = ctx.runtime.temporaryRead(1, 3, 1, 1);
  await vi.advanceTimersByTimeAsync(55);
  expect((await first).result).toBe('timeout');
  expect((await second).result).toBe('ok');
  expect(starts[1]).toBeLessThan(55);
});

it('extends only RTU transmit silence when fresh bytes arrive between requests', async () => {
  const ctx = setup({ transport: 'rtu', rtu: { port: 'test', baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1 } }, []);
  const starts: number[] = [];
  ctx.transport.onResponse(request => {
    starts.push(Date.now());
    return [ctx.reply(request)];
  });
  await ctx.runtime.start();
  const first = ctx.runtime.temporaryRead(1, 3, 0, 1);
  const second = ctx.runtime.temporaryRead(1, 3, 1, 1);
  setTimeout(() => ctx.transport.inject(new Uint8Array([0x7f])), 2);
  await vi.advanceTimersByTimeAsync(10);
  await Promise.all([first, second]);
  expect(starts[1]).toBeGreaterThanOrEqual(4);
  expect(starts[1]).toBeLessThan(10);
});
