import { expect, it } from 'vitest';
import { SeriesData } from '../../src/renderer/store/series-data';
import { sampleColumns } from '../../src/shared/sample-columns';
import type { PointSample } from '../../src/shared/point-data';

const columns = (rows: Array<[number, number, PointSample['value']]>) => sampleColumns(rows.map(([seq, timeMs, value]) => ({ seq, timeMs, value, monoMs: seq * 5 })));

it('updates only new tuples and advances independent Host projections at their publication time', () => {
  const data = new SeriesData();
  data.update(columns([[1, 1000, 2], [2, 1005, 2]]), 1, 0);
  const fast = data.project();
  const slow = data.project();
  const firstTuple = fast.samples[0];
  const fastArray = fast.samples;
  data.update(columns([[2, 1005, 2], [3, 1010, 3]]), 1, 0);
  expect(slow.samples).toHaveLength(2);
  expect(data.project(fast)).toBe(fast);
  expect(fast.samples).toBe(fastArray);
  expect(fast.samples[0]).toBe(firstTuple);
  expect(fast.samples).toHaveLength(3);
  expect(slow.samples).toHaveLength(2);
  expect(data.project(slow).samples).toEqual(fast.samples);
  data.update(columns([]), 2, 1005);
  expect(data.project(fast).samples.map(row => row[2])).toEqual([2, 3]);
  expect(data.events).toEqual([]);
});

it('merges older windows, deduplicates sequence values and sorts real UTC after rollback', () => {
  const data = new SeriesData();
  data.update(columns([[4, 1015, 4], [5, 1020, 5]]), 1, 1010);
  const current = data.project();
  data.update(columns([[1, 1000, 1], [2, 1005, 2], [3, 1010, 3], [4, 1015, 4]]), 1, 0);
  expect(data.project(current).samples.map(row => row[2])).toEqual([1, 2, 3, 4, 5]);
  data.update(columns([[6, 1001, 6]]), 2, 0);
  expect(data.samples.map(row => row[2])).toEqual([6, 2, 3, 4, 5]);
  expect(data.samples.map(row => row[0])).toEqual([1001, 1005, 1010, 1015, 1020]);
});

it('compresses Bool/String and enum displays while retaining actual anchor time and sequence', () => {
  const data = new SeriesData();
  data.update(columns([[1, 1000, true], [2, 1005, true], [3, 1010, false]]), 1, 0);
  expect(data.events).toEqual([{ t: 1000, value: 'true', seq: 1 }, { t: 1010, value: 'false', seq: 3 }]);
  const projection = data.project();
  data.update(columns([[4, 1015, false]]), 2, 1005);
  expect(data.project(projection).events).toEqual([{ t: 1005, value: 'true', seq: 2 }, { t: 1010, value: 'false', seq: 3 }]);
  const enums = new SeriesData();
  enums.update(columns([[1, 1000, 1], [2, 1005, 1], [3, 1010, 9]]), 1, 0, { '1': '运行' });
  expect(enums.events.map(event => event.value)).toEqual(['运行', '9']);
  enums.update(columns([]), 1, 0, { '1': '就绪', '9': '故障' });
  expect(enums.events.map(event => event.value)).toEqual(['就绪', '故障']);
  const strings = new SeriesData();
  strings.update(columns([[1, 1000, '启动 😀'], [2, 1005, '启动 😀']]), 1, 0);
  expect(strings.events).toEqual([{ t: 1000, value: '启动 😀', seq: 1 }]);
});
