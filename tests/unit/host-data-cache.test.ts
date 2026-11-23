import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FrontendDataCache, type HostValues } from '../../src/renderer/store/data-cache';
import type { ModbusApi } from '../../src/shared/preload-api';
import type { ColumnDataReadResult, DataReadRequest, DataReadResult, PointSample } from '../../src/shared/point-data';
import { sampleColumns, sampleColumnBytes } from '../../src/shared/sample-columns';
import type { Command, CommandResult } from '../../src/shared/commands';

const ref = { slaveId: 's', pointId: 'p' };
const result = (value = 1): DataReadResult => ({ checkedAtMs: Date.now(), points: { 's::p': { ...ref, rawText: String(value), engText: String(value), finite: true, hasValue: true, rawNumber: value, engNumber: value, boolValue: null, stringValue: null, enumLabel: null } }, blocks: {}, series: {}, buffers: {} });
const clients: FrontendDataCache[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { clients.forEach(client => client.dispose()); clients.length = 0; vi.useRealTimers(); });
function client(handler?: (command: Command) => Promise<CommandResult<unknown>>) {
  const calls = vi.fn(async (command: Command): Promise<CommandResult<unknown>> => handler ? handler(command) : { ok: true, value: command.type === 'data.read' ? result(Date.now()) : null });
  const cache = new FrontendDataCache({ command: calls } as unknown as ModbusApi, () => Date.now());
  clients.push(cache);
  return { cache, calls, reads: () => calls.mock.calls.map(call => call[0]).filter(command => command.type === 'data.read') };
}

it('shares fresh values while publishing independently at 100 and 500 ms', async () => {
  const h = client(); const fast = vi.fn(); const slow = vi.fn();
  h.cache.register('a', { points: [ref], intervalMs: 100, active: true }, fast);
  h.cache.register('b', { points: [ref], intervalMs: 500, active: true }, slow);
  await vi.advanceTimersByTimeAsync(1005);
  expect(h.reads().length).toBeLessThanOrEqual(11);
  expect(h.reads().every(command => command.points.length === 1)).toBe(true);
  expect(fast).toHaveBeenCalledTimes(11);
  expect(slow).toHaveBeenCalledTimes(3);
  expect(slow.mock.calls[1]![0].points['s::p'].engNumber).toBe(fast.mock.calls[5]![0].points['s::p'].engNumber);
});

it('coalesces concurrent demand and does not queue overlapping requests for a slow response', async () => {
  let resolve: ((value: CommandResult<unknown>) => void) | undefined;
  const h = client(async command => command.type === 'data.read' ? new Promise(done => { resolve = done; }) : { ok: true, value: null });
  const a = vi.fn(); const b = vi.fn();
  h.cache.register('a', { points: [ref], intervalMs: 100, active: true }, a);
  h.cache.register('b', { points: [ref], intervalMs: 100, active: true }, b);
  await vi.advanceTimersByTimeAsync(500);
  expect(h.reads()).toHaveLength(1);
  expect(a).not.toHaveBeenCalled();
  resolve!({ ok: true, value: result(42) });
  await vi.advanceTimersByTimeAsync(0);
  expect(a.mock.calls[0]![0].points['s::p'].engNumber).toBe(42);
  expect(b.mock.calls[0]![0].points['s::p'].engNumber).toBe(42);
});

it('pauses hidden hosts and reads the latest data when they become visible', async () => {
  const h = client(); const render = vi.fn();
  const release = h.cache.register('view', { points: [ref], intervalMs: 100, active: false }, render);
  await vi.advanceTimersByTimeAsync(1000);
  expect(h.reads()).toHaveLength(0);
  release();
  h.cache.register('view', { points: [ref], intervalMs: 100, active: true }, render);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.reads()).toHaveLength(1);
  expect(render).toHaveBeenCalledTimes(1);
});

it('drops an old in-flight reply after cache invalidation', async () => {
  let resolve: ((value: CommandResult<unknown>) => void) | undefined;
  let first = true;
  const h = client(async command => {
    if (command.type !== 'data.read') return { ok: true, value: null };
    if (first) { first = false; return new Promise(done => { resolve = done; }); }
    return { ok: true, value: result(9) };
  });
  const delivered: HostValues[] = [];
  h.cache.register('view', { points: [ref], intervalMs: 100, active: true }, value => delivered.push(value));
  await vi.advanceTimersByTimeAsync(1);
  h.cache.invalidate();
  resolve!({ ok: true, value: result(123) });
  await vi.advanceTimersByTimeAsync(10);
  expect(delivered.every(value => value.points['s::p']?.engNumber !== 123)).toBe(true);
  expect(delivered.at(-1)!.points['s::p']!.engNumber).toBe(9);
});

it('retries a failed read with bounded backoff and reports the failure to the host', async () => {
  let fail = true;
  const h = client(async command => command.type !== 'data.read' ? { ok: true, value: null } : fail ? { ok: false, error: '断开' } : { ok: true, value: result(12) });
  const render = vi.fn();
  h.cache.register('view', { points: [ref], intervalMs: 100, active: true }, render);
  await vi.advanceTimersByTimeAsync(900);
  expect(h.reads()).toHaveLength(1);
  expect(render.mock.calls[0]![0].error).toBe('断开');
  fail = false;
  await vi.advanceTimersByTimeAsync(110);
  expect(render.mock.calls.at(-1)![0].points['s::p'].engNumber).toBe(12);
  expect(render.mock.calls.at(-1)![0].error).toBeNull();
});

function seriesResponse(request: DataReadRequest, rows: PointSample[], pageSize = 2000, generation = 'g'): ColumnDataReadResult {
  const response: ColumnDataReadResult = { ...result(), format: 'columns-v1', sampleBytes: 0, series: {}, buffers: {} };
  for (const query of request.series) {
    const reset = query.generation !== undefined && query.generation !== generation;
    const after = reset ? 0 : query.afterSeq ?? 0;
    const throughSeq = reset ? rows.at(-1)?.seq ?? 0 : query.throughSeq ?? rows.at(-1)?.seq ?? 0;
    const matches = rows.filter(row => row.seq > after && row.seq <= throughSeq && row.timeMs >= (query.startMs ?? -Infinity) && row.timeMs <= (query.endMs ?? Infinity));
    const samples = matches.slice(0, pageSize);
    const columns = sampleColumns(samples);
    const hasMore = matches.length > samples.length;
    const metadataVersion = `${generation}-meta`;
    response.series[query.queryId ?? `${query.slaveId}::${query.pointId}`] = { generation, columns, metadataVersion,
      ...(query.metadataVersion === metadataVersion ? {} : { metadata: { capacity: 100000, references: ['趋势'] } }),
      count: rows.length, firstSeq: rows[0]?.seq ?? 1, lastSeq: rows.at(-1)?.seq ?? 0,
      firstTimeMs: rows[0]?.timeMs ?? null, lastTimeMs: rows.at(-1)?.timeMs ?? null,
      nextSeq: hasMore ? samples.at(-1)!.seq : throughSeq, throughSeq, hasMore, gap: false, reset };
    response.sampleBytes += sampleColumnBytes(columns);
  }
  return response;
}

it('queries disjoint Host windows independently and projects only each requested window', async () => {
  const base = Date.now();
  const rows = Array.from({ length: 651 }, (_, index) => ({ seq: index + 1, timeMs: base - 65000 + index * 100, monoMs: index, value: index }));
  const h = client(async command => ({ ok: true, value: command.type === 'data.read' ? seriesResponse(command, rows) : null }));
  const live = vi.fn(); const paused = vi.fn();
  h.cache.register('live', { points: [], series: [{ ...ref, windowMs: 5000 }], intervalMs: 100, active: true }, live);
  h.cache.register('paused', { points: [], series: [{ ...ref, windowMs: 5000, endMs: base - 60000 }], intervalMs: 100, active: true }, paused);
  await vi.advanceTimersByTimeAsync(1);
  const queries = h.reads()[0]!.series;
  expect(queries).toHaveLength(2);
  expect(new Set(queries.map(query => query.queryId)).size).toBe(2);
  expect(queries.map(query => (query.endMs ?? base) - query.startMs!)).toEqual([5000, 5000]);
  expect(live.mock.calls.at(-1)![0].series['s::p'].data.samples.every((row: number[]) => row[0]! >= base - 5000)).toBe(true);
  expect(paused.mock.calls.at(-1)![0].series['s::p'].data.samples.every((row: number[]) => row[0]! <= base - 60000)).toBe(true);
});

it('discards a late page after the Host changes its requested time range', async () => {
  const base = Date.now();
  const rows = Array.from({ length: 100 }, (_, index) => ({ seq: index + 1, timeMs: base - 9900 + index * 100, monoMs: index, value: index }));
  let finish: ((value: CommandResult<unknown>) => void) | undefined;
  let pending: DataReadRequest | undefined;
  const h = client(async command => {
    if (command.type !== 'data.read') return { ok: true, value: null };
    if (!pending) { pending = command; return new Promise(resolve => { finish = resolve; }); }
    return { ok: true, value: seriesResponse(command, rows) };
  });
  const render = vi.fn();
  const release = h.cache.register('view', { points: [], series: [{ ...ref, windowMs: 9000 }], intervalMs: 100, active: true }, render);
  await vi.advanceTimersByTimeAsync(1);
  release();
  h.cache.register('view', { points: [], series: [{ ...ref, windowMs: 1000 }], intervalMs: 100, active: true }, render);
  finish!({ ok: true, value: seriesResponse(pending!, rows) });
  await vi.advanceTimersByTimeAsync(110);
  const samples = render.mock.calls.at(-1)![0].series['s::p'].data.samples;
  expect(samples.every((row: number[]) => row[0]! >= base - 1000)).toBe(true);
});

it('loads the visible window, backfills an expanded shared window and keeps Host display arrays independent', async () => {
  const base = Date.now();
  const rows = Array.from({ length: 100 }, (_, index) => ({ seq: index + 1, timeMs: base - 9900 + index * 100, monoMs: index * 100, value: index }));
  const h = client(async command => ({ ok: true, value: command.type === 'data.read' ? seriesResponse(command, rows) : null }));
  const fast = vi.fn(); const slow = vi.fn();
  h.cache.register('fast', { points: [ref], series: [{ ...ref, windowMs: 1000 }], intervalMs: 100, active: true }, fast);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.reads()[0]!.series[0]!.startMs).toBe(base - 1000);
  expect(fast.mock.calls[0]![0].series['s::p'].data.samples).toHaveLength(11);
  h.cache.register('slow', { points: [ref], series: [{ ...ref, windowMs: 5000 }], intervalMs: 500, active: true }, slow);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.reads()[1]!.series[0]!.afterSeq).toBeUndefined();
  const slowData = slow.mock.calls[0]![0].series['s::p'].data.samples;
  expect(slowData.length).toBeGreaterThanOrEqual(50);
  const length = slowData.length;
  rows.push({ seq: 101, timeMs: base + 50, monoMs: 10050, value: 100 });
  await vi.advanceTimersByTimeAsync(210);
  expect(h.reads().at(-1)!.series[0]!.afterSeq).toBe(100);
  expect(slowData).toHaveLength(length);
  expect(fast.mock.calls.at(-1)![0].series['s::p'].data.samples.at(-1)[2]).toBe(101);
  expect(h.reads().at(-1)!.buffers).toEqual([]);
});

it('continues a bounded snapshot before reading acquisitions that arrived during pagination', async () => {
  const base = Date.now();
  const rows = Array.from({ length: 8 }, (_, index) => ({ seq: index + 1, timeMs: base - 50 + index * 5, monoMs: index * 5, value: index }));
  let first = true;
  const h = client(async command => {
    if (command.type !== 'data.read') return { ok: true, value: null };
    const response = seriesResponse(command, rows, 3);
    if (first) { first = false; rows.push({ seq: 9, timeMs: base, monoMs: 45, value: 9 }); }
    return { ok: true, value: response };
  });
  const render = vi.fn();
  h.cache.register('curve', { points: [], series: [{ ...ref, windowMs: 1000 }], intervalMs: 100, active: true }, render);
  await vi.advanceTimersByTimeAsync(20);
  expect(h.reads().slice(1).every(read => read.series[0]!.throughSeq === 8)).toBe(true);
  await vi.advanceTimersByTimeAsync(100);
  const samples = render.mock.calls.at(-1)![0].series['s::p'].data.samples;
  expect(samples.map((row: number[]) => row[2])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(h.reads().at(-1)!.series[0]!.throughSeq).toBeUndefined();
});

it('refetches the window after a fixed-end inspection and clears data on generation reset', async () => {
  const base = Date.now();
  let generation = 'old';
  let rows = Array.from({ length: 5 }, (_, index) => ({ seq: index + 1, timeMs: base - 400 + index * 100, monoMs: index * 100, value: index }));
  const h = client(async command => ({ ok: true, value: command.type === 'data.read' ? seriesResponse(command, rows, 2000, generation) : null }));
  const render = vi.fn();
  const release = h.cache.register('fixed', { points: [], series: [{ ...ref, windowMs: 1000, endMs: base - 200 }], intervalMs: 100, active: true }, render);
  await vi.advanceTimersByTimeAsync(1);
  expect(render.mock.calls.at(-1)![0].series['s::p'].data.samples).toHaveLength(3);
  release();
  h.cache.register('follow', { points: [], series: [{ ...ref, windowMs: 1000 }], intervalMs: 100, active: true }, render);
  await vi.advanceTimersByTimeAsync(1);
  expect(render.mock.calls.at(-1)![0].series['s::p'].data.samples).toHaveLength(5);
  expect(h.reads().at(-1)!.series[0]!.afterSeq).toBeUndefined();
  generation = 'new'; rows = [{ seq: 1, timeMs: base + 20, monoMs: 500, value: 99 }];
  await vi.advanceTimersByTimeAsync(101);
  expect(render.mock.calls.at(-1)![0].series['s::p'].data.samples).toEqual([[base + 20, 99, 1]]);
});

it('batches fifty curves with fifty scalar controls and enables demands only for curves', async () => {
  const refs = Array.from({ length: 50 }, (_, index) => ({ slaveId: 's', pointId: `curve-${index}` }));
  const scalars = Array.from({ length: 50 }, (_, index) => ({ slaveId: 's', pointId: `value-${index}` }));
  const rows = [{ seq: 1, timeMs: Date.now(), monoMs: 1, value: 1 }];
  const h = client(async command => ({ ok: true, value: command.type === 'data.read' ? seriesResponse(command, rows) : null }));
  const render = vi.fn();
  h.cache.register('panel', { points: scalars, series: refs, buffers: refs, intervalMs: 100, active: true }, render);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.reads()).toHaveLength(2);
  expect(h.reads().map(read => read.series.length)).toEqual([32, 18]);
  expect(h.reads().flatMap(read => read.points)).toEqual(scalars);
  expect(h.reads().every(read => read.buffers.length === 0)).toBe(true);
  const demand = h.calls.mock.calls.map(call => call[0]).find(command => command.type === 'data.demand');
  expect(demand).toMatchObject({ points: refs });
  expect(Object.keys(render.mock.calls[0]![0].series)).toHaveLength(50);
  expect(h.cache.metrics.sampleBytes).toBe(1200);
});

it('drops overwritten samples and applies changed metadata without replacing the generation', async () => {
  const base = Date.now();
  let rows = [{ seq: 1, timeMs: base, monoMs: 1, value: 1 }];
  let overwritten = false;
  const h = client(async command => {
    if (command.type !== 'data.read') return { ok: true, value: null };
    const response = seriesResponse(command, rows);
    if (overwritten) Object.assign(Object.values(response.series)[0]!, { gap: true, metadataVersion: 'resized', metadata: { capacity: 10, references: ['画布'] } });
    return { ok: true, value: response };
  });
  const render = vi.fn();
  h.cache.register('curve', { points: [], series: [ref], intervalMs: 100, active: true }, render);
  await vi.advanceTimersByTimeAsync(1);
  overwritten = true; rows = [{ seq: 20, timeMs: base + 50, monoMs: 50, value: 99 }];
  await vi.advanceTimersByTimeAsync(101);
  const series = render.mock.calls.at(-1)![0].series['s::p'];
  expect(series).toMatchObject({ generation: 'g', gap: true, capacity: 10, references: ['画布'] });
  expect(series.data.samples).toEqual([[base + 50, 99, 20]]);
  expect(render.mock.calls.at(-1)![0].buffers['s::p'].capacity).toBe(10);
});

it('reuses standalone buffer metadata while refreshing current counts', async () => {
  let count = 1;
  const h = client(async command => {
    if (command.type !== 'data.read') return { ok: true, value: null };
    const response = seriesResponse(command, []);
    response.buffers['s::p'] = { generation: 'g', metadataVersion: 'm', count, firstSeq: 1, lastSeq: count, firstTimeMs: 1, lastTimeMs: count,
      ...(command.buffers[0]?.metadataVersion === 'm' ? {} : { metadata: { capacity: 1000, references: ['趋势'] } }) };
    return { ok: true, value: response };
  });
  const render = vi.fn();
  h.cache.register('list', { points: [], buffers: [ref], intervalMs: 100, active: true }, render);
  await vi.advanceTimersByTimeAsync(1);
  count = 2;
  await vi.advanceTimersByTimeAsync(101);
  expect(h.reads()[1]!.buffers[0]?.metadataVersion).toBe('m');
  expect(render.mock.calls.at(-1)![0].buffers['s::p']).toMatchObject({ count: 2, capacity: 1000, references: ['趋势'] });
});
