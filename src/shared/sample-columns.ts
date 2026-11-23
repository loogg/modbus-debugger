import type { PointSample, SampleColumns } from './point-data';

const encoder = new TextEncoder();

export function sampleValueBytes(value: PointSample['value']): number {
  if (typeof value === 'number') return 24;
  if (typeof value === 'boolean') return 17;
  // Include JSON escaping and the array separator used by the review transport.
  return 16 + encoder.encode(JSON.stringify(value)).byteLength + 1;
}

export function sampleColumnBytes(columns: SampleColumns): number {
  const coordinates = columns.times.byteLength + columns.sequences.byteLength;
  return coordinates + (columns.kind === 'string'
    ? columns.values.reduce((sum, value) => sum + encoder.encode(JSON.stringify(value)).byteLength + 1, 0)
    : columns.values.byteLength);
}

export function sampleColumns(rows: PointSample[]): SampleColumns {
  const times = new Float64Array(rows.length);
  const sequences = new Float64Array(rows.length);
  const kind = typeof rows[0]?.value;
  const columns: SampleColumns = kind === 'string'
    ? { kind: 'string', times, sequences, values: new Array<string>(rows.length) }
    : kind === 'boolean'
      ? { kind: 'boolean', times, sequences, values: new Uint8Array(rows.length) }
      : { kind: 'number', times, sequences, values: new Float64Array(rows.length) };
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    times[index] = row.timeMs;
    sequences[index] = row.seq;
    if (columns.kind === 'string') columns.values[index] = String(row.value);
    else columns.values[index] = Number(row.value);
  }
  return columns;
}
