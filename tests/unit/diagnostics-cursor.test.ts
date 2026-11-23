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
  it('bounds a large detail page by bytes and continues from its unconsumed cursor', () => {
    const diagnostics = new DiagnosticsStore();
    const before = diagnostics.read({ type: 'diagnostics.read', limit: 500 });
    for (let index = 0; index < 100; index++) diagnostics.recordTransaction(tx(index, { requestAduHex: '00'.repeat(4096) }));
    const page = diagnostics.read({ type: 'diagnostics.read', generation: before.generation, afterTransactions: before.transactionCursor, limit: 500 });
    expect(page.transactions.length).toBeLessThan(100);
    expect(Buffer.byteLength(JSON.stringify(page.transactions))).toBeLessThan(129 * 1024);
    const next = diagnostics.read({ type: 'diagnostics.read', afterTransactions: page.transactionCursor, throughTransactions: page.throughTransactions, limit: 500 });
    expect(next.transactions[0]!.traceId).toBe(`t${page.transactions.length}`);
  });
  it('keeps a full time window after detail records are overwritten and isolates connections', () => {
    const diagnostics = new DiagnosticsStore();
    for (let index = 1; index <= 12000; index++) {
      diagnostics.recordTransaction(tx(index, { startMono: index * 5 }));
      diagnostics.recordTransaction(tx(index, { startMono: index * 5, connectionId: 'c2', result: 'timeout' }));
    }
    expect(diagnostics.recentTransactions(20000)).toHaveLength(5000);
    expect(diagnostics.health('c1', 60000, [])).toMatchObject({ requestRatePerSec: 200, timeouts: 0 });
    diagnostics.health('c1', 60000, [], 1);
    expect(diagnostics.health('c1', 60000, []).requestRatePerSec).toBe(200);
    expect(diagnostics.health('c2', 60000, [])).toMatchObject({ requestRatePerSec: 200, timeouts: 12000 });
    expect(diagnostics.health('c1', 120001, []).requestRatePerSec).toBe(0);
    diagnostics.clear();
    expect(diagnostics.health('c2', 60000, []).timeouts).toBe(0);
  });
  it('uses actual serial framing and exposes TCP byte throughput', () => {
    const diagnostics = new DiagnosticsStore();
    diagnostics.recordTransaction(tx(1000, { requestAduHex: '00'.repeat(60), responseAduHex: '00'.repeat(60) }));
    const rtu = { transport: 'rtu' as const, rtu: { port: 'test', baudRate: 1200, dataBits: 8 as const, parity: 'even' as const, stopBits: 1 as const } };
    expect(diagnostics.health('c1', 1000, [], 1, rtu).busLoadPercent).toBe(100);
    expect(diagnostics.health('c1', 1000, [], 1, { ...rtu, rtu: { ...rtu.rtu, baudRate: 2400 } }).busLoadPercent).toBeCloseTo(55);
    expect(diagnostics.health('c1', 1000, [], 1, { ...rtu, rtu: { ...rtu.rtu, baudRate: 2400, parity: 'none' } }).busLoadPercent).toBeCloseTo(50);
    expect(diagnostics.health('c1', 1000, [], 1, { transport: 'tcp' })).toMatchObject({ throughputBytesPerSec: 120, busLoadPercent: 0, transport: 'tcp' });
  });
  it('pages scoped details through overwrites and a clear without consuming other readers', () => {
    const diagnostics = new DiagnosticsStore();
    const first = diagnostics.read({ type: 'diagnostics.read', connectionId: 'c1', limit: 2 });
    for (let index = 0; index < 8; index++) diagnostics.recordTransaction(tx(index));
    const page = diagnostics.read({ type: 'diagnostics.read', connectionId: 'c1', generation: first.generation, afterTransactions: first.transactionCursor, limit: 2 });
    expect(page.transactions.map(row => row.traceId)).toEqual(['t0', 't1']);
    expect(page.hasMore).toBe(true);
    expect(diagnostics.read({ type: 'diagnostics.read', connectionId: 'c1', generation: first.generation, afterTransactions: 0, limit: 2 }).transactions).toEqual(page.transactions);
    for (let index = 8; index < 5100; index++) diagnostics.recordTransaction(tx(index));
    expect(diagnostics.read({ type: 'diagnostics.read', afterTransactions: page.transactionCursor, throughTransactions: page.throughTransactions, limit: 2 }).overwritten).toBe(true);
    diagnostics.clear();
    expect(diagnostics.read({ type: 'diagnostics.read', generation: page.generation, limit: 2 })).toMatchObject({ reset: true, transactions: [] });
  });
  it('does not combine polling periods, latency or failures across Units sharing one block', () => {
    const diagnostics = new DiagnosticsStore();
    for (const index of [0, 1, 2]) {
      diagnostics.recordTransaction(tx(index * 800, { sourceId: 'shared', unitId: 1, durationMs: 2 }));
      diagnostics.recordTransaction(tx(index * 800 + 400, { sourceId: 'shared', unitId: 2, durationMs: 20, result: index === 2 ? 'timeout' : 'ok' }));
    }
    const blocks = diagnostics.health('c1', 2500, [1, 2].map(unitId => ({ unitId, slaveId: `s${unitId}`, blockId: 'shared', blockName: 'shared', configuredPeriodMs: 800 }))).blocks;
    expect(blocks[0]).toMatchObject({ actualPeriodMs: 800, p95Ms: 2, timeoutRate: 0 });
    expect(blocks[1]).toMatchObject({ actualPeriodMs: 800, p95Ms: 20, timeoutRate: 1 / 3 });
  });
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
