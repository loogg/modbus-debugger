import type { BlockHealth, ConnectionHealth, HealthSample, ParseEventRecord, TransactionRecord } from '../../shared/contracts';
import { randomUUID } from 'node:crypto';
import type { ConnectionDef } from '../../domain/model';
import type { DiagnosticsPage, DiagnosticsRead } from '../../shared/diagnostics';

export type {
  BlockHealth,
  ConnectionHealth,
  HealthSample,
  ParseEventRecord,
  ResultKind,
  SourceKind,
  TransactionRecord,
} from '../../shared/contracts';

const RING = 5000;
/** 1 Hz sampling => 10 minutes of health history per connection. */
const SERIES_RING = 600;
const HEALTH_WINDOW_MS = 60000;
const DETAIL_PAGE_BYTES = 128 * 1024;
interface HealthTransaction {
  at: number;
  duration: number;
  unitId: number;
  blockId: string | null;
  cycleStart: boolean;
  result: TransactionRecord['result'];
  bytes: number;
}
interface HealthBucket {
  transactions: HealthTransaction[];
  events: Array<{ at: number; kind: ParseEventRecord['kind'] }>;
}

function readRecords<T extends { connectionId: string }>(rows: T[], total: number, after: number | undefined, through: number | undefined, connectionId: string | undefined, limit: number) {
  const oldest = total - rows.length;
  const end = Math.min(through ?? total, total);
  if (after === undefined) {
    const selected: T[] = [];
    let bytes = 0;
    for (let index = rows.length - 1; index >= 0 && selected.length < limit; index--) {
      const row = rows[index]!;
      if (connectionId && row.connectionId !== connectionId) continue;
      const size = Buffer.byteLength(JSON.stringify(row));
      if (selected.length && bytes + size > DETAIL_PAGE_BYTES) break;
      selected.push(row); bytes += size;
    }
    return { rows: selected.reverse(), cursor: total, through: total, overwritten: false };
  }
  const result: T[] = [];
  let bytes = 0;
  let cursor = Math.max(oldest, Math.min(after, total));
  const upper = end < oldest ? total : end;
  while (cursor < upper && result.length < limit) {
    const row = rows[cursor - oldest]!;
    const matches = !connectionId || row.connectionId === connectionId;
    const size = matches ? Buffer.byteLength(JSON.stringify(row)) : 0;
    if (matches && result.length && bytes + size > DETAIL_PAGE_BYTES) break;
    cursor++;
    if (matches) { result.push(row); bytes += size; }
  }
  return { rows: result, cursor, through: upper, overwritten: after < oldest };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1)));
  return sorted[idx] as number;
}

export class DiagnosticsStore {
  private transactions: TransactionRecord[] = [];
  private parseEvents: ParseEventRecord[] = [];
  private seq = 0;
  // Absolute (never-trimmed) counters. The 100 ms delta loop compares these instead of
  // copying the whole ring buffer on every tick.
  private txTotal = 0;
  private evTotal = 0;
  private lastOkByConnection = new Map<string, string>();
  private series = new Map<string, HealthSample[]>();
  private healthBuckets = new Map<string, Map<number, HealthBucket>>();
  private generation = randomUUID();

  pruneHealth(nowMono: number): void {
    const cutoff = nowMono - HEALTH_WINDOW_MS;
    for (const [connectionId, buckets] of this.healthBuckets) {
      for (const second of buckets.keys()) if ((second + 1) * 1000 <= cutoff) buckets.delete(second);
      if (!buckets.size) this.healthBuckets.delete(connectionId);
    }
  }

  private healthBucket(connectionId: string, at: number): HealthBucket {
    let buckets = this.healthBuckets.get(connectionId);
    if (!buckets) { buckets = new Map(); this.healthBuckets.set(connectionId, buckets); }
    const second = Math.floor(at / 1000);
    for (const key of buckets.keys()) if (key < second - HEALTH_WINDOW_MS / 1000) buckets.delete(key);
    let bucket = buckets.get(second);
    if (!bucket) { bucket = { transactions: [], events: [] }; buckets.set(second, bucket); }
    return bucket;
  }

  nextTraceId(): string {
    this.seq += 1;
    return `t${this.seq.toString(36)}-${Date.now().toString(36)}`;
  }

  recordTransaction(rec: TransactionRecord): void {
    this.transactions.push(rec);
    this.txTotal += 1;
    if (rec.result === 'ok') this.lastOkByConnection.set(rec.connectionId, rec.startUtc);
    if (this.transactions.length > RING) this.transactions.splice(0, this.transactions.length - RING);
    if (rec.durationMs !== null) this.healthBucket(rec.connectionId, rec.startMono).transactions.push({
      at: rec.startMono, duration: rec.durationMs, unitId: rec.unitId,
      blockId: rec.sourceKind === 'poll' ? rec.sourceId : null, cycleStart: rec.pollCycleStart !== false,
      result: rec.result, bytes: (rec.requestAduHex.length + (rec.responseAduHex?.length ?? 0)) / 2,
    });
  }

  recordParseEvent(rec: Omit<ParseEventRecord, 'id'>): void {
    this.seq += 1;
    this.evTotal += 1;
    this.parseEvents.push({ ...rec, id: `p${this.seq.toString(36)}` });
    if (this.parseEvents.length > RING) this.parseEvents.splice(0, this.parseEvents.length - RING);
    this.healthBucket(rec.connectionId, rec.mono).events.push({ at: rec.mono, kind: rec.kind });
  }

  read(request: DiagnosticsRead): DiagnosticsPage {
    const reset = request.generation !== undefined && request.generation !== this.generation;
    const transactions = readRecords(this.transactions, this.txTotal, reset ? undefined : request.afterTransactions, reset ? undefined : request.throughTransactions, request.connectionId, request.limit);
    const events = readRecords(this.parseEvents, this.evTotal, reset ? undefined : request.afterEvents, reset ? undefined : request.throughEvents, request.connectionId, request.limit);
    return { generation: this.generation, transactions: transactions.rows, parseEvents: events.rows,
      transactionCursor: transactions.cursor, eventCursor: events.cursor,
      throughTransactions: transactions.through, throughEvents: events.through,
      hasMore: transactions.cursor < transactions.through || events.cursor < events.through,
      overwritten: transactions.overwritten || events.overwritten, reset };
  }

  recentTransactions(limit = 500): TransactionRecord[] {
    return this.transactions.slice(-limit);
  }

  transactionsForConnection(connectionId: string, limit = 500): TransactionRecord[] {
    return this.transactions.filter((t) => t.connectionId === connectionId).slice(-limit);
  }

  transactionsForPoint(pointId: string, limit = 50): TransactionRecord[] {
    return this.transactions.filter((t) => t.sourceId === pointId).slice(-limit);
  }

  findTransaction(traceId: string): TransactionRecord | undefined {
    return this.transactions.find((t) => t.traceId === traceId);
  }

  recentParseEvents(limit = 200): ParseEventRecord[] {
    return this.parseEvents.slice(-limit);
  }

  /** Absolute index the next recorded transaction will occupy. */
  get transactionTotal(): number {
    return this.txTotal;
  }

  /** Absolute index the next recorded parse event will occupy. */
  get parseEventTotal(): number {
    return this.evTotal;
  }

  /** Transactions recorded after absolute index `from`; records already trimmed away are skipped. */
  transactionsSince(from: number): TransactionRecord[] {
    if (from >= this.txTotal) return [];
    const oldest = this.txTotal - this.transactions.length;
    return this.transactions.slice(Math.max(0, from - oldest));
  }

  /** Parse events recorded after absolute index `from`; events already trimmed away are skipped. */
  parseEventsSince(from: number): ParseEventRecord[] {
    if (from >= this.evTotal) return [];
    const oldest = this.evTotal - this.parseEvents.length;
    return this.parseEvents.slice(Math.max(0, from - oldest));
  }

  /** UTC of the latest successful response for a connection, tracked incrementally (O(1) read). */
  lastOkUtcFor(connectionId: string): string | null {
    return this.lastOkByConnection.get(connectionId) ?? null;
  }

  /** Appends one health sample; samples sharing a timestamp are ignored. */
  recordHealthSample(connectionId: string, sample: HealthSample): void {
    let arr = this.series.get(connectionId);
    if (!arr) {
      arr = [];
      this.series.set(connectionId, arr);
    }
    const last = arr[arr.length - 1];
    if (last && last.t >= sample.t) return;
    arr.push(sample);
    if (arr.length > SERIES_RING) arr.splice(0, arr.length - SERIES_RING);
  }

  /** Health samples for the trailing window, oldest first. */
  healthSeriesFor(connectionId: string, windowMs: number, now = Date.now()): HealthSample[] {
    const arr = this.series.get(connectionId);
    if (!arr) return [];
    const cutoff = now - windowMs;
    return arr.filter((s) => s.t >= cutoff);
  }

  clear(): void {
    this.transactions = [];
    this.parseEvents = [];
    this.lastOkByConnection.clear();
    this.series.clear();
    this.healthBuckets.clear();
    this.generation = randomUUID();
    // txTotal / evTotal stay monotonic so cursors held by the delta loop remain valid.
  }

  health(
    connectionId: string,
    nowMono: number,
    blocks: Array<{ slaveId: string; unitId: number; blockId: string; blockName: string; configuredPeriodMs: number }>,
    windowSec = 60,
    line?: Pick<ConnectionDef, 'transport' | 'rtu'>,
  ): ConnectionHealth {
    windowSec = Math.min(60, Math.max(1, windowSec));
    const from = nowMono - windowSec * 1000;
    this.pruneHealth(nowMono);
    const buckets = this.healthBuckets.get(connectionId);
    const tx = [...buckets?.values() ?? []].flatMap(bucket => bucket.transactions).filter(t => t.at >= from && t.at <= nowMono);
    const events = [...buckets?.values() ?? []].flatMap(bucket => bucket.events).filter(event => event.at >= from && event.at <= nowMono);
    const durations = tx.map(t => t.duration).sort((a, b) => a - b);
    const timeouts = tx.filter((t) => t.result === 'timeout').length;
    const crcErrors = events.filter((e) => e.kind === 'crc').length;
    const exceptions = tx.filter((t) => t.result === 'exception').length;
    const unexpected = tx.filter((t) => t.result === 'unexpected').length + events.filter((e) => e.kind === 'unexpected').length;

    const bytes = tx.reduce((sum, transaction) => sum + transaction.bytes, 0);
    const throughputBytesPerSec = bytes / windowSec;
    const transport = line?.transport ?? 'rtu';
    const bitsPerCharacter = 1 + (line?.rtu?.dataBits ?? 8) + (line?.rtu?.parity && line.rtu.parity !== 'none' ? 1 : 0) + (line?.rtu?.stopBits ?? 1);
    const busLoadPercent = transport === 'rtu' ? Math.min(100, throughputBytesPerSec * bitsPerCharacter / (line?.rtu?.baudRate ?? 115200) * 100) : 0;

    const blockHealth: BlockHealth[] = blocks.map((b) => {
      const btx = tx.filter(t => t.blockId === b.blockId && t.unitId === b.unitId);
      const starts = btx.filter(transaction => transaction.cycleStart).map(t => t.at).sort((a, c) => a - c);
      let actual: number | null = null;
      if (starts.length > 1) {
        let sum = 0;
        for (let i = 1; i < starts.length; i++) sum += (starts[i] as number) - (starts[i - 1] as number);
        actual = sum / (starts.length - 1);
      }
      const bd = btx.map(t => t.duration).sort((a, c) => a - c);
      const bto = btx.filter((t) => t.result === 'timeout').length;
      return {
        slaveId: b.slaveId,
        blockId: b.blockId,
        blockName: b.blockName,
        configuredPeriodMs: b.configuredPeriodMs,
        actualPeriodMs: actual,
        p95Ms: percentile(bd, 95),
        timeoutRate: btx.length ? bto / btx.length : 0,
      };
    });

    return {
      connectionId,
      transport,
      throughputBytesPerSec,
      busLoadPercent,
      requestRatePerSec: tx.length / windowSec,
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      timeouts,
      crcErrors,
      exceptions,
      unexpected,
      windowSec,
      blocks: blockHealth,
    };
  }
}
