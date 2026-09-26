import { expect, it, vi } from 'vitest';
import { ConnectionRuntime } from '../../src/main/runtime/connection-runtime';
import { BlockCache } from '../../src/main/runtime/block-cache';
import { DiagnosticsStore } from '../../src/main/runtime/diagnostics';
import { FakeTransport, hex } from '../support/fake';
import { buildRtuAdu, encodeResponsePdu } from '../../src/domain/protocol';

it('stopped RTU scan drains a late response before the queued read uses the same Unit/FC', async () => {
  const transport = new FakeTransport('rtu');
  const diagnostics = new DiagnosticsStore();
  const runtime = new ConnectionRuntime({
    config: { id: 'rtu', name: 'RTU', transport: 'rtu', timeoutMs: 100, retries: 2, reconnect: 'manual', interFrameMs: 0, rtsControl: 'none', logLevel: 'info' },
    transport, cache: new BlockCache(), diagnostics, hooks: { onChange: () => undefined, onState: () => undefined },
  });
  const response = (value: number) => buildRtuAdu(1, encodeResponsePdu({ kind: 'registers', fc: 3, registers: [value] }));
  await runtime.start();
  try {
    const scan = runtime.scanUnits({ from: 1, to: 247 }, { timeoutMs: 20 });
    const next = runtime.temporaryRead(1, 3, 0, 1);
    runtime.stopScan();
    await scan;
    expect(transport.sent).toHaveLength(1);
    transport.inject(response(99));
    transport.onResponse(() => [response(7)]);
    const outcome = await next;
    expect(outcome.result).toBe('ok');
    expect(outcome.response?.kind === 'registers' && outcome.response.registers).toEqual([7]);
    expect(diagnostics.recentTransactions(10).filter(tx => tx.sourceKind === 'scanner')).toHaveLength(1);
    expect(diagnostics.recentParseEvents(10).some(ev => ev.kind === 'unexpected')).toBe(true);
  } finally { await runtime.stop(); }
});

it('ordinary RTU timeout drains a late same-Unit/same-FC reply before the next read', async () => {
  const transport = new FakeTransport('rtu');
  const diagnostics = new DiagnosticsStore();
  const runtime = new ConnectionRuntime({
    config: { id: 'rtu', name: 'RTU', transport: 'rtu', timeoutMs: 30, retries: 0, reconnect: 'manual', interFrameMs: 0, rtsControl: 'none', logLevel: 'info' },
    transport, cache: new BlockCache(), diagnostics, hooks: { onChange: () => undefined, onState: () => undefined },
  });
  const response = (value: number) => buildRtuAdu(1, encodeResponsePdu({ kind: 'registers', fc: 3, registers: [value] }));
  await runtime.start();
  try {
    const first = runtime.temporaryRead(1, 3, 0, 1);
    const second = runtime.temporaryRead(1, 3, 0, 1);
    const timedOut = await first;
    expect(timedOut.result).toBe('timeout');
    expect(transport.sent).toHaveLength(1);
    const stale = response(99);
    transport.inject(stale);
    transport.onResponse(() => [response(7)]);
    const current = await second;
    expect(current.result).toBe('ok');
    expect(current.response?.kind === 'registers' && current.response.registers).toEqual([7]);
    expect(transport.sent).toHaveLength(2);
    expect(diagnostics.recentTransactions(2).map((tx) => tx.result)).toEqual(['timeout', 'ok']);
    expect(diagnostics.recentTransactions(2).map((tx) => tx.requestPduHex)).toEqual(['0300000001', '0300000001']);
    expect(diagnostics.recentTransactions(2).map((tx) => tx.responsePduHex)).toEqual([null, '03020007']);
    const late = diagnostics.recentParseEvents(10).find((ev) => ev.rawHex === hex(stale));
    expect(late).toMatchObject({
      connectionId: 'rtu', kind: 'unexpected', reason: expect.stringContaining('bounded drain'),
      rawHex: hex(stale), discarded: stale.length, recoveredCount: 0,
      traceId: timedOut.traceId, unitId: 1, functionCode: 3, sourceKind: 'temporary-read',
    });
  } finally { await runtime.stop(); }
});

it('records RTU resync prefix bytes and recovered frame count without inventing a request owner', async () => {
  const transport = new FakeTransport('rtu');
  const diagnostics = new DiagnosticsStore();
  const runtime = new ConnectionRuntime({
    config: { id: 'rtu', name: 'RTU', transport: 'rtu', timeoutMs: 50, retries: 0, reconnect: 'manual', interFrameMs: 0, rtsControl: 'none', logLevel: 'info' },
    transport, cache: new BlockCache(), diagnostics, hooks: { onChange: () => undefined, onState: () => undefined },
  });
  await runtime.start();
  try {
    const good = buildRtuAdu(1, encodeResponsePdu({ kind: 'registers', fc: 3, registers: [7] }));
    transport.inject(new Uint8Array([0x7f, ...good]));
    const resync = diagnostics.recentParseEvents(10).find((event) => event.reason.includes('resync'));
    expect(resync).toMatchObject({
      connectionId: 'rtu', kind: 'malformed',
      rawHex: '7f', discarded: 1, recoveredCount: 1,
      traceId: null, unitId: null, functionCode: null, sourceKind: null,
    });
    expect(diagnostics.recentParseEvents(10)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'unexpected', rawHex: hex(good), discarded: good.length }),
    ]));
  } finally { await runtime.stop(); }
});

it('an RTU write timeout drains its late ack, reads back once and still reports an unknown write result', async () => {
  const transport = new FakeTransport('rtu');
  const diagnostics = new DiagnosticsStore();
  const cache = new BlockCache();
  const runtime = new ConnectionRuntime({
    config: { id: 'rtu', name: 'RTU', transport: 'rtu', timeoutMs: 30, retries: 0, reconnect: 'manual', interFrameMs: 0, rtsControl: 'none', logLevel: 'info' },
    transport, cache, diagnostics, hooks: { onChange: () => undefined, onState: () => undefined },
  });
  const slave = { id: 's1', connectionId: 'rtu', unitId: 1, name: 'S', templateId: 't1', enabled: true };
  const block = { id: 'b1', name: 'B', area: 3 as const, start: 0, length: 1, periodMs: 1000 };
  const mapping = { rawType: 'Int16' as const, offset: 0, registerCount: 1, wordOrder: 'ABCD' as const,
    byteSelector: 'low' as const, bitOffset: 0, bitWidth: 16, stringLength: 0, stringEncoding: 'ascii' as const };
  cache.ensure(slave, block);
  const ack = buildRtuAdu(1, encodeResponsePdu({ kind: 'writeAck', fc: 6, address: 0, extra: 42 }));
  const read = buildRtuAdu(1, encodeResponsePdu({ kind: 'registers', fc: 3, registers: [42] }));
  transport.onResponse((request) => request[1] === 6 ? null : [read]);
  const recordTransaction = diagnostics.recordTransaction.bind(diagnostics);
  const recordSpy = vi.spyOn(diagnostics, 'recordTransaction').mockImplementation((transaction) => {
    recordTransaction(transaction);
    // Deliver the late ack at the precise timeout boundary, inside the quiet window.
    if (transaction.sourceKind === 'write' && transaction.result === 'timeout') transport.inject(ack);
  });
  await runtime.start();
  try {
    const outcome = await runtime.writePoint({ slave, block, mapping, rawValue: 42, pointId: 'p1', readBackRange: { start: 0, length: 1 } });
    const timedOutWrite = diagnostics.recentTransactions(10).find((tx) => tx.sourceKind === 'write' && tx.result === 'timeout');
    expect(timedOutWrite).toBeDefined();
    expect(outcome.result).toBe('timeout');
    expect(outcome.readBack?.result).toBe('ok');
    expect(outcome.readBack?.response?.kind === 'registers' && outcome.readBack.response.registers).toEqual([42]);
    expect(transport.sent.map((request) => request[1])).toEqual([6, 3]);
    expect(diagnostics.recentTransactions(10).filter((tx) => tx.sourceKind === 'readback')).toHaveLength(1);
    expect(diagnostics.recentParseEvents(10)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'unexpected', rawHex: hex(ack), discarded: ack.length, traceId: timedOutWrite?.traceId }),
    ]));
    const confirmed = cache.get('s1::b1')?.memory;
    expect(confirmed?.kind === 'registers' && confirmed.registers[0]).toBe(42);
  } finally { recordSpy.mockRestore(); await runtime.stop(); }
});
