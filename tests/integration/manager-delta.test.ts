import { describe, expect, it } from 'vitest';
import { createScratch } from '../../tools/test-paths.mjs';
import path from 'node:path';
import { RuntimeManager } from '../../src/main/runtime/manager';
import { WorkspaceService } from '../../src/main/services/workspace';
import { HistoryStore } from '../../src/main/services/history';
import { emptyWorkspace, type BlockDef, type ConnectionDef, type PointDef, type SlaveDef, type Workspace } from '../../src/domain/model';
import { FakeTransport } from '../support/fake';
import type { AppDelta } from '../../src/shared/snapshot';
import { commandSchema } from '../../src/shared/commands';
import type { TransactionRecord } from '../../src/main/runtime/diagnostics';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmpDir = () => createScratch('manager-');

const conn: ConnectionDef = {
  id: 'c1',
  name: 'TCP',
  transport: 'tcp',
  tcp: { host: '127.0.0.1', port: 5099 },
  timeoutMs: 50,
  retries: 0,
  reconnect: 'manual',
  interFrameMs: 0,
  rtsControl: 'none',
  logLevel: 'info',
};
const block: BlockDef = { id: 'b1', name: 'control', area: 3, start: 0, length: 4, periodMs: 25 };
const slave: SlaveDef = { id: 's1', connectionId: 'c1', unitId: 1, name: 'slave', templateId: 't1', enabled: true };
const point = (id: string, name: string): PointDef => ({
  id,
  blockId: 'b1',
  name,
  mapping: { rawType: 'UInt16', offset: 0, registerCount: 1, wordOrder: 'ABCD', byteSelector: 'low', bitOffset: 0, bitWidth: 16, stringLength: 0, stringEncoding: 'ascii' },
  scale: 1,
  offset: 0,
  unit: '',
  access: 'rw',
  displayFormat: 'auto',
  enumMap: {},
  highRisk: false,
  description: '',
});

function demoWorkspace(): Workspace {
  return {
    ...emptyWorkspace('delta'),
    connections: [conn],
    slaves: [slave],
    templates: [{ id: 't1', name: 'tpl', version: '1.0', description: '', blocks: [block], points: [point('p1', 'speed'), point('p2', 'torque')] }],
  };
}

async function harness() {
  const dir = tmpDir();
  const svc = new WorkspaceService(dir);
  svc.adopt(demoWorkspace(), null);
  const history = await HistoryStore.open(path.join(dir, 'history.db'));
  const mgr = new RuntimeManager(svc, history, { transportFactory: () => new FakeTransport('tcp') });
  const deltas: AppDelta[] = [];
  mgr.onDelta = (d) => deltas.push(d);
  return { dir, svc, history, mgr, deltas };
}

function txOf(i: number): TransactionRecord {
  return {
    traceId: `pre${i}`,
    connectionId: 'c1',
    unitId: 1,
    functionCode: 3,
    sourceKind: 'poll',
    sourceId: null,
    startUtc: new Date().toISOString(),
    startMono: 0,
    durationMs: 1,
    requestAduHex: '00',
    responseAduHex: null,
    result: 'timeout',
    exceptionCode: null,
    mbapTransactionId: null,
    summary: 'pre',
  };
}

describe('RuntimeManager snapshot / delta pipeline', () => {
  it('publishes scan progress and cancellation without successful polls and preserves it in fresh snapshots', async () => {
    const { mgr, deltas } = await harness();
    mgr.start();
    try {
      await sleep(20);
      const options = { fc: 4, start: 123, timeoutMs: 150, retries: 0 };
      const scanning = mgr.handleCommand(commandSchema.parse({ type: 'device.scan', connectionId: 'c1', from: 1, to: 247, options }));
      await sleep(120);
      expect(deltas.some(d => d.connections?.c1?.scan?.phase === 'running')).toBe(true);
      expect(mgr.buildSnapshot().connections.c1?.scan?.options).toEqual(options);
      const stop = await mgr.handleCommand(commandSchema.parse({ type: 'device.stopScan', connectionId: 'c1' }));
      expect(stop.ok).toBe(true);
      expect(mgr.buildSnapshot().connections.c1?.scan?.phase).toBe('stopping');
      await scanning;
      await sleep(120);
      expect(deltas.some(d => d.connections?.c1?.scan?.phase === 'stopped')).toBe(true);
      const state = mgr.buildSnapshot().connections.c1?.scan;
      expect(state?.phase).toBe('stopped');
      expect(state?.checked).toBeLessThan(247);
    } finally { await mgr.stop(); }
  });

  it('caches the point index against the workspace revision and invalidates it on edit', async () => {
    const { svc, mgr, history } = await harness();
    const first = mgr.pointIndex();
    expect([...first.keys()].sort()).toEqual(['s1::p1', 's1::p2']);
    // Same workspace object => identical Map instance (this ran on every 100 ms tick before).
    expect(mgr.pointIndex()).toBe(first);

    svc.mutate((ws) => ({
      ...ws,
      templates: ws.templates.map((t) => (t.id === 't1' ? { ...t, points: [...t.points, point('p3', 'temp')] } : t)),
    }));
    const second = mgr.pointIndex();
    expect(second).not.toBe(first);
    expect([...second.keys()].sort()).toEqual(['s1::p1', 's1::p2', 's1::p3']);
    expect(mgr.pointIndex()).toBe(second);
    await mgr.stop();
    history.close();
  });

  it('does not re-deliver transactions that were already part of the snapshot', async () => {
    const { mgr, deltas, history } = await harness();
    mgr.diagnostics.recordTransaction(txOf(0));
    mgr.diagnostics.recordTransaction(txOf(1));
    const snap = mgr.buildSnapshot();
    expect(snap.transactions.map((t) => t.traceId)).toEqual(['pre0', 'pre1']);

    mgr.start();
    await sleep(400);
    await mgr.stop();
    history.close();

    const streamed = deltas.flatMap((d) => d.transactions ?? []).map((t) => t.traceId);
    expect(streamed).not.toContain('pre0');
    expect(streamed).not.toContain('pre1');
    // the polling loop kept running against a silent transport, so timeouts were streamed
    expect(streamed.length).toBeGreaterThan(0);
  });

  it('streams each transaction exactly once', async () => {
    const { mgr, deltas, history } = await harness();
    mgr.start();
    await sleep(500);
    await mgr.stop();
    history.close();
    const ids = deltas.flatMap((d) => d.transactions ?? []).map((t) => t.traceId);
    expect(ids.length).toBeGreaterThan(3);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('emits diagRev once after diagnostics.clear so the renderer can drop its rings', async () => {
    const { mgr, deltas, history } = await harness();
    const snap = mgr.buildSnapshot();
    mgr.start();
    await sleep(250);
    const res = await mgr.handleCommand({ type: 'diagnostics.clear' });
    expect(res.ok).toBe(true);
    await sleep(250);
    await mgr.stop();
    history.close();
    const withRev = deltas.filter((d) => d.diagRev !== undefined);
    expect(withRev.length).toBe(1);
    expect(withRev[0]?.diagRev).toBe(snap.diagRev + 1);
    // after the clear the stream restarts from empty and only carries new records
    const cut = deltas.indexOf(withRev[0] as AppDelta);
    const before = deltas.slice(0, cut).flatMap((d) => d.transactions ?? []).map((t) => t.traceId);
    const after = deltas.slice(cut + 1).flatMap((d) => d.transactions ?? []).map((t) => t.traceId);
    expect(before.length).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThan(0);
    // the cursor was re-parked at the (monotonic) total, so nothing is replayed
    expect(after.filter((id) => before.includes(id))).toEqual([]);
  });

  it('publishes connection health at most once per second per connection', async () => {
    const { mgr, deltas, history } = await harness();
    mgr.start();
    await sleep(650);
    await mgr.stop();
    history.close();
    const emissions = deltas.filter((d) => d.health && 'c1' in d.health).length;
    // ~6-7 ticks happened; only the initial (dirty) publish plus the 1 Hz refresh may carry health
    expect(emissions).toBeLessThanOrEqual(2);
    expect(emissions).toBeGreaterThan(0);
  });

  it('records real health samples at 1 Hz and serves them through diagnostics.healthSeries', async () => {
    const { mgr, history } = await harness();
    mgr.start();
    await sleep(2500);
    await mgr.stop();
    history.close();
    const res = await mgr.handleCommand({ type: 'diagnostics.healthSeries', connectionId: 'c1', windowMs: 60000 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const samples = res.value as Array<{ t: number; busLoadPercent: number; p95Ms: number }>;
    // ~2.5 s of 1 Hz sampling: at least two distinct samples, strictly increasing timestamps
    expect(samples.length).toBeGreaterThanOrEqual(2);
    expect(samples.length).toBeLessThanOrEqual(4);
    for (let i = 1; i < samples.length; i++) expect(samples[i]!.t).toBeGreaterThan(samples[i - 1]!.t);
    expect(samples.every((s) => Number.isFinite(s.busLoadPercent) && Number.isFinite(s.p95Ms))).toBe(true);
  });

  it('validates the health series window at the IPC command boundary', () => {
    // registerIpc() runs every renderer command through commandSchema before handleCommand()
    expect(commandSchema.safeParse({ type: 'diagnostics.healthSeries', connectionId: 'c1', windowMs: 300000 }).success).toBe(true);
    expect(commandSchema.safeParse({ type: 'diagnostics.healthSeries', connectionId: 'c1', windowMs: 10 }).success).toBe(false);
    expect(commandSchema.safeParse({ type: 'diagnostics.healthSeries', connectionId: 'c1', windowMs: 99999999 }).success).toBe(false);
    expect(commandSchema.safeParse({ type: 'diagnostics.healthSeries', windowMs: 300000 }).success).toBe(false);
  });

  it('streams a prefs.set change as a delta even while polling floods transactions', async () => {
    const { mgr, deltas, history, svc } = await harness();
    expect(mgr.buildSnapshot().prefs.timezone).toBe('local');

    await mgr.handleCommand(commandSchema.parse({ type: 'connection.connect', connectionId: 'c1' }));
    mgr.start();
    await sleep(300);
    // A silent transport keeps producing timeout transactions: this is the exact condition
    // under which the renderer used to lose prefs changes.
    expect(deltas.some((d) => (d.transactions ?? []).length > 0)).toBe(true);
    deltas.length = 0;

    const res = await mgr.handleCommand(commandSchema.parse({ type: 'prefs.set', patch: { timezone: 'UTC' } }));
    expect(res.ok).toBe(true);
    await sleep(250);
    await mgr.stop();
    history.close();

    const prefsDelta = deltas.find((d) => d.prefs);
    expect(prefsDelta?.prefs?.timezone).toBe('UTC');
    expect(svc.getPrefs().timezone).toBe('UTC');
  });

  it('does not re-emit prefs in every tick once the renderer has them', async () => {
    const { mgr, deltas, history } = await harness();
    mgr.buildSnapshot();
    mgr.start();
    await sleep(300);
    expect(deltas.filter((d) => d.prefs).length).toBe(0);
    await mgr.handleCommand(commandSchema.parse({ type: 'prefs.set', patch: { timezone: 'Asia/Tokyo' } }));
    await sleep(300);
    await mgr.stop();
    history.close();
    expect(deltas.filter((d) => d.prefs).length).toBe(1);
    expect(deltas.find((d) => d.prefs)?.prefs?.timezone).toBe('Asia/Tokyo');
  });

  it('streams the unsaved-workspace flag as a delta', async () => {
    const { dir, mgr, deltas, history, svc } = await harness();
    // adopt() always marks the workspace dirty, so save once to reach a clean baseline
    expect(svc.saveTo(path.join(dir, 'ws.json')).ok).toBe(true);
    const snap = mgr.buildSnapshot();
    expect(snap.dirty).toBe(false);

    mgr.start();
    await sleep(200);
    deltas.length = 0;
    svc.mutate((ws) => ({ ...ws, name: 'renamed' }));
    await sleep(250);
    // read the flag before stop(): stop() flushes the autosave, which legitimately clears it
    const dirtyAfterEdit = svc.isDirty();
    await mgr.stop();
    history.close();

    expect(dirtyAfterEdit).toBe(true);
    expect(deltas.some((d) => d.dirty === true)).toBe(true);
  });

  it('reports the last successful response without scanning the transaction ring', async () => {
    const { mgr, history } = await harness();
    expect(mgr.buildSnapshot().connections['c1']?.lastResponseUtc).toBeNull();
    mgr.diagnostics.recordTransaction({ ...txOf(0), result: 'ok', startUtc: '2026-01-01T00:00:00.000Z' });
    expect(mgr.buildSnapshot().connections['c1']?.lastResponseUtc).toBe('2026-01-01T00:00:00.000Z');
    await mgr.stop();
    history.close();
  });
});


describe('same template bound to multiple slaves', () => {
  it('keeps confirmed values, write targets and recording samples isolated by slave', async () => {
    const { svc, history, mgr } = await harness();
    const values = new Map([[1, 111], [2, 222]]);
    const fake = new FakeTransport('tcp');
    fake.onResponse(adu => {
      const unit = adu[6]!; const fc = adu[7]!;
      if (fc === 6) { values.set(unit, (adu[10]! << 8) | adu[11]!); return [adu.slice()]; }
      if (fc !== 3) return null;
      const count = (adu[10]! << 8) | adu[11]!;
      const reply = Buffer.alloc(9 + count * 2);
      reply[0] = adu[0]!; reply[1] = adu[1]!; reply.writeUInt16BE(3 + count * 2, 4);
      reply[6] = unit; reply[7] = 3; reply[8] = count * 2;
      for (let i = 0; i < count; i++) reply.writeUInt16BE(values.get(unit)!, 9 + i * 2);
      return [reply];
    });
    // This harness manager has not started; the new manager owns the same open store.
    void mgr;
    const ws = demoWorkspace();
    ws.slaves.push({ ...slave, id: 's2', unitId: 2 });
    ws.trendGroups.push({ id: 'g', name: 'isolated', description: '', windowSec: 60, signals: ws.slaves.map(s => ({ id: `sig-${s.id}`, pointRef: { connectionId: 'c1', slaveId: s.id, pointId: 'p1' }, visible: true })) });
    svc.adopt(ws, null);
    const runtime = new RuntimeManager(svc, history, { transportFactory: () => fake });
    runtime.start();
    try {
      await sleep(250);
      let snap = runtime.buildSnapshot();
      expect(snap.points['s1::p1']?.engNumber).toBe(111);
      expect(snap.points['s2::p1']?.engNumber).toBe(222);
      expect((await runtime.handleCommand({ type: 'point.write', slaveId: 's1', pointId: 'p1', engineering: 999, boolValue: null, stringValue: null })).ok).toBe(true);
      await sleep(200);
      snap = runtime.buildSnapshot();
      expect(snap.points['s1::p1']?.engNumber).toBe(999);
      expect(snap.points['s2::p1']?.engNumber).toBe(222);
      expect(snap.blocks['s1::b1']?.registers?.[0]).toBe(999);
      expect(snap.transactions.some(tx => tx.result === 'ok' && tx.responseAduHex)).toBe(true);
      expect(runtime.startRecording('g').ok).toBe(true);
      await sleep(350);
      runtime.stopRecording();
      const session = history.listSessions()[0]!;
      const samples = history.readSamples(session.id);
      expect(samples.filter(s => s.signalId === 'sig-s1').map(s => s.value)).not.toHaveLength(0);
      expect(new Set(samples.filter(s => s.signalId === 'sig-s1').map(s => s.value))).toEqual(new Set([999]));
      expect(new Set(samples.filter(s => s.signalId === 'sig-s2').map(s => s.value))).toEqual(new Set([222]));
      expect((await runtime.handleCommand({ type: 'history.addNote', sessionId: session.id, tMs: 0, text: 'quoted "note", line' })).ok).toBe(true);
      expect(history.readEvents(session.id).at(-1)?.value).toBe('quoted "note", line');
    } finally { await runtime.stop(); history.close(); }
  });
  it('a first-read timeout does not fabricate a confirmed zero', async () => {
    const { mgr, history } = await harness(); mgr.start();
    try { await sleep(200); expect(mgr.buildSnapshot().points['s1::p1']?.hasValue).toBe(false); }
    finally { await mgr.stop(); history.close(); }
  });
});


it('repeated snapshot reads cannot steal pending cache or transaction deltas', async () => {
  const { mgr, history, deltas } = await harness();
  mgr.buildSnapshot(); mgr.start();
  try {
    mgr.diagnostics.recordTransaction(txOf(999));
    mgr.buildSnapshot();
    await sleep(150);
    expect(deltas.flatMap(d => d.transactions ?? []).some(tx => tx.traceId === 'pre999')).toBe(true);
  } finally { await mgr.stop(); history.close(); }
});
