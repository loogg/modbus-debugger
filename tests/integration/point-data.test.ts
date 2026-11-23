import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { RuntimeManager } from '../../src/main/runtime/manager';
import { WorkspaceService } from '../../src/main/services/workspace';
import { HistoryStore } from '../../src/main/services/history';
import { templateWorkspace } from '../support/template-workspace';
import { FakeTransport } from '../support/fake';
import { createScratch } from '../../tools/test-paths.mjs';
import { commandSchema } from '../../src/shared/commands';
import { migrateWorkspace } from '../../src/domain/model';
import type { ColumnDataReadResult, DataReadResult } from '../../src/shared/point-data';
import { sampleColumnBytes } from '../../src/shared/sample-columns';
import type { AppDelta } from '../../src/shared/snapshot';
import { validateBridgeCommand } from '../../src/main/services/dev-bridge-access';

async function harness() {
  const root = createScratch('point-data-');
  const workspace = new WorkspaceService(root);
  workspace.adopt(templateWorkspace(), null);
  const history = await HistoryStore.open(path.join(root, 'history.db'));
  const manager = new RuntimeManager(workspace, history, { transportFactory: () => new FakeTransport('tcp') });
  manager.start();
  const read = async (extra = {}) => {
    const result = await manager.handleCommand(commandSchema.parse({ type: 'data.read', points: [{ slaveId: 's1', pointId: 'Keep' }], series: [{ slaveId: 's1', pointId: 'Keep' }], ...extra }));
    if (!result.ok) throw new Error(result.error);
    return result.value as DataReadResult;
  };
  return { root, workspace, manager, read };
}

it('serves explicit latest values and every confirmed sample while routine deltas contain status only', async () => {
  const h = await harness(); const deltas: AppDelta[] = [];
  h.manager.onDelta = delta => deltas.push(delta);
  try {
    for (let index = 0; index < 20; index++) h.manager.cache.applyReadResult('s1::b2', { kind: 'registers', fc: 3, registers: [index, 0, 0, 0] }, 1);
    h.manager.cache.markError('s1::b2', 'timeout');
    const data = await h.read();
    expect(data.points['s1::Keep']?.engNumber).toBe(19);
    expect(data.series['s1::Keep']!.samples.map(row => row.value)).toEqual(Array.from({ length: 20 }, (_, index) => index));
    expect(data.blocks['s1::b2']?.status).toBe('timeout');
    expect(data.blocks['s1::b2']?.registers).toBeUndefined();
    const memory = await h.read({ blocks: [{ slaveId: 's1', blockId: 'b2' }] });
    expect(memory.blocks['s1::b2']?.registers).toEqual([19, 0, 0, 0]);
    await new Promise(resolve => setTimeout(resolve, 130));
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.every(delta => delta.points === undefined)).toBe(true);
    expect(deltas.flatMap(delta => Object.values(delta.blocks ?? {})).every(block => !block.registers && !block.bits)).toBe(true);
  } finally { await h.manager.stop(); }
});

it('correlates disjoint queries of one point without allocating additional sample buffers', async () => {
  const h = await harness();
  try {
    for (let index = 0; index < 5; index++) h.manager.cache.applyReadResult('s1::b2', { kind: 'registers', fc: 3, registers: [index, 0, 0, 0] }, 1);
    const result = await h.manager.handleCommand(commandSchema.parse({ type: 'data.read', format: 'columns-v1', series: [
      { slaveId: 's1', pointId: 'Keep', queryId: 'past', endMs: 1 },
      { slaveId: 's1', pointId: 'Keep', queryId: 'live', startMs: 1 },
    ] }));
    if (!result.ok) throw new Error(result.error);
    const data = result.value as ColumnDataReadResult;
    expect(data.series.past!.columns.values).toHaveLength(0);
    const columns = data.series.live!.columns;
    if (columns.kind !== 'number') throw new Error('Expected numeric samples');
    expect(Array.from(columns.values)).toEqual([0, 1, 2, 3, 4]);
    expect(data.series.live!.generation).toBe(data.series.past!.generation);
    expect(h.manager.sampleBuffers.info({ slaveId: 's1', pointId: 'Keep' }).count).toBe(5);
  } finally { await h.manager.stop(); }
});

it('persists shared instance capacity through workspace export and rejects stale changes', async () => {
  const h = await harness();
  try {
    const runtime = h.manager.runtimeFor('c1');
    for (let index = 0; index < 30; index++) h.manager.cache.applyReadResult('s1::b2', { kind: 'registers', fc: 3, registers: [index, 0, 0, 0] }, 1);
    const generation = (await h.read()).series['s1::Keep']!.generation;
    const updated = await h.manager.handleCommand({ type: 'buffer.configure', config: { slaveId: 's1', pointId: 'Keep', capacity: 10 }, expectedCapacity: 10000 });
    expect(updated.ok).toBe(true);
    expect(h.manager.runtimeFor('c1')).toBe(runtime);
    const data = await h.read();
    expect(data.series['s1::Keep']).toMatchObject({ generation, count: 10, firstSeq: 21, lastSeq: 30 });
    const stale = await h.manager.handleCommand({ type: 'buffer.configure', config: { slaveId: 's1', pointId: 'Keep', capacity: 20 }, expectedCapacity: 10000 });
    expect(stale.ok).toBe(false);
    const exported = await h.manager.handleCommand({ type: 'workspace.export' });
    if (!exported.ok) throw new Error(exported.error);
    const restored = migrateWorkspace(JSON.parse(exported.value as string));
    expect(restored.sampleBuffers).toEqual([{ slaveId: 's1', pointId: 'Keep', capacity: 10 }]);
    const output = path.join(h.root, 'confirmed.csv');
    const exportedData = await h.manager.handleCommand({ type: 'buffer.export', points: [{ slaveId: 's1', pointId: 'Keep' }], path: output });
    expect(exportedData.ok).toBe(true);
    expect(fs.readFileSync(output, 'utf8').trim().split('\n')).toHaveLength(11);
  } finally { await h.manager.stop(); }
});

it('allows bounded data reads through Bridge and confines exports to review roots', async () => {
  const h = await harness();
  try {
    expect(validateBridgeCommand({ type: 'data.read', points: [{ slaveId: 's1', pointId: 'Keep' }] }, [h.root], h.manager).type).toBe('data.read');
    expect(() => validateBridgeCommand({ type: 'buffer.export', points: [{ slaveId: 's1', pointId: 'Keep' }], path: path.resolve(h.root, '..', 'outside.csv') }, [h.root], h.manager)).toThrow('当前审查数据目录');
    expect(commandSchema.safeParse({ type: 'buffer.configure', config: { slaveId: 's1', pointId: 'Keep', capacity: 1e9 } }).success).toBe(false);
  } finally { await h.manager.stop(); }
});

it('batches scalar values with byte-bounded numeric samples and versioned buffer metadata', async () => {
  const h = await harness();
  try {
    for (let index = 0; index < 500; index++) h.manager.cache.applyReadResult('s1::b2', { kind: 'registers', fc: 3, registers: [index, 0, 0, 0] }, 1);
    const ref = { slaveId: 's1', pointId: 'Keep' };
    const first = await h.read({ format: 'columns-v1', sampleBytes: 4096, series: [{ ...ref, limit: 10000 }] }) as unknown as ColumnDataReadResult;
    const page = first.series['s1::Keep']!;
    expect(first.points['s1::Keep']?.engNumber).toBe(499);
    expect(page.columns.values).toBeInstanceOf(Float64Array);
    expect(page.columns.times).toHaveLength(170);
    expect(first.sampleBytes).toBe(4080);
    expect(first.sampleBytes).toBe(sampleColumnBytes(page.columns));
    expect(page).toMatchObject({ nextSeq: 170, throughSeq: 500, hasMore: true });
    const second = await h.read({ format: 'columns-v1', sampleBytes: 4096, series: [{ ...ref, generation: page.generation, metadataVersion: page.metadataVersion, afterSeq: page.nextSeq, throughSeq: page.throughSeq, limit: 10000 }] }) as unknown as ColumnDataReadResult;
    expect(second.series['s1::Keep']!.metadata).toBeUndefined();
    expect(Array.from(second.series['s1::Keep']!.columns.sequences)).toEqual(Array.from({ length: 170 }, (_, index) => 171 + index));
    expect(commandSchema.safeParse({ type: 'data.read', sampleBytes: 1e9 }).success).toBe(false);
  } finally { await h.manager.stop(); }
});
