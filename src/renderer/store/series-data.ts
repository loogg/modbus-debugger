import type { SampleColumns } from '../../shared/point-data';

export type NumericSample = [number, number, number];
export interface StateSample { t: number; value: boolean | string; seq: number }
export interface StateEvent { t: number; value: string; seq: number }
export interface SeriesDisplay {
  samples: NumericSample[];
  events: StateEvent[];
  revision: number;
}
export interface SeriesProjection extends SeriesDisplay { source: SeriesData; structure: number; startMs?: number; endMs?: number }
const compare = (left: NumericSample, right: NumericSample) => left[0] - right[0] || left[2] - right[2];

/** Shared display arrays. Only newly received samples are converted to chart tuples. */
export class SeriesData {
  samples: NumericSample[] = [];
  events: StateEvent[] = [];
  revision = 0;
  private states: StateSample[] = [];
  private sequences = new Set<number>();
  private orderedSequence = true;
  private labels: Record<string, string> | undefined;
  private labelSignature = 'null';
  private structure = 0;

  update(columns: SampleColumns, firstSeq: number, startMs: number, labels?: Record<string, string>, endMs = Infinity): void {
    const signature = JSON.stringify(labels ?? null);
    let rebuildEvents = signature !== this.labelSignature;
    this.labels = labels;
    this.labelSignature = signature;
    let changed = rebuildEvents;
    let reorder = false;
    for (let index = 0; index < columns.times.length; index++) {
      const seq = columns.sequences[index]!;
      if (this.sequences.has(seq)) continue;
      const t = columns.times[index]!;
      const raw = columns.values[index]!;
      this.sequences.add(seq);
      changed = true;
      if (columns.kind === 'number') {
        const row: NumericSample = [t, Number(raw), seq];
        if (this.samples.length && compare(row, this.samples.at(-1)!) < 0) reorder = true;
        this.samples.push(row);
        if (labels) this.appendEvent(t, raw, seq);
      } else {
        const value = columns.kind === 'boolean' ? Boolean(raw) : String(raw);
        const last = this.states.at(-1);
        if (last && (t < last.t || t === last.t && seq < last.seq)) reorder = true;
        this.states.push({ t, value, seq });
        this.appendEvent(t, value, seq);
      }
    }
    if (reorder) {
      this.samples.sort(compare);
      this.states.sort((left, right) => left.t - right.t || left.seq - right.seq);
      const rows = this.samples.length ? this.samples.map(row => row[2]) : this.states.map(row => row.seq);
      this.orderedSequence = rows.every((seq, index) => index === 0 || seq > rows[index - 1]!);
      rebuildEvents = true;
    }
    const numericRemoved = this.trim(this.samples, firstSeq, startMs, row => row[0], row => row[2], endMs);
    const statesRemoved = this.trim(this.states, firstSeq, startMs, row => row.t, row => row.seq, endMs);
    changed ||= numericRemoved || statesRemoved;
    if (rebuildEvents || !this.orderedSequence && (numericRemoved || statesRemoved)) {
      this.events = [];
      if (labels) for (const row of this.samples) this.appendEvent(row[0], row[1], row[2]);
      for (const row of this.states) this.appendEvent(row.t, row.value, row.seq);
    } else if (numericRemoved || statesRemoved) this.trimEvents();
    if (rebuildEvents) this.structure++;
    if (changed) this.revision++;
  }

  /** Each Host advances its own display arrays only when its publication is due. */
  project(previous?: SeriesProjection, startMs = -Infinity, endMs = Infinity): SeriesProjection {
    const numeric = this.bounds(this.samples, startMs, endMs, row => row[0]);
    const events = this.bounds(this.events, startMs, endMs, row => row.t);
    events[0] = Math.max(0, events[0] - 1);
    if (!previous || previous.source !== this || previous.structure !== this.structure || !this.orderedSequence || startMs < (previous.startMs ?? -Infinity) || endMs < (previous.endMs ?? Infinity)) {
      return { source: this, structure: this.structure, revision: this.revision, startMs, endMs, samples: this.samples.slice(...numeric), events: this.events.slice(...events) };
    }
    if (previous.revision === this.revision && previous.startMs === startMs && previous.endMs === endMs) return previous;
    this.advance(previous.samples, this.samples.slice(...numeric), row => row[2]);
    this.advance(previous.events, this.events.slice(...events), row => row.seq);
    previous.revision = this.revision;
    previous.startMs = startMs;
    previous.endMs = endMs;
    return previous;
  }

  private bounds<T>(rows: T[], start: number, end: number, time: (row: T) => number): [number, number] {
    let low = 0;
    let high = rows.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (time(rows[middle]!) < start) low = middle + 1;
      else high = middle;
    }
    const first = low;
    high = rows.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (time(rows[middle]!) <= end) low = middle + 1;
      else high = middle;
    }
    return [first, low];
  }

  private advance<T>(target: T[], source: T[], sequence: (row: T) => number): void {
    if (!source.length) { target.length = 0; return; }
    const first = sequence(source[0]!);
    let removed = 0;
    while (removed < target.length && sequence(target[removed]!) < first) removed++;
    target.splice(0, removed);
    const last = target.length ? sequence(target.at(-1)!) : -Infinity;
    let low = 0;
    let high = source.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (sequence(source[middle]!) <= last) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < source.length; index++) target.push(source[index]!);
    // A compressed state run acquires the first remaining real sample as its anchor.
    if (target.length && sequence(target[0]!) > first) target.unshift(source[0]!);
  }

  private appendEvent(t: number, value: unknown, seq: number): void {
    const label = this.labels?.[String(value)] ?? String(value);
    if (this.events.at(-1)?.value !== label) this.events.push({ t, value: label, seq });
  }

  private trim<T>(rows: T[], firstSeq: number, startMs: number, time: (row: T) => number, sequence: (row: T) => number, endMs = Infinity): boolean {
    let low = 0;
    let high = rows.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (time(rows[middle]!) < startMs) low = middle + 1;
      else high = middle;
    }
    if (this.orderedSequence) {
      while (low < rows.length && sequence(rows[low]!) < firstSeq) low++;
    }
    const removed = rows.splice(0, low);
    while (rows.length && time(rows.at(-1)!) > endMs) removed.push(rows.pop()!);
    if (!this.orderedSequence) {
      // UTC rollback can reorder sequence numbers. Keep all surviving real samples.
      for (let index = rows.length - 1; index >= 0; index--) {
        if (sequence(rows[index]!) < firstSeq) removed.push(...rows.splice(index, 1));
      }
    }
    for (const row of removed) this.sequences.delete(sequence(row));
    return removed.length > 0;
  }

  private trimEvents(): void {
    const state = this.states[0];
    const numeric = this.labels ? this.samples[0] : undefined;
    const first = state ?? (numeric ? { t: numeric[0], value: numeric[1], seq: numeric[2] } : undefined);
    if (!first) { this.events.length = 0; return; }
    let removed = 0;
    while (removed < this.events.length && (this.events[removed]!.t < first.t || this.events[removed]!.t === first.t && this.events[removed]!.seq < first.seq)) removed++;
    this.events.splice(0, removed);
    if (this.events[0]?.seq !== first.seq) this.events.unshift({ t: first.t, value: this.labels?.[String(first.value)] ?? String(first.value), seq: first.seq });
  }
}
