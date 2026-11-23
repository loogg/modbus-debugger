import { expect, it } from 'vitest';
import { drawingSamples, sampleCursor } from '../../src/renderer/components/chart-data';
import { formatSampleCursor, type LineSeries } from '../../src/renderer/components/chart';

const series: LineSeries[] = [
  { name: '转速', color: '#0078D4', unit: 'rpm', data: [[0, 100, 1], [80, 150, 2], [100, 200, 3], [1000, 300, 4]] },
  { name: '温度', color: '#D97706', unit: '°C', data: [[0, 30, 1], [200, 31, 2], [400, 32, 3]] },
];
it('snaps to the nearest real time across visible signals and retains each independent sample', () => {
  const cursor = sampleCursor(series, 83, 0, 1000)!;
  expect(cursor.time).toBe(80);
  expect(cursor.rows.map(row => row.sample)).toEqual([[80, 150, 2], [0, 30, 1]]);
  expect(sampleCursor(series, 800, 0, 1000)!.time).toBe(1000);
  expect(sampleCursor(series, 83, 0, 1000, { 转速: false })!.time).toBe(0);
  expect(sampleCursor(series, 600, 500, 900)).toBeNull();
});
it('shows the actual time and sequence of every signal and escapes signal text', () => {
  const cursor = sampleCursor([{ ...series[0]!, name: '<img onerror="x">' }, series[1]!], 83, 0, 1000)!;
  const html = formatSampleCursor(cursor, time => `${time} ms`);
  expect(html).toContain('80 ms'); expect(html).toContain('0 ms'); expect(html).toContain('<td>2</td>');
  expect(html).toContain('150 rpm'); expect(html).toContain('&lt;img'); expect(html).not.toContain('<img');
});
it('bounds drawing work while preserving extrema and original sequence numbers', () => {
  const rows: LineSeries['data'] = Array.from({ length: 20000 }, (_, index) => [index, index === 1234 ? 1000 : index === 8999 ? -999 : 0, index + 1]);
  const display = drawingSamples(rows, 0, 19999, 1000);
  expect(display.length).toBeLessThanOrEqual(1000);
  expect(display).toContain(rows[1234]); expect(display).toContain(rows[8999]);
  expect(rows).toHaveLength(20000);
  expect(sampleCursor([{ ...series[0]!, data: rows }], 1235, 0, 19999)!.rows[0]!.sample![2]).toBe(1236);
});
