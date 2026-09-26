import { describe, expect, it } from 'vitest';
import { DiagnosticsStore, type ParseEventRecord, type TransactionRecord } from '../../src/main/runtime/diagnostics';

function tx(i: number, over: Partial<TransactionRecord> = {}): TransactionRecord {
  return {
    traceId: `t${i}`,
    connectionId: 'c1',
    unitId: 1,
    functionCode: 3,
    sourceKind: 'poll',
    sourceId: null,
    startUtc: new Date(1700000000000 + i).toISOString(),
    startMono: i,
    durationMs: 1,
    requestAduHex: '00',
    responseAduHex: '00',
    result: 'ok',
    exceptionCode: null,
    mbapTransactionId: null,
    summary: `s${i}`,
    ...over,
  };
}

function ev(i: number): Omit<ParseEventRecord, 'id'> {
  return {
    connectionId: 'c1',
    kind: 'crc',
    reason: 'bad crc',
    rawHex: '00',
    discarded: 1,
    recoveredCount: 0,
    traceId: null,
    unitId: null,
    functionCode: null,
    sourceKind: null,
    utc: new Date(1700000000000 + i).toISOString(),
    mono: i,
  };
}

describe('DiagnosticsStore absolute cursors', () => {
  it('streams every record exactly once through transactionsSince()', () => {
    const d = new DiagnosticsStore();
    const seen: string[] = [];
    let cursor = 0;
    for (let i = 0; i < 10; i++) {
      d.recordTransaction(tx(i));
      const batch = d.transactionsSince(cursor);
      cursor = d.transactionTotal;
      seen.push(...batch.map((t) => t.traceId));
    }
    expect(seen).toEqual(Array.from({ length: 10 }, (_, i) => `t${i}`));
  });

  it('keeps streaming after the ring buffer trims (the length-comparison cursor stalls there)', () => {
    const d = new DiagnosticsStore();
    // RING is 5000: fill past it so the oldest records are dropped.
    for (let i = 0; i < 5000; i++) d.recordTransaction(tx(i));
    expect(d.recentTransactions(5000).length).toBe(5000);
    let cursor = d.transactionTotal;
    expect(d.transactionsSince(cursor)).toEqual([]);
    for (let i = 5000; i < 5010; i++) d.recordTransaction(tx(i));
    const batch = d.transactionsSince(cursor);
    cursor = d.transactionTotal;
    expect(batch.map((t) => t.traceId)).toEqual(Array.from({ length: 10 }, (_, i) => `t${5000 + i}`));
    // A consumer that only compares lengths would have seen no change at all here.
    expect(d.recentTransactions(5000).length).toBe(5000);
  });

  it('never returns a record twice when the cursor lags behind a trim', () => {
    const d = new DiagnosticsStore();
    for (let i = 0; i < 4990; i++) d.recordTransaction(tx(i));
    const stale = d.transactionTotal; // consumer stops reading here
    for (let i = 4990; i < 5200; i++) d.recordTransaction(tx(i));
    const batch = d.transactionsSince(stale);
    // records before the trim point that are still in the ring are delivered once
    expect(batch.length).toBe(210);
    expect(batch[0]?.traceId).toBe('t4990');
    expect(batch[batch.length - 1]?.traceId).toBe('t5199');
    expect(new Set(batch.map((t) => t.traceId)).size).toBe(batch.length);
  });

  it('does the same for parse events', () => {
    const d = new DiagnosticsStore();
    let cursor = 0;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      d.recordParseEvent(ev(i));
      ids.push(...d.parseEventsSince(cursor).map((e) => e.id));
      cursor = d.parseEventTotal;
    }
    expect(ids.length).toBe(5);
    expect(new Set(ids).size).toBe(5);
    expect(d.parseEventsSince(cursor)).toEqual([]);
  });

  it('tracks the last successful response per connection in O(1)', () => {
    const d = new DiagnosticsStore();
    expect(d.lastOkUtcFor('c1')).toBeNull();
    d.recordTransaction(tx(1, { result: 'timeout', startUtc: 'A' }));
    expect(d.lastOkUtcFor('c1')).toBeNull();
    d.recordTransaction(tx(2, { result: 'ok', startUtc: 'B' }));
    expect(d.lastOkUtcFor('c1')).toBe('B');
    d.recordTransaction(tx(3, { result: 'ok', connectionId: 'c2', startUtc: 'C' }));
    expect(d.lastOkUtcFor('c1')).toBe('B');
    expect(d.lastOkUtcFor('c2')).toBe('C');
    d.recordTransaction(tx(4, { result: 'exception', startUtc: 'D' }));
    expect(d.lastOkUtcFor('c1')).toBe('B');
  });

  it('clear() empties the rings but keeps cursors monotonic so held cursors stay valid', () => {
    const d = new DiagnosticsStore();
    for (let i = 0; i < 5; i++) d.recordTransaction(tx(i));
    const before = d.transactionTotal;
    d.clear();
    expect(d.recentTransactions(100)).toEqual([]);
    expect(d.transactionTotal).toBe(before);
    expect(d.transactionsSince(before)).toEqual([]);
    expect(d.lastOkUtcFor('c1')).toBeNull();
    d.recordTransaction(tx(9));
    expect(d.transactionsSince(before).map((t) => t.traceId)).toEqual(['t9']);
  });
});

describe('DiagnosticsStore health series', () => {
  const sample = (t: number, busLoadPercent: number, p95Ms: number) => ({ t, busLoadPercent, p95Ms, requestRatePerSec: 5 });

  it('keeps samples ordered per connection and filters by window', () => {
    const d = new DiagnosticsStore();
    const now = 1_000_000;
    for (let i = 0; i < 10; i++) d.recordHealthSample('c1', sample(now - (9 - i) * 1000, i, i * 2));
    d.recordHealthSample('c2', sample(now, 42, 7));
    const all = d.healthSeriesFor('c1', 60_000, now);
    expect(all.length).toBe(10);
    expect(all[0]?.t).toBe(now - 9000);
    expect(all[9]?.busLoadPercent).toBe(9);
    // trailing window only
    expect(d.healthSeriesFor('c1', 3000, now).map((s) => s.t)).toEqual([now - 3000, now - 2000, now - 1000, now]);
    expect(d.healthSeriesFor('c2', 60_000, now).length).toBe(1);
    expect(d.healthSeriesFor('missing', 60_000, now)).toEqual([]);
  });

  it('ignores duplicate / out-of-order timestamps so a repeated computation cannot fake history', () => {
    const d = new DiagnosticsStore();
    d.recordHealthSample('c1', sample(5000, 1, 1));
    d.recordHealthSample('c1', sample(5000, 9, 9));
    d.recordHealthSample('c1', sample(4000, 8, 8));
    const s = d.healthSeriesFor('c1', 60_000, 5000);
    expect(s.length).toBe(1);
    expect(s[0]?.busLoadPercent).toBe(1);
  });

  it('bounds the ring at 600 samples (10 minutes at 1 Hz)', () => {
    const d = new DiagnosticsStore();
    for (let i = 0; i < 700; i++) d.recordHealthSample('c1', sample(i * 1000, i % 100, i % 50));
    const all = d.healthSeriesFor('c1', 10_000_000, 700_000);
    expect(all.length).toBe(600);
    expect(all[all.length - 1]?.t).toBe(699_000);
    expect(all[0]?.t).toBe(100_000);
  });

  it('clear() drops the series as well', () => {
    const d = new DiagnosticsStore();
    d.recordHealthSample('c1', sample(1000, 1, 1));
    d.clear();
    expect(d.healthSeriesFor('c1', 60_000, 5000)).toEqual([]);
  });
});
