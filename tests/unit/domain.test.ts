import { describe, expect, it } from 'vitest';
import { decodeRaw, encodeRaw, registersForType, type PointMapping, type RawMemory } from '../../src/domain/mapping';
import { engineeringToRaw, inverseToRaw, quantize, toEngineering } from '../../src/domain/scale';
import { findBlockOverlaps, pointSharesRegister } from '../../src/domain/overlap';
import { parsePlcReference, toPlcReference } from '../../src/domain/address';
import { migrateWorkspace, emptyWorkspace } from '../../src/domain/model';
import type { BlockDef } from '../../src/domain/model';

const m = (over: Partial<PointMapping>): PointMapping => ({
  rawType: 'UInt16',
  offset: 0,
  registerCount: 1,
  wordOrder: 'ABCD',
  byteSelector: 'low',
  bitOffset: 0,
  bitWidth: 16,
  stringLength: 0,
  stringEncoding: 'ascii',
  ...over,
});
const regs = (...v: number[]): RawMemory => ({ kind: 'registers', registers: Uint16Array.from(v) });

describe('Point mapping golden decode', () => {
  it('Int16 / UInt16', () => {
    expect(decodeRaw(regs(0x8000), m({ rawType: 'Int16' }))).toBe(-32768);
    expect(decodeRaw(regs(0x7fff), m({ rawType: 'Int16' }))).toBe(32767);
    expect(decodeRaw(regs(0xffff), m({ rawType: 'UInt16' }))).toBe(65535);
  });
  it('Int32 / UInt32 word orders', () => {
    expect(decodeRaw(regs(0x0000, 0x0001), m({ rawType: 'UInt32', registerCount: 2 }))).toBe(1);
    expect(decodeRaw(regs(0x0001, 0x0000), m({ rawType: 'UInt32', registerCount: 2, wordOrder: 'CDAB' }))).toBe(1);
    expect(decodeRaw(regs(0xffff, 0xffff), m({ rawType: 'Int32', registerCount: 2 }))).toBe(-1);
  });
  it('Float32 ABCD golden 48.237', () => {
    const value = decodeRaw(regs(0x4240, 0xf2b0), m({ rawType: 'Float32', registerCount: 2 }));
    expect(Number(value)).toBeCloseTo(48.237, 3);
    const cdab = decodeRaw(regs(0xf2b0, 0x4240), m({ rawType: 'Float32', registerCount: 2, wordOrder: 'CDAB' }));
    expect(Number(cdab)).toBeCloseTo(48.237, 3);
  });
  it('UInt8 high / low byte', () => {
    expect(decodeRaw(regs(0x1234), m({ rawType: 'UInt8', byteSelector: 'high' }))).toBe(0x12);
    expect(decodeRaw(regs(0x1234), m({ rawType: 'UInt8', byteSelector: 'low' }))).toBe(0x34);
    expect(decodeRaw(regs(0xff34), m({ rawType: 'Int8', byteSelector: 'high' }))).toBe(-1);
  });
  it('Bool and BitField', () => {
    expect(decodeRaw(regs(0x0010), m({ rawType: 'Bool', bitOffset: 4 }))).toBe(true);
    expect(decodeRaw(regs(0x0070), m({ rawType: 'BitField', bitOffset: 4, bitWidth: 3 }))).toBe(7);
    expect(decodeRaw(regs(0x0000), m({ rawType: 'Bool', bitOffset: 4 }))).toBe(false);
  });
  it('String ascii and length', () => {
    const value = decodeRaw(regs(0x5632, 0x2e34, 0x0000, 0x0000), m({ rawType: 'String', registerCount: 4, stringLength: 6 }));
    expect(value).toBe('V2.4');
  });
  it('bit memory Bool', () => {
    expect(decodeRaw({ kind: 'bits', bits: [false, true] }, m({ rawType: 'Bool', offset: 1 }))).toBe(true);
  });
  it('encode is inverse for RMW merge', () => {
    const base = regs(0x0000, 0x0000);
    const merged = encodeRaw(base, m({ rawType: 'BitField', offset: 1, bitOffset: 4, bitWidth: 3 }), 5);
    expect(decodeRaw(merged, m({ rawType: 'BitField', offset: 1, bitOffset: 4, bitWidth: 3 }))).toBe(5);
    expect((merged as { registers: Uint16Array }).registers[1]).toBe(0x50);
  });
  it('registersForType', () => {
    expect(registersForType('Float32')).toBe(2);
    expect(registersForType('Float64')).toBe(4);
    expect(registersForType('String', 8)).toBe(4);
  });
});

describe('Scale / Offset write conversion', () => {
  it('engineering = raw * scale + offset', () => {
    expect(toEngineering(15000, { scale: 0.1, offset: 0 })).toBeCloseTo(1500);
  });
  it('write raw quantizes and range-checks', () => {
    const r = engineeringToRaw(1500, { scale: 0.1, offset: 0 }, 'Int16', 16);
    expect(r).toEqual({ ok: true, value: 15000 });
  });
  it('rejects Scale = 0', () => {
    expect(inverseToRaw(10, { scale: 0, offset: 0 }).ok).toBe(false);
  });
  it('rejects NaN / Infinity', () => {
    expect(inverseToRaw(NaN, { scale: 1, offset: 0 }).ok).toBe(false);
    expect(inverseToRaw(Infinity, { scale: 1, offset: 0 }).ok).toBe(false);
    expect(quantize(Infinity, 'Int16', 16).ok).toBe(false);
  });
  it('rejects out-of-range raw', () => {
    expect(engineeringToRaw(40000, { scale: 1, offset: 0 }, 'Int16', 16).ok).toBe(false);
    expect(engineeringToRaw(300, { scale: 1, offset: 0 }, 'BitField', 3).ok).toBe(false);
  });
  it('rounds half to nearest representable integer', () => {
    expect(engineeringToRaw(15.6, { scale: 0.1, offset: 0 }, 'Int16', 16)).toEqual({ ok: true, value: 156 });
  });
});

describe('Block overlap / point overlap', () => {
  const b = (id: string, area: 1 | 2 | 3 | 4, start: number, length: number): BlockDef => ({ id, name: id, area, start, length, periodMs: 100 });
  it('same-area overlap rejected', () => {
    expect(findBlockOverlaps([b('a', 3, 0, 32), b('b', 3, 16, 16)]).length).toBe(1);
  });
  it('different areas may overlap', () => {
    expect(findBlockOverlaps([b('a', 3, 0, 32), b('b', 4, 0, 32)]).length).toBe(0);
  });
  it('points may share registers', () => {
    expect(pointSharesRegister({ offset: 4, registerCount: 1 }, { offset: 4, registerCount: 1 })).toBe(true);
  });
});

describe('PLC reference conversion (import layer only)', () => {
  it('40001 -> Holding 0', () => {
    expect(parsePlcReference('100')).toBeNull();
    expect(parsePlcReference('1')).toBeNull();
    expect(parsePlcReference('100001')).toEqual({ area: 2, address: 0 });
    expect(parsePlcReference('40001')).toEqual({ area: 3, address: 0 });
    expect(parsePlcReference(30001)).toEqual({ area: 4, address: 0 });
    expect(parsePlcReference(10001)).toEqual({ area: 2, address: 0 });
    expect(parsePlcReference('00001')).toEqual({ area: 1, address: 0 });
    expect(toPlcReference(3, 5)).toBe(40006);
  });
});

describe('Workspace schema + migration', () => {
  it('empty workspace validates', () => {
    expect(emptyWorkspace().schemaVersion).toBe(1);
  });
  it('v0 payload with top-level blocks/points migrates into templates', () => {
    const migrated = migrateWorkspace({
      schemaVersion: 0,
      name: 'old',
      templates: [{ id: 't1', name: 'T', version: '1', description: '', }],
      blocks: [{ id: 'b1', templateId: 't1', name: 'B', area: 3, start: 0, length: 4, periodMs: 100 }],
      points: [],
    });
    expect(migrated.templates[0]?.blocks.length).toBe(1);
  });
  it('rejects newer schema', () => {
    expect(() => migrateWorkspace({ schemaVersion: 99 })).toThrow();
  });
});