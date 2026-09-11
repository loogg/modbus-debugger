export type ResultKind =
  | 'ok'
  | 'exception'
  | 'unexpected'
  | 'timeout'
  | 'crc'
  | 'malformed'
  | 'transport';

export type SourceKind = 'poll' | 'write' | 'readback' | 'temporary-read' | 'scanner' | 'rmw-read' | 'rmw-write';

export interface TransactionRecord {
  traceId: string;
  connectionId: string;
  unitId: number;
  functionCode: number;
  sourceKind: SourceKind;
  sourceId: string | null;
  startUtc: string;
  startMono: number;
  durationMs: number | null;
  requestAduHex: string;
  responseAduHex: string | null;
  result: ResultKind;
  exceptionCode: number | null;
  mbapTransactionId: number | null;
  summary: string;
}

export interface ParseEventRecord {
  id: string;
  connectionId: string;
  kind: 'crc' | 'malformed' | 'unexpected' | 'truncated' | 'overflow';
  reason: string;
  rawHex: string;
  discarded: number;
  recoveredCount: number;
  traceId: string | null;
  utc: string;
  mono: number;
}

export interface BlockHealth {
  slaveId: string;
  blockId: string;
  blockName: string;
  configuredPeriodMs: number;
  actualPeriodMs: number | null;
  p95Ms: number | null;
  timeoutRate: number;
}

export interface ConnectionHealth {
  connectionId: string;
  busLoadPercent: number;
  requestRatePerSec: number;
  p50Ms: number;
  p95Ms: number;
  timeouts: number;
  crcErrors: number;
  exceptions: number;
  unexpected: number;
  windowSec: number;
  blocks: BlockHealth[];
}

const RING = 5000;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1)));
  return sorted[idx] as number;
}

export class DiagnosticsStore {
  private transactions: TransactionRecord[] = [];
  private parseEvents: ParseEventRecord[] = [];
  private seq = 0;

  nextTraceId(): string {
    this.seq += 1;
    return `t${this.seq.toString(36)}-${Date.now().toString(36)}`;
  }

  recordTransaction(rec: TransactionRecord): void {
    this.transactions.push(rec);
    if (this.transactions.length > RING) this.transactions.splice(0, this.transactions.length - RING);
  }

  recordParseEvent(rec: Omit<ParseEventRecord, 'id'>): void {
    this.seq += 1;
    this.parseEvents.push({ ...rec, id: `p${this.seq.toString(36)}` });
    if (this.parseEvents.length > RING) this.parseEvents.splice(0, this.parseEvents.length - RING);
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

  clear(): void {
    this.transactions = [];
    this.parseEvents = [];
  }

  health(
    connectionId: string,
    nowMono: number,
    blocks: Array<{ slaveId: string; blockId: string; blockName: string; configuredPeriodMs: number }>,
    windowSec = 60,
  ): ConnectionHealth {
    const from = nowMono - windowSec * 1000;
    const tx = this.transactions.filter((t) => t.connectionId === connectionId && t.startMono >= from && t.durationMs !== null);
    const events = this.parseEvents.filter((e) => e.connectionId === connectionId && e.mono >= from);
    const durations = tx.map((t) => t.durationMs as number).sort((a, b) => a - b);
    const timeouts = tx.filter((t) => t.result === 'timeout').length;
    const crcErrors = events.filter((e) => e.kind === 'crc').length;
    const exceptions = tx.filter((t) => t.result === 'exception').length;
    const unexpected = tx.filter((t) => t.result === 'unexpected').length + events.filter((e) => e.kind === 'unexpected').length;

    // Bus load: bytes on wire (request + response ADU) over the window, expressed as a
    // percentage of a nominal 115200 8N1 line capacity (11 bits/char).
    const bytes = tx.reduce((acc, t) => {
      const req = t.requestAduHex.length / 2;
      const res = t.responseAduHex ? t.responseAduHex.length / 2 : 0;
      return acc + req + res;
    }, 0);
    const bitsPerSec = (bytes * 11) / windowSec;
    const busLoadPercent = Math.min(100, (bitsPerSec / 115200) * 100);

    const blockHealth: BlockHealth[] = blocks.map((b) => {
      const btx = tx.filter((t) => t.sourceKind === 'poll' && t.sourceId === b.blockId);
      const starts = btx.map((t) => t.startMono).sort((a, c) => a - c);
      let actual: number | null = null;
      if (starts.length > 1) {
        let sum = 0;
        for (let i = 1; i < starts.length; i++) sum += (starts[i] as number) - (starts[i - 1] as number);
        actual = sum / (starts.length - 1);
      }
      const bd = btx.map((t) => t.durationMs as number).sort((a, c) => a - c);
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