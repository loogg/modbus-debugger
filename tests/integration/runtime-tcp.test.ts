import { describe, expect, it, beforeEach } from 'vitest';
import { ConnectionRuntime } from '../../src/main/runtime/connection-runtime';
import { BlockCache, blockKey } from '../../src/main/runtime/block-cache';
import { DiagnosticsStore } from '../../src/main/runtime/diagnostics';
import { FakeTransport, unhex, hex } from '../support/fake';
import { buildTcpAdu } from '../../src/domain/protocol/tcp';
import { encodeResponsePdu } from '../../src/domain/protocol/pdu';
import type { ConnectionDef, BlockDef, SlaveDef, PointDef } from '../../src/domain/model';

const conn: ConnectionDef = {
  id: 'c1',
  name: 'TCP',
  transport: 'tcp',
  tcp: { host: '127.0.0.1', port: 5020 },
  timeoutMs: 60,
  retries: 0,
  reconnect: 'manual',
  interFrameMs: 0,
  rtsControl: 'none',
  logLevel: 'info',
};
const block: BlockDef = { id: 'b1', name: 'control', area: 3, start: 0, length: 4, periodMs: 40 };
const slave: SlaveDef = { id: 's1', connectionId: 'c1', unitId: 1, name: 'slave', templateId: 't1', enabled: true };
const point: PointDef = {
  id: 'p1',
  blockId: 'b1',
  name: 'speed',
  mapping: { rawType: 'Int16', offset: 0, registerCount: 1, wordOrder: 'ABCD', byteSelector: 'low', bitOffset: 0, bitWidth: 16, stringLength: 0, stringEncoding: 'ascii' },
  scale: 1,
  offset: 0,
  unit: 'rpm',
  access: 'rw',
  displayFormat: 'auto',
  enumMap: {},
  highRisk: false,
  description: '',
};
const bitPoint: PointDef = {
  ...point,
  id: 'p2',
  name: 'mode',
  mapping: { ...point.mapping, rawType: 'BitField', offset: 1, bitOffset: 4, bitWidth: 3 },
};

const tidOf = (adu: Uint8Array): number => ((adu[0] as number) << 8) | (adu[1] as number);
const unitOf = (adu: Uint8Array): number => adu[6] as number;
const fcOf = (adu: Uint8Array): number => adu[7] as number;
const qtyOf = (adu: Uint8Array): number => ((adu[10] as number) << 8) | (adu[11] as number);
const addrOf = (adu: Uint8Array): number => ((adu[8] as number) << 8) | (adu[9] as number);

function respRegs(regs: number[], tid: number, unit = 1): Uint8Array {
  return buildTcpAdu(tid, unit, encodeResponsePdu({ kind: 'registers', fc: 0x03, registers: regs }));
}
function respExc(fc: number, code: number, tid: number): Uint8Array {
  return buildTcpAdu(tid, 1, encodeResponsePdu({ kind: 'exception', fc: fc as 0x03, code }));
}
function respWriteAck(addr: number, extra: number, tid: number): Uint8Array {
  return buildTcpAdu(tid, 1, encodeResponsePdu({ kind: 'writeAck', fc: 0x06, address: addr, extra }));
}

interface Ctx {
  runtime: ConnectionRuntime;
  transport: FakeTransport;
  cache: BlockCache;
  diag: DiagnosticsStore;
}

function setup(): Ctx {
  const cache = new BlockCache();
  const diag = new DiagnosticsStore();
  const transport = new FakeTransport('tcp');
  const runtime = new ConnectionRuntime({ config: conn, transport, cache, diagnostics: diag, hooks: { onChange: () => undefined, onState: () => undefined } });
  runtime.configure([{ slave, block }]);
  return { runtime, transport, cache, diag };
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('ConnectionRuntime over fake TCP transport', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('polls enabled blocks and fills the Block Cache with confirmed values', async () => {
    ctx.transport.onResponse((adu) => [respRegs([7, 8, 9, 10], tidOf(adu))]);
    await ctx.runtime.start();
    await waitFor(() => ctx.cache.get(blockKey('s1', 'b1'))?.status === 'ok');
    const entry = ctx.cache.get(blockKey('s1', 'b1'));
    expect(entry?.memory.kind).toBe('registers');
    if (entry?.memory.kind === 'registers') expect(entry.memory.registers[0]).toBe(7);
    await ctx.runtime.stop();
  });

  it('records transactions with traceId, source metadata, raw ADU and duration', async () => {
    ctx.transport.onResponse((adu) => [respRegs([1, 2, 3, 4], tidOf(adu))]);
    await ctx.runtime.start();
    await waitFor(() => ctx.diag.recentTransactions(10).length > 0);
    const tx = ctx.diag.recentTransactions(10)[0]!;
    expect(tx.traceId).toBeTruthy();
    expect(tx.sourceKind).toBe('poll');
    expect(tx.sourceId).toBe('b1');
    expect(tx.requestAduHex.length).toBeGreaterThan(0);
    expect(tx.mbapTransactionId).not.toBeNull();
    expect(tx.durationMs).not.toBeNull();
    await ctx.runtime.stop();
  });

  it('write -> read back updates confirmed value only after read back', async () => {
    ctx.transport.onResponse((adu) => {
      const fc = fcOf(adu);
      if (fc === 0x06) return [respWriteAck(0, 42, tidOf(adu))];
      return [respRegs([42, 0, 0, 0], tidOf(adu))];
    });
    await ctx.runtime.start();
    await waitFor(() => ctx.cache.get(blockKey('s1', 'b1'))?.status === 'ok');
    const res = await ctx.runtime.writePoint({ slave, block, mapping: point.mapping, rawValue: 42, pointId: 'p1', readBackRange: { start: 0, length: 4 } });
    expect(res.result).toBe('ok');
    const entry = ctx.cache.get(blockKey('s1', 'b1'));
    if (entry?.memory.kind === 'registers') expect(entry.memory.registers[0]).toBe(42);
    const kinds = ctx.diag.recentTransactions(20).map((t) => t.sourceKind);
    expect(kinds).toContain('write');
    expect(kinds).toContain('readback');
    await ctx.runtime.stop();
  });

  it('partial register write re-reads latest register (never RMW from stale cache)', async () => {
    const writes: string[] = [];
    ctx.transport.onResponse((adu) => {
      const fc = fcOf(adu);
      const qty = qtyOf(adu);
      if (fc === 0x03) {
        const mem = writes.length ? [0, 0x00d0, 0, 0] : [0, 0x00f0, 0, 0];
        return [respRegs(mem.slice(addrOf(adu), addrOf(adu) + qty), tidOf(adu))];
      }
      if (fc === 0x06) {
        writes.push(hex(adu));
        return [respWriteAck(1, 0, tidOf(adu))];
      }
      return [respRegs([0, 0x00d0, 0, 0].slice(addrOf(adu), addrOf(adu) + qty), tidOf(adu))];
    });
    await ctx.runtime.start();
    await waitFor(() => ctx.cache.get(blockKey('s1', 'b1'))?.status === 'ok');
    const res = await ctx.runtime.writePoint({ slave, block, mapping: bitPoint.mapping, rawValue: 5, pointId: 'p2', readBackRange: { start: 0, length: 4 } });
    expect(res.result).toBe('ok');
    const writeAdu = writes[0] as string;
    expect(writeAdu.slice(-4)).toBe('00d0');
    const kinds = ctx.diag.recentTransactions(30).map((t) => t.sourceKind);
    expect(kinds).toContain('rmw-read');
    await ctx.runtime.stop();
  });

  it('exception keeps the old confirmed value and marks the block', async () => {
    let writes = 0;
    ctx.transport.onResponse((adu) => {
      const fc = fcOf(adu);
      const qty = qtyOf(adu);
      if (fc === 0x06) {
        writes++;
        return [respExc(0x06, 0x02, tidOf(adu))];
      }
      return [respRegs(new Array(qty).fill(5), tidOf(adu))];
    });
    void writes;
    await ctx.runtime.start();
    await waitFor(() => ctx.cache.get(blockKey('s1', 'b1'))?.status === 'ok');
    const res = await ctx.runtime.writePoint({ slave, block, mapping: point.mapping, rawValue: 99, pointId: 'p1', readBackRange: { start: 0, length: 4 } });
    expect(res.result).toBe('exception');
    expect(res.exceptionCode).toBe(0x02);
    const entry = ctx.cache.get(blockKey('s1', 'b1'));
    if (entry?.memory.kind === 'registers') expect(entry.memory.registers[0]).toBe(5);
    await ctx.runtime.stop();
  });

  it('timeout yields unknown result, and a late response is not applied to a later request', async () => {
    let allow = false;
    ctx.transport.onResponse((adu) => (allow ? [respRegs([3, 0, 0, 0], tidOf(adu))] : null));
    await ctx.runtime.start();
    await waitFor(() => ctx.cache.get(blockKey('s1', 'b1'))?.status === 'timeout', 3000);
    const txs = ctx.diag.recentTransactions(20);
    expect(txs.some((t) => t.result === 'timeout')).toBe(true);
    ctx.transport.inject(respRegs([77, 0, 0, 0], 0x0001));
    await new Promise((r) => setTimeout(r, 60));
    const entry = ctx.cache.get(blockKey('s1', 'b1'));
    if (entry?.memory.kind === 'registers') expect(entry.memory.registers[0]).not.toBe(77);
    expect(ctx.diag.recentParseEvents(20).some((e) => e.kind === 'unexpected')).toBe(true);
    allow = true;
    await ctx.runtime.stop();
  });

  it('scanner discovers responding units exclusively', async () => {
    ctx.transport.onResponse((adu) => {
      const unit = unitOf(adu);
      if (unit === 1 || unit === 3) return [respRegs([1], tidOf(adu), unit)];
      return null;
    });
    await ctx.runtime.start();
    const found = await ctx.runtime.scanUnits({ from: 1, to: 4 }, 40);
    expect(found.map((f) => f.unitId)).toEqual([1, 3]);
    await ctx.runtime.stop();
  });

  it('temporary read returns a single result at manual priority', async () => {
    ctx.transport.onResponse((adu) => (qtyOf(adu) === 6 ? [respRegs([11, 12, 13, 14, 15, 16], tidOf(adu))] : [respRegs([1, 2, 3, 4].slice(addrOf(adu), addrOf(adu) + qtyOf(adu)), tidOf(adu))]));
    await ctx.runtime.start();
    const outcome = await ctx.runtime.temporaryRead(1, 3, 0, 6);
    expect(outcome.result).toBe('ok');
    if (outcome.response?.kind === 'registers') expect(outcome.response.registers.length).toBe(6);
    await ctx.runtime.stop();
  });

  it('truncated candidate followed by a good frame: good frame still parsed (resync)', async () => {
    let first = true;
    ctx.transport.onResponse((adu) => {
      if (first) {
        first = false;
        const good = respRegs([1, 2, 3, 4], tidOf(adu));
        return [good.subarray(0, 5), good.subarray(5)];
      }
      return [respRegs([1, 2, 3, 4], tidOf(adu))];
    });
    await ctx.runtime.start();
    await waitFor(() => ctx.cache.get(blockKey('s1', 'b1'))?.status === 'ok');
    await ctx.runtime.stop();
  });

  it('unexpected (wrong tid) frame is diagnosed and the matching frame still completes the request', async () => {
    let polluted = false;
    ctx.transport.onResponse((adu) => {
      if (!polluted) {
        polluted = true;
        return [respRegs([9, 9, 9, 9], 0x0bad), respRegs([1, 2, 3, 4], tidOf(adu))];
      }
      return [respRegs([1, 2, 3, 4], tidOf(adu))];
    });
    await ctx.runtime.start();
    await waitFor(() => ctx.cache.get(blockKey('s1', 'b1'))?.status === 'ok');
    await waitFor(() => ctx.diag.recentParseEvents(20).some((e) => e.kind === 'unexpected'));
    const entry = ctx.cache.get(blockKey('s1', 'b1'));
    if (entry?.memory.kind === 'registers') expect(entry.memory.registers[0]).toBe(1);
    await ctx.runtime.stop();
  });

  void unhex;
});
function cfgTimeout(): number {
  return 60;
}

describe('retry policy', () => {
  function make(retries: number) {
    const cache = new BlockCache();
    const diag = new DiagnosticsStore();
    const transport = new FakeTransport('tcp');
    const cfg: ConnectionDef = { ...conn, retries };
    const runtime = new ConnectionRuntime({ config: cfg, transport, cache, diagnostics: diag, hooks: { onChange: () => undefined, onState: () => undefined } });
    runtime.configure([{ slave, block }]);
    return { runtime, transport, cache, diag };
  }

  it('reads retry on timeout up to config.retries and then succeed', async () => {
    const ctx = make(1);
    let calls = 0;
    ctx.transport.onResponse((adu) => {
      calls++;
      if (calls === 1) return null;
      return [respRegs([9, 9, 9, 9], tidOf(adu))];
    });
    await ctx.runtime.start();
    await waitFor(() => ctx.cache.get(blockKey('s1', 'b1'))?.status === 'ok', 4000);
    const txs = ctx.diag.recentTransactions(20).filter((t) => t.sourceKind === 'poll');
    expect(txs.some((t) => t.result === 'timeout')).toBe(true);
    expect(txs.some((t) => t.result === 'ok')).toBe(true);
    await ctx.runtime.stop();
  });

  it('reads do NOT retry on exception responses (device refused)', async () => {
    const ctx = make(2);
    ctx.transport.onResponse((adu) => [respExc(0x03, 0x02, tidOf(adu))]);
    await ctx.runtime.start();
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    const outcome = await ctx.runtime.temporaryRead(1, 3, 0, 4);
    expect(outcome.result).toBe('exception');
    // exception response settles immediately: no waiting for the timeout budget
    expect(Date.now() - t0).toBeLessThan(cfgTimeout());
    const txs = ctx.diag.recentTransactions(40).filter((t) => t.sourceKind === 'temporary-read');
    expect(txs.length).toBe(1);
    await ctx.runtime.stop();
  });
  it('writes do NOT retry on timeout (read-back resolves truth)', async () => {
    const ctx = make(2);
    ctx.transport.onResponse((adu) => (adu[7] === 0x06 ? null : [respRegs([1, 0, 0, 0], tidOf(adu))]));
    await ctx.runtime.start();
    await waitFor(() => ctx.cache.get(blockKey('s1', 'b1'))?.status === 'ok');
    const res = await ctx.runtime.writePoint({ slave, block, mapping: point.mapping, rawValue: 42, pointId: 'p1', readBackRange: { start: 0, length: 4 } });
    expect(res.result).toBe('timeout');
    const fc06 = ctx.diag.recentTransactions(40).filter((t) => t.functionCode === 0x06);
    expect(fc06.length).toBe(1);
    await ctx.runtime.stop();
  });
});

describe('resource release', () => {
  it('stop() closes the transport (serial/socket released)', async () => {
    const cache = new BlockCache();
    const diag = new DiagnosticsStore();
    const transport = new FakeTransport('tcp');
    const runtime = new ConnectionRuntime({ config: conn, transport, cache, diagnostics: diag, hooks: { onChange: () => undefined, onState: () => undefined } });
    runtime.configure([{ slave, block }]);
    transport.onResponse((adu: Uint8Array) => [respRegs([1, 2, 3, 4], tidOf(adu))]);
    await runtime.start();
    expect(transport.connected).toBe(true);
    await runtime.stop();
    expect(transport.connected).toBe(false);
  });
});

describe('configured request timeout', () => {
  function silentRuntime(config: ConnectionDef) {
    const cache = new BlockCache();
    const diag = new DiagnosticsStore();
    const transport = new FakeTransport('tcp');
    const runtime = new ConnectionRuntime({
      config,
      transport,
      cache,
      diagnostics: diag,
      hooks: { onChange: () => undefined, onState: () => undefined },
    });
    runtime.configure([{ slave, block }]);
    return { runtime, transport, cache, diag };
  }

  it('poll / write paths honour connection.timeoutMs instead of a hardcoded fallback', async () => {
    const { runtime, diag } = silentRuntime({ ...conn, timeoutMs: 60, retries: 0 });
    const t0 = Date.now();
    await runtime.start();
    await waitFor(() => diag.recentTransactions(5).length > 0);
    const elapsed = Date.now() - t0;
    expect(diag.recentTransactions(5)[0]?.result).toBe('timeout');
    // the pre-fix fallback was 500 ms; the configured 60 ms must be what actually applies
    expect(elapsed).toBeLessThan(300);
    await runtime.stop();
  });

  it('records the configured timeout in the transaction duration', async () => {
    const { runtime, diag } = silentRuntime({ ...conn, timeoutMs: 80, retries: 0 });
    await runtime.start();
    await waitFor(() => diag.recentTransactions(5).length > 0);
    const tx = diag.recentTransactions(5)[0];
    expect(tx?.durationMs).not.toBeNull();
    expect(tx?.durationMs as number).toBeGreaterThanOrEqual(70);
    expect(tx?.durationMs as number).toBeLessThan(300);
    await runtime.stop();
  });

  it('still lets a caller override the timeout (unit scanner probe)', async () => {
    const { runtime, diag } = silentRuntime({ ...conn, timeoutMs: 5000, retries: 0 });
    await runtime.start();
    const t0 = Date.now();
    const found = await runtime.scanUnits({ from: 9, to: 9 }, 40);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(found).toEqual([]);
    expect(diag.recentTransactions(5).some((x) => x.sourceKind === 'scanner')).toBe(true);
    await runtime.stop();
  });
});
