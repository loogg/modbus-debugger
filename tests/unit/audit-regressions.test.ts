import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { workspaceSchema, type BlockDef, type SlaveDef } from '../../src/domain/model';
import { copyTemplate } from '../../src/domain/template-copy';
import { buildImportPlan, type RegisterImportRow } from '../../src/domain/import-plan';
import { BlockCache } from '../../src/main/runtime/block-cache';
import { SerialTransport, type SerialPortLike } from '../../src/main/runtime/transport';

const fixture = () => workspaceSchema.parse(JSON.parse(fs.readFileSync('tools/e2e/demo.workspace.json', 'utf8')));
const row = (address: number, type = 'UInt16'): RegisterImportRow => ({ address, type, name: `p${address}`, access: 'rw', unit: '', scale: '', offset: '' });
describe('audit regressions', () => {
  it('copies templates with independent block, point and mapping identities', () => {
    const ws = fixture(); const original = ws.templates[0]!;
    const copy = copyTemplate(original, 'copy', 'copy');
    expect(workspaceSchema.safeParse({ ...ws, templates: [...ws.templates, copy] }).success).toBe(true);
    expect(copy.points.every(p => !original.points.some(o => o.id === p.id))).toBe(true);
    expect(copy.points.every(p => copy.blocks.some(b => b.id === p.blockId))).toBe(true);
    copy.points[0]!.mapping.offset = 99;
    expect(original.points[0]!.mapping.offset).toBe(0);
  });
  it('imports unsigned values, exact widths and relative addresses without overlapping blocks', () => {
    const p = buildImportPlan([row(100), row(102, 'Float32'), row(200, 'Float64')], 'auto', 'test');
    expect(p.blocks.map(b => [b.start, b.length])).toEqual([[100, 4], [200, 4]]);
    expect(p.points.map(p => [p.mapping.rawType, p.mapping.offset, p.mapping.registerCount])).toEqual([['UInt16', 0, 1], ['Float32', 2, 2], ['Float64', 0, 4]]);
    expect(buildImportPlan([{ ...row(0), area: 4 }], 'auto', 'x').points[0]?.access).toBe('ro');
  });
  it('rejects bad import rows, oversized single blocks and mixed address areas', () => {
    for (const bad of [{ ...row(0), name: '' }, row(NaN), row(65535, 'Float32'), row(0, 'garbage'), { ...row(0), scale: '0' }]) expect(() => buildImportPlan([bad], 'auto', 'x')).toThrow();
    expect(() => buildImportPlan([row(0), row(200)], 'single', 'x')).toThrow();
    expect(() => buildImportPlan([{ ...row(0), area: 4 }, row(1)], 'single', 'x')).toThrow();
  });
  it('clears confirmed cache when the address or slave endpoint changes', () => {
    const slave: SlaveDef = { id: 's', connectionId: 'c', unitId: 1, templateId: 't', name: 's', enabled: true };
    const block: BlockDef = { id: 'b', name: 'b', area: 3, start: 0, length: 1, periodMs: 200 };
    const cache = new BlockCache();
    cache.ensure(slave, block); cache.applyReadResult('s::b', { kind: 'registers', fc: 3, registers: [123] }, 1);
    expect(cache.get('s::b')?.lastUpdateUtc).not.toBeNull();
    expect(cache.ensure(slave, { ...block, start: 10 }).lastUpdateUtc).toBeNull();
    cache.applyReadResult('s::b', { kind: 'registers', fc: 3, registers: [456] }, 1);
    expect(cache.ensure({ ...slave, unitId: 2 }, { ...block, start: 10 }).lastUpdateUtc).toBeNull();
  });
  it.each([false, true])('RTS drains before release and is released on write failure (%s)', async failure => {
    const calls: string[] = [];
    const port: SerialPortLike = { isOpen: true, open: cb => cb(null), close: cb => cb?.(null), on: () => undefined,
      set: (options, cb) => { calls.push(`rts:${options.rts}`); cb(); },
      write: (_data, cb) => { calls.push('write'); cb?.(failure ? new Error('fail') : null); return true; },
      drain: cb => { calls.push('drain'); cb(); } };
    const transport = new SerialTransport({ port: 'parameterized', baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1 }, () => port, 'toggle');
    await transport.connect();
    if (failure) await expect(transport.write(new Uint8Array([1]))).rejects.toThrow('fail');
    else await transport.write(new Uint8Array([1]));
    expect(calls).toEqual(failure ? ['rts:true', 'write', 'rts:false'] : ['rts:true', 'write', 'drain', 'rts:false']);
    await transport.close();
  });
});
