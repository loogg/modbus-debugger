import type { LineSeries } from './chart';

type Sample = LineSeries['data'][number];
function bound(data: Sample[], time: number, upper: boolean): number {
  let low = 0; let high = data.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (data[middle]![0] < time || (upper && data[middle]![0] === time)) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function nearestSample(data: Sample[], time: number, start = -Infinity, end = Infinity): Sample | null {
  const first = bound(data, start, false);
  const last = bound(data, end, true) - 1;
  if (first > last) return null;
  const after = bound(data, time, true);
  const left = data[Math.max(first, Math.min(last, after - 1))]!;
  const right = data[Math.max(first, Math.min(last, after))]!;
  return Math.abs(left[0] - time) <= Math.abs(right[0] - time) ? left : right;
}

export interface SampleCursor { time: number; rows: Array<{ series: LineSeries; sample: Sample | null }> }
export function sampleCursor(series: LineSeries[], time: number, start: number, end: number, selected: Record<string, boolean> = {}): SampleCursor | null {
  const visible = series.filter(item => selected[item.name] !== false);
  let closest: Sample | null = null;
  for (const item of visible) {
    const sample = nearestSample(item.data, time, start, end);
    if (sample && (!closest || Math.abs(sample[0] - time) < Math.abs(closest[0] - time))) closest = sample;
  }
  if (!closest) return null;
  return { time: closest[0], rows: visible.map(item => ({ series: item, sample: nearestSample(item.data, closest![0], start, end) })) };
}

/** Preserve extrema and original sample identifiers while bounding drawing work. */
export function drawingSamples(data: Sample[], start: number, end: number, maximum: number): Sample[] {
  const first = Math.max(0, bound(data, start, false) - 1);
  const last = Math.min(data.length, bound(data, end, true) + 1);
  const visible = data.slice(first, last);
  if (visible.length <= maximum || maximum < 4) return visible;
  const result: Sample[] = [visible[0]!];
  const buckets = Math.max(1, Math.floor((maximum - 2) / 2));
  for (let bucket = 0; bucket < buckets; bucket++) {
    const begin = 1 + Math.floor(bucket * (visible.length - 2) / buckets);
    const finish = 1 + Math.floor((bucket + 1) * (visible.length - 2) / buckets);
    let minimum = begin; let maximumIndex = begin;
    for (let index = begin + 1; index < finish; index++) {
      if (visible[index]![1] < visible[minimum]![1]) minimum = index;
      if (visible[index]![1] > visible[maximumIndex]![1]) maximumIndex = index;
    }
    for (const index of [...new Set([minimum, maximumIndex])].sort((a, b) => a - b)) result.push(visible[index]!);
  }
  result.push(visible.at(-1)!);
  return result;
}
