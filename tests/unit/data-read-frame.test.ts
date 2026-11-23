import { expect, it } from 'vitest';
import { encodeDataReadFrame, decodeDataReadFrame } from '../../src/shared/data-read-frame';
import { sampleColumns, sampleColumnBytes } from '../../src/shared/sample-columns';
import type { ColumnDataReadResult, PointSample } from '../../src/shared/point-data';

const row = (value: PointSample['value'], index: number): PointSample => ({ seq: index * 2 + 1, timeMs: 1794800000000.125 + index * 5, monoMs: index * 5 + .123456, value });
const response = (values: PointSample['value'][]): ColumnDataReadResult => {
  const columns = sampleColumns(values.map(row));
  return { format: 'columns-v1', checkedAtMs: Date.now(), points: {}, blocks: {}, buffers: {}, sampleBytes: sampleColumnBytes(columns), series: { 's::p': {
    columns, generation: 'g1', metadataVersion: 'm1', metadata: { capacity: 10000, references: ['趋势 · 测量'] }, count: values.length, firstSeq: 1, lastSeq: values.length * 2 - 1,
    firstTimeMs: columns.times[0] ?? null, lastTimeMs: columns.times.at(-1) ?? null, nextSeq: values.length * 2 - 1, throughSeq: values.length * 2 - 1, hasMore: false, gap: false, reset: false,
  } } };
};

it.each([[Math.PI, -0, Number.MAX_VALUE, .000000000123456789], [true, false, true], ['"引号"\n下一行 😀', '', '启动']])('roundtrips lossless typed samples and non-contiguous sequences', (...values) => {
  const source = response(values);
  const decoded = decodeDataReadFrame(encodeDataReadFrame('request-2', source));
  expect(decoded).toEqual({ id: 'request-2', value: source });
  expect(decoded.value.series['s::p']!.columns.times).toBeInstanceOf(Float64Array);
  expect(decoded.value.series['s::p']!.columns.sequences).toEqual(new Float64Array(values.map((_, index) => index * 2 + 1)));
});

it('uses 24 bytes per numeric sample and keeps stable metadata out of subsequent frames', () => {
  const source = response(Array.from({ length: 2000 }, (_, index) => 123.456789 + index));
  delete source.series['s::p']!.metadata;
  const frame = encodeDataReadFrame('page', source);
  expect(source.sampleBytes).toBe(48000);
  expect(frame.byteLength).toBeLessThan(49000);
  expect(decodeDataReadFrame(frame).value.series['s::p']!.metadata).toBeUndefined();
});

it('handles empty columns and rejects truncated, versioned and misaligned frames', () => {
  const empty = response([]);
  expect(decodeDataReadFrame(encodeDataReadFrame('empty', empty)).value).toEqual(empty);
  const frame = encodeDataReadFrame('data', response([1, 2, 3]));
  expect(() => decodeDataReadFrame(frame.slice(0, frame.byteLength - 1))).toThrow();
  const bad = frame.slice(0);
  new DataView(bad).setUint32(0, 2, true);
  expect(() => decodeDataReadFrame(bad)).toThrow('帧头');
  const headerSize = new DataView(frame).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(frame, 8, headerSize)));
  header.arrays[0].offset = 1;
  const bytes = new TextEncoder().encode(JSON.stringify(header));
  expect(bytes.length).toBe(headerSize);
  new Uint8Array(frame, 8, headerSize).set(bytes);
  expect(() => decodeDataReadFrame(frame)).toThrow('列边界');
});
