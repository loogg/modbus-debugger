import { expect, it } from 'vitest';
import { ConnectionRuntime } from '../../src/main/runtime/connection-runtime';
import { BlockCache } from '../../src/main/runtime/block-cache';
import { DiagnosticsStore } from '../../src/main/runtime/diagnostics';
import { FakeTransport } from '../support/fake';
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
    const scan = runtime.scanUnits({ from: 1, to: 247 }, 20);
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
