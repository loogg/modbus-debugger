import { expect, it } from 'vitest';
import { buildHistoryCsv, chartSamples, groupSamplesBySignal, sampleAtOrBefore } from '../../src/renderer/history-data';

it('limits chart points while retaining endpoints and each bucket extreme in time order', () => {
  const samples = Array.from({ length: 100 }, (_, index) => ({ signalId: 'a', tMs: index * 1000, value: index }));
  samples[20]!.value = 1000;
  samples[21]!.value = -1000;
  const chart = chartSamples(samples, 10);
  expect(chart.length).toBeLessThanOrEqual(10);
  expect(chart[0]).toEqual([0, 0]);
  expect(chart.at(-1)).toEqual([99000, 99]);
  expect(chart).toContainEqual([20000, 1000]);
  expect(chart).toContainEqual([21000, -1000]);
  expect(chart.map(([time]) => time)).toEqual([...chart.map(([time]) => time)].sort((a, b) => a - b));
  expect(samples[20]?.value).toBe(1000);
});

it('keeps full precision when under budget and finds the exact last sample at a replay cursor', () => {
  const samples = [
    { signalId: 'a', tMs: 0, value: 1 },
    { signalId: 'b', tMs: 5, value: 9 },
    { signalId: 'a', tMs: 10, value: 2 },
    { signalId: 'a', tMs: 10, value: 3 },
    { signalId: 'a', tMs: 20, value: 4 },
  ];
  const grouped = groupSamplesBySignal(samples);
  const a = grouped.get('a')!;
  expect(chartSamples(a)).toEqual([[0, 1], [10, 2], [10, 3], [20, 4]]);
  expect(sampleAtOrBefore(a, -1)).toBeUndefined();
  expect(sampleAtOrBefore(a, 10)?.value).toBe(3);
  expect(sampleAtOrBefore(a, 19)?.value).toBe(3);
  expect(sampleAtOrBefore(a, 20)?.value).toBe(4);
  expect(grouped.get('b')).toEqual([samples[1]]);
});

it('exports every raw sample and event in order with the original CSV escaping', () => {
  const csv = buildHistoryCsv(
    [{ signalId: 'a"b', tMs: 0, value: 1.5 }, { signalId: 'c', tMs: 10, value: -2 }],
    [{ signalId: 'event', tMs: 11, value: 'on,"ready"' }],
  );
  expect(csv).toBe('signal,t_ms,value\n"a""b",0,"1.5"\n"c",10,"-2"\n"event",11,"on,""ready"""');
  const acrossBatches = buildHistoryCsv(Array.from({ length: 8193 }, (_, index) => ({ signalId: 'a', tMs: index, value: index })), []);
  expect(acrossBatches.split('\n')).toHaveLength(8194);
  expect(acrossBatches.endsWith('"a",8192,"8192"')).toBe(true);
});
