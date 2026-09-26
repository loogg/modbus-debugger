export interface TimedSample {
  signalId: string;
  tMs: number;
  value: number;
}

/** Keep the first, last, and each contiguous sample bucket's extremes for a pixel-scale chart. */
export function chartSamples(samples: readonly TimedSample[], maxPoints = 5000): Array<[number, number]> {
  if (samples.length <= maxPoints) return samples.map(sample => [sample.tMs, sample.value]);
  if (maxPoints < 4) throw new Error('Chart point budget must be at least four');
  const bucketCount = Math.floor((maxPoints - 2) / 2);
  const bucketSize = Math.ceil((samples.length - 2) / bucketCount);
  const first = samples[0]!;
  const out: Array<[number, number]> = [[first.tMs, first.value]];
  for (let start = 1; start < samples.length - 1; start += bucketSize) {
    const end = Math.min(start + bucketSize, samples.length - 1);
    let low = start;
    let high = start;
    for (let index = start + 1; index < end; index++) {
      if (samples[index]!.value < samples[low]!.value) low = index;
      if (samples[index]!.value > samples[high]!.value) high = index;
    }
    const earlier = samples[Math.min(low, high)]!;
    out.push([earlier.tMs, earlier.value]);
    if (low !== high) {
      const later = samples[Math.max(low, high)]!;
      out.push([later.tMs, later.value]);
    }
  }
  const last = samples[samples.length - 1]!;
  out.push([last.tMs, last.value]);
  return out;
}

export function groupSamplesBySignal<T extends { signalId: string }>(samples: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const sample of samples) {
    const group = grouped.get(sample.signalId);
    if (group) group.push(sample);
    else grouped.set(sample.signalId, [sample]);
  }
  return grouped;
}

/** Input rows are sorted by tMs by HistoryStore; return the exact confirmed value. */
export function sampleAtOrBefore<T extends { tMs: number }>(samples: readonly T[], cursorMs: number): T | undefined {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (samples[middle]!.tMs <= cursorMs) low = middle + 1;
    else high = middle;
  }
  return samples[low - 1];
}

/** Build the clipboard CSV in bounded line batches; the final string is required by writeText. */
export function buildHistoryCsv(
  samples: readonly TimedSample[],
  events: readonly { signalId: string; tMs: number; value: string }[],
): string {
  const cell = (value: unknown) => `"${String(value).replaceAll('"', '""')}"`;
  const chunks = ['signal,t_ms,value'];
  let lines: string[] = [];
  const append = (line: string) => {
    lines.push(line);
    if (lines.length >= 8192) {
      chunks.push(lines.join('\n'));
      lines = [];
    }
  };
  for (const sample of samples) append(`${cell(sample.signalId)},${sample.tMs},${cell(sample.value)}`);
  for (const event of events) append(`${cell(event.signalId)},${event.tMs},${cell(event.value)}`);
  if (lines.length) chunks.push(lines.join('\n'));
  return chunks.join('\n');
}
