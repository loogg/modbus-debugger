import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { workspaceSchema } from '../../src/domain/model';
import { canvasSchema, canvasWidgetSchema } from '../../src/domain/canvas';
import { BlockCache } from '../../src/main/runtime/block-cache';
import { SampleBuffers } from '../../src/main/runtime/sample-buffers';
import { withBufferConfigs } from '../../src/domain/point-buffers';
import { FakeClock } from '../support/fake';
import { createScratch } from '../../tools/test-paths.mjs';
import { sampleColumnBytes } from '../../src/shared/sample-columns';

function harness(count = 1, capacity = 10) {
  let workspace = workspaceSchema.parse({ name: 'buffers', connections: [{ id: 'c', name: 'TCP', transport: 'tcp', tcp: { host: '127.0.0.1', port: 502 } }],
    slaves: [{ id: 's', connectionId: 'c', unitId: 1, name: '设备', templateId: 't', enabled: true }],
    templates: [{ id: 't', name: '模板', blocks: [{ id: 'b', name: '块', area: 3, start: 0, length: count, periodMs: 20 }],
      points: Array.from({ length: count }, (_, index) => ({ id: `p${index}`, name: `点位 ${index}`, blockId: 'b', mapping: { rawType: 'UInt16', offset: index, registerCount: 1, wordOrder: 'ABCD', byteSelector: 'low', bitOffset: 0, bitWidth: 1, stringLength: 0, stringEncoding: 'ascii' }, access: 'rw', scale: .001 })) }],
    trendGroups: [{ id: 'g', name: '组', signals: Array.from({ length: count }, (_, index) => ({ id: `sig${index}`, pointRef: { connectionId: 'c', slaveId: 's', pointId: `p${index}` } })) }],
    sampleBuffers: Array.from({ length: count }, (_, index) => ({ slaveId: 's', pointId: `p${index}`, capacity })) });
  const cache = new BlockCache(); const clock = new FakeClock();
  const buffers = new SampleBuffers(cache, clock);
  cache.ensure(workspace.slaves[0]!, workspace.templates[0]!.blocks[0]!);
  cache.onConfirmed = entry => buffers.confirmed(entry, workspace);
  buffers.reconcile(workspace);
  return { cache, buffers, clock, get workspace() { return workspace; }, setWorkspace(next: typeof workspace) { workspace = next; buffers.reconcile(next); },
    read(afterSeq?: number, generation?: string, limit = 10000, throughSeq?: number) { return buffers.read({ slaveId: 's', pointId: 'p0', afterSeq, generation, limit, throughSeq }, 10000); },
    sample(value = 1234) { clock.advance(5); cache.applyReadResult('s::b', { kind: 'registers', fc: 3, registers: Array(count).fill(value) }, 1); } };
}

describe('confirmed sample buffers', () => {
  it('reports unavailable time ranges as the ring overwrites samples and preserves its generation on resize', () => {
    const h = harness();
    for (let index = 0; index < 25; index++) h.sample(index);
    const ref = { slaveId: 's', pointId: 'p0', limit: 2000 };
    const page = h.read();
    expect(h.buffers.read({ ...ref, startMs: 0 }, 2000).rangeStatus).toBe('partial');
    expect(h.buffers.read({ ...ref, endMs: 1 }, 2000).rangeStatus).toBe('expired');
    expect(h.read().generation).toBe(page.generation);
  });
  it('removes samples when a referenced point becomes write-only and reports its binding error', () => {
    const h = harness();
    h.sample();
    expect(h.read().samples).toHaveLength(1);
    const workspace = structuredClone(h.workspace);
    workspace.templates[0]!.points[0]!.access = 'wo';
    h.setWorkspace(workspace);
    h.sample();
    expect(h.read()).toMatchObject({ count: 0, samples: [], error: expect.stringContaining('只写点位') });
    workspace.templates[0]!.points[0]!.access = 'rw';
    h.setWorkspace({ ...workspace });
    h.sample(5);
    expect(h.read().samples).toHaveLength(1);
    expect(h.read().error).toBeUndefined();
  });
  it('retains every successful acquisition including repeats and excludes status-only changes', () => {
    const h = harness();
    h.sample(); h.sample(); h.cache.markError('s::b', 'timeout'); h.sample();
    const page = h.read();
    expect(page.samples.map(sample => [sample.seq, sample.monoMs, sample.value])).toEqual([[1, 5, 1.234], [2, 10, 1.234], [3, 15, 1.234]]);
    expect(page.samples.every(sample => Number.isFinite(sample.timeMs))).toBe(true);
    expect(h.read().samples).toEqual(page.samples);
  });
  it('keeps bounded capacity and detects overwritten cursors across paginated reads', () => {
    const h = harness();
    for (let index = 0; index < 25; index++) h.sample(index);
    const first = h.read(2, undefined, 3);
    expect(first).toMatchObject({ count: 10, firstSeq: 16, lastSeq: 25, gap: true, nextSeq: 18, hasMore: true });
    expect(h.read(18, first.generation, 20, first.throughSeq).samples.map(row => row.seq)).toEqual([19, 20, 21, 22, 23, 24, 25]);
    for (let index = 0; index < 25; index++) h.sample(index);
    const recovered = h.read(18, first.generation, 20, first.throughSeq);
    expect(recovered).toMatchObject({ gap: true, firstSeq: 41, nextSeq: 50, hasMore: false });
  });
  it('shares one ring across consumers, resizes in place and isolates device instances', () => {
    const h = harness(1, 20);
    const ref = { slaveId: 's', pointId: 'p0' };
    h.setWorkspace({ ...h.workspace, canvases: [canvasSchema.parse({ id: 'canvas', name: '面板', widgets: [canvasWidgetSchema.parse({ id: 'curve', kind: 'trend', label: '曲线', x: 0, y: 0, width: 300, height: 180, binding: ref })] })], slaves: [...h.workspace.slaves, { ...h.workspace.slaves[0]!, id: 's2', unitId: 2 }] });
    h.buffers.setDemand('second', [{ slaveId: 's2', pointId: 'p0' }], h.workspace);
    h.cache.ensure(h.workspace.slaves[1]!, h.workspace.templates[0]!.blocks[0]!);
    for (let index = 0; index < 20; index++) h.sample(index);
    const generation = h.read().generation;
    expect(h.buffers.info(ref).references).toHaveLength(2);
    expect(h.buffers.info({ slaveId: 's2', pointId: 'p0' }).count).toBe(0);
    h.setWorkspace(withBufferConfigs(h.workspace, [{ ...ref, capacity: 10 }]));
    expect(h.read()).toMatchObject({ generation, count: 10, firstSeq: 11, lastSeq: 20 });
    expect(h.workspace.sampleBuffers![0]!.capacity).toBe(10);
  });
  it('resets the sample generation on mapping changes and preserves it for metadata edits', () => {
    const h = harness(); h.sample();
    const old = h.read();
    h.setWorkspace({ ...h.workspace, name: 'renamed' });
    expect(h.read().generation).toBe(old.generation);
    h.setWorkspace({ ...h.workspace, templates: h.workspace.templates.map(template => ({ ...template, points: template.points.map(point => ({ ...point, scale: 1 })) })) });
    h.sample();
    expect(h.read(old.lastSeq, old.generation)).toMatchObject({ reset: true, count: 1, nextSeq: 1 });
    expect(h.read().samples[0]!.value).toBe(1234);
  });
  it('exports stable raw values, timestamps and sequences to an isolated CSV file', async () => {
    const h = harness(); h.sample(1234); h.sample(5678);
    const output = path.join(createScratch('buffer-export-'), 'samples.csv');
    const result = await h.buffers.exportCsv([{ slaveId: 's', pointId: 'p0' }], output);
    const content = fs.readFileSync(output, 'utf8');
    expect(result.count).toBe(2);
    expect(content).toContain('时间UTC'); expect(content).toContain('"1.234"'); expect(content).toContain('"5.678"');
    expect(content).toMatch(/T\d\d:\d\d:\d\d\.\d{3}Z/);
    expect(content.trim().split('\n')).toHaveLength(3);
    await expect(h.buffers.exportCsv([{ slaveId: 's', pointId: 'p0' }], output, 2, 1)).rejects.toThrow('起止时间');
  });
  it('exports only confirmed samples inside the requested inclusive time bounds', async () => {
    const h = harness();
    let time = Date.parse('2026-11-12T08:00:00.100Z');
    h.cache.onConfirmed = entry => { entry.lastUpdateUtc = new Date(time).toISOString(); h.buffers.confirmed(entry, h.workspace); };
    h.sample(1000); time += 500; h.sample(2000); time += 500; h.sample(3000);
    const output = path.join(createScratch('buffer-range-'), 'range.csv');
    const result = await h.buffers.exportCsv([{ slaveId: 's', pointId: 'p0' }], output, time - 500, time - 500);
    expect(result.count).toBe(1);
    const rows = fs.readFileSync(output, 'utf8').trim().split('\n');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('2026-11-12T08:00:00.600Z');
    expect(rows[1]).toMatch(/,"2","2"\r?$/);
  });
  it('stores 50 signals at a 5 ms confirmed cadence independently of a 100 ms consumer', () => {
    const h = harness(50, 10000);
    let collected = 0; let cursor = 0; let generation: string | undefined;
    for (let index = 1; index <= 2000; index++) {
      h.sample(index);
      if (index % 20 === 0) {
        const page = h.read(cursor, generation);
        collected += page.samples.length; cursor = page.nextSeq; generation = page.generation;
      }
    }
    expect(collected).toBe(2000);
    expect(h.buffers.info({ slaveId: 's', pointId: 'p49' }).count).toBe(2000);
    expect(h.read().samples.at(-1)!.monoMs).toBe(10000);
  });
  it('allows an oversized imported configuration to be reduced incrementally', () => {
    const h = harness(21, 100000);
    const decreased = withBufferConfigs(h.workspace, [{ slaveId: 's', pointId: 'p0', capacity: 90000 }]);
    expect(decreased.sampleBuffers![0]!.capacity).toBe(90000);
    expect(() => withBufferConfigs(decreased, [{ slaveId: 's', pointId: 'p0', capacity: 95000 }])).toThrow('总容量');
  });
  it('loads only the visible UTC window and paginates exact numeric columns by bytes', () => {
    const h = harness(1, 10000);
    const base = Date.parse('2026-11-16T08:00:00.000Z');
    let tick = 0;
    h.cache.onConfirmed = entry => { entry.lastUpdateUtc = new Date(base + tick++ * 5).toISOString(); h.buffers.confirmed(entry, h.workspace); };
    for (let index = 0; index < 10000; index++) h.sample(index);
    const ref = { slaveId: 's', pointId: 'p0', startMs: base + 49500, limit: 10000 };
    const first = h.buffers.readColumns(ref, 10000, 240);
    expect(first.columns.times).toHaveLength(10);
    expect(Array.from(first.columns.sequences)).toEqual(Array.from({ length: 10 }, (_, index) => 9901 + index));
    expect(first).toMatchObject({ count: 10000, nextSeq: 9910, throughSeq: 10000, hasMore: true, metadata: { capacity: 10000 } });
    const next = h.buffers.readColumns({ ...ref, generation: first.generation, metadataVersion: first.metadataVersion, afterSeq: first.nextSeq, throughSeq: first.throughSeq }, 10000, 2400);
    expect(next.columns.values).toHaveLength(90);
    expect(next).toMatchObject({ nextSeq: 10000, hasMore: false });
    expect(next.metadata).toBeUndefined();
    h.setWorkspace(withBufferConfigs(h.workspace, [{ slaveId: 's', pointId: 'p0', capacity: 5000 }]));
    const resized = h.buffers.readColumns({ ...ref, metadataVersion: first.metadataVersion, afterSeq: next.nextSeq }, 10000, 2400);
    expect(resized.generation).toBe(first.generation);
    expect(resized.metadataVersion).not.toBe(first.metadataVersion);
    expect(resized.metadata?.capacity).toBe(5000);
  });
  it('keeps UTC rollback samples and non-contiguous real sequence numbers in filtered columns', () => {
    const h = harness();
    const times = [1000, 1005, 900, 1010];
    let tick = 0;
    h.cache.onConfirmed = entry => { entry.lastUpdateUtc = new Date(times[tick++]!).toISOString(); h.buffers.confirmed(entry, h.workspace); };
    times.forEach(() => h.sample());
    const page = h.buffers.readColumns({ slaveId: 's', pointId: 'p0', startMs: 1000, endMs: 1005, limit: 100 }, 100, 2400);
    expect(Array.from(page.columns.times)).toEqual([1000, 1005]);
    expect(Array.from(page.columns.sequences)).toEqual([1, 2]);
    expect(page.nextSeq).toBe(4);
    const next = h.buffers.readColumns({ slaveId: 's', pointId: 'p0', startMs: 900, endMs: 1000, limit: 100 }, 100, 2400);
    expect(Array.from(next.columns.sequences)).toEqual([1, 3]);
    expect(Array.from(next.columns.times)).toEqual([1000, 900]);
  });
  it('budgets escaped String samples and allows one sample to use the remaining fair-share budget', () => {
    const h = harness();
    h.setWorkspace({ ...h.workspace, templates: h.workspace.templates.map(template => ({ ...template,
      blocks: template.blocks.map(block => ({ ...block, length: 123 })),
      points: template.points.map(point => ({ ...point, mapping: { ...point.mapping, rawType: 'String', registerCount: 123, stringLength: 246 } })) })) });
    h.cache.ensure(h.workspace.slaves[0]!, h.workspace.templates[0]!.blocks[0]!);
    for (let index = 0; index < 20; index++) h.cache.applyReadResult('s::b', { kind: 'registers', fc: 3, registers: Array(123).fill(0x2222) }, 1);
    const ref = { slaveId: 's', pointId: 'p0', limit: 100 };
    const first = h.buffers.readColumns(ref, 100, 4096);
    expect(first.columns.kind).toBe('string');
    expect(first.columns.values).toHaveLength(8);
    expect(first.columns.values[0]).toBe('"'.repeat(246));
    expect(sampleColumnBytes(first.columns)).toBeLessThanOrEqual(4096);
    const fair = h.buffers.readColumns(ref, 100, 100, 4096);
    expect(fair.columns.values).toHaveLength(1);
    expect(fair.nextSeq).toBe(fair.firstSeq);
    const exhausted = h.buffers.readColumns(ref, 100, 0, 0);
    expect(exhausted.nextSeq).toBe(exhausted.firstSeq - 1);
    expect(exhausted.hasMore).toBe(true);
  });
  it('versions standalone buffer status metadata as well as curve pages', () => {
    const h = harness(); h.sample();
    const ref = { slaveId: 's', pointId: 'p0' };
    const first = h.buffers.infoColumns(ref);
    h.sample();
    const second = h.buffers.infoColumns({ ...ref, metadataVersion: first.metadataVersion });
    expect(second.metadata).toBeUndefined();
    expect(second.count).toBe(2);
    h.setWorkspace(withBufferConfigs(h.workspace, [{ ...ref, capacity: 20 }]));
    const changed = h.buffers.infoColumns({ ...ref, metadataVersion: first.metadataVersion });
    expect(changed.metadata?.capacity).toBe(20);
    expect(changed.generation).toBe(first.generation);
  });
});
