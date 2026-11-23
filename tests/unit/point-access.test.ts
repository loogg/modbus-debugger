import { expect, it } from 'vitest';
import { blockSchema, pointSchema, workspaceSchema } from '../../src/domain/model';
import { buildImportPlan } from '../../src/domain/import-plan';
import { bindingError } from '../../src/domain/canvas-binding';
import { canReadPoint, canWritePoint, mappingWidth, planBlockReads } from '../../src/domain/point-access';
import { BlockCache } from '../../src/main/runtime/block-cache';
import { templateWorkspace } from '../support/template-workspace';
import { buildRtuAdu, buildTcpAdu, decodeResponsePdu, encodeRequestPdu, encodeResponsePdu, expectedResponseAduLength, RtuStreamingFramer, validateAdu } from '../../src/domain/protocol';
import { decodeSlaveRequest } from '../../src/domain/protocol/slave';

const point = (id: string, offset: number, access: 'ro' | 'rw' | 'wo', type = 'UInt16', width = 1) => pointSchema.parse({ id, blockId: 'b', name: id, access, mapping: { rawType: type, offset, registerCount: width, bitOffset: 0, bitWidth: 1, byteSelector: 'low', wordOrder: 'ABCD', stringLength: type === 'String' ? width * 2 : 0, stringEncoding: 'ascii' } });

it('imports and round-trips write-only access while enforcing read-only input areas and canvas bindings', () => {
  const plan = buildImportPlan(['WO', '只写', 'RW', 'RO'].map((access, address) => ({ address, name: access, type: 'UInt16', access, unit: '', scale: '', offset: '' })), 'auto', 'import');
  expect(plan.points.map(item => item.access)).toEqual(['wo', 'wo', 'rw', 'ro']);
  const workspace = templateWorkspace();
  workspace.templates[0]!.points[0]!.access = 'wo';
  expect(workspaceSchema.parse(JSON.parse(JSON.stringify(workspace))).templates[0]!.points[0]!.access).toBe('wo');
  workspace.templates[0]!.blocks[0]!.area = 4;
  expect(workspaceSchema.safeParse(workspace).success).toBe(false);
  expect(bindingError('input', plan.points[0]!)).toBeNull();
  expect(bindingError('lamp', plan.points[0]!)).toContain('只写');
  expect(bindingError('trend', plan.points[0]!)).toContain('只写');
});

it('plans mixed and pure write-only blocks with readable aliases', () => {
  const block = blockSchema.parse({ id: 'b', name: 'b', area: 3, start: 100, length: 10, periodMs: 5 });
  const points = [point('a', 0, 'rw'), point('command', 3, 'wo'), point('b', 4, 'ro')];
  expect(planBlockReads(block, points)).toEqual([{ offset: 0, length: 3 }, { offset: 4, length: 6 }]);
  expect(planBlockReads(block, [points[1]!])).toEqual([]);
  expect(planBlockReads(block, [...points, point('alias', 3, 'ro')])).toEqual([{ offset: 0, length: 10 }]);
  expect(canReadPoint(points[1]!)).toBe(false); expect(canWritePoint(points[1]!)).toBe(true);
});

it('covers overlapping large mappings without splitting their actual sampling spans', () => {
  const block = blockSchema.parse({ id: 'b', name: 'b', area: 3, start: 0, length: 300, periodMs: 0 });
  const points = [point('text-a', 0, 'rw', 'String', 100), point('text-b', 50, 'rw', 'String', 100), point('double', 249, 'ro', 'Float64', 4)];
  const ranges = planBlockReads(block, points);
  expect(ranges.every(range => range.length > 0 && range.length <= 125)).toBe(true);
  for (const definition of points) expect(ranges.some(range => range.offset <= definition.mapping.offset && range.offset + range.length >= definition.mapping.offset + mappingWidth(block.area, definition.mapping))).toBe(true);
});

it('merges only confirmed ranges and keeps unacquired addresses invalid', () => {
  const cache = new BlockCache(); const workspace = templateWorkspace();
  const slave = workspace.slaves[0]!; const block = { ...workspace.templates[0]!.blocks[0]!, length: 10 };
  const entry = cache.ensure(slave, block);
  const updates: number[] = []; cache.onConfirmed = (_entry, range) => updates.push(range.offset);
  cache.applyReadResult(entry.key, { kind: 'registers', fc: 3, registers: [10, 11, 12] }, 1, 0, 3);
  cache.markError(entry.key, 'exception', 2, { offset: 4, length: 6 });
  expect(entry.valid).toEqual([true, true, true, false, false, false, false, false, false, false]);
  expect(cache.mappingValid(entry, point('b', 4, 'rw').mapping)).toBe(false);
  cache.applyReadResult(entry.key, { kind: 'registers', fc: 3, registers: [20, 21, 22, 23, 24, 25] }, 1, 4, 6);
  expect(Array.from(entry.memory.kind === 'registers' ? entry.memory.registers : [])).toEqual([10, 11, 12, 0, 20, 21, 22, 23, 24, 25]);
  expect(entry.status).toBe('ok'); expect(entry.valid[3]).toBe(false); expect(updates).toEqual([0, 4]);
});

it('encodes, validates and streams mask-write requests and responses with exact echo checks', () => {
  const request = { kind: 'maskWrite', fc: 0x16, address: 3, andMask: 0xfffe, orMask: 1 } as const;
  expect(Array.from(encodeRequestPdu(request))).toEqual([22, 0, 3, 255, 254, 0, 1]);
  expect(decodeSlaveRequest(encodeRequestPdu(request))).toEqual(request);
  const response = { kind: 'maskWriteAck', fc: 0x16, address: 3, andMask: 0xfffe, orMask: 1 } as const;
  const pdu = encodeResponsePdu(response);
  expect(decodeResponsePdu(pdu, 22)).toEqual(response);
  expect(expectedResponseAduLength(request, 'rtu')).toBe(10);
  const frame = buildRtuAdu(1, pdu); const framer = new RtuStreamingFramer({ expectedAduLength: () => 10 });
  expect(framer.push(frame.slice(0, 4))).toEqual([]);
  expect(framer.push(frame.slice(4)).some(event => event.type === 'adu')).toBe(true);
  expect(validateAdu(frame, { transport: 'rtu', unitId: 1, fc: 22, expectedAduLength: 10, request }).type).toBe('ok');
  expect(validateAdu(buildTcpAdu(7, 1, encodeResponsePdu({ ...response, orMask: 0 })), { transport: 'tcp', tid: 7, unitId: 1, fc: 22, expectedAduLength: 14, request }).type).toBe('unexpected');
  const single = { kind: 'writeRegister', fc: 6, address: 3, value: 10 } as const;
  expect(validateAdu(buildTcpAdu(8, 1, encodeResponsePdu({ kind: 'writeAck', fc: 6, address: 4, extra: 10 })), { transport: 'tcp', tid: 8, unitId: 1, fc: 6, expectedAduLength: 12, request: single }).type).toBe('unexpected');
});
