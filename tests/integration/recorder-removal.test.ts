import fs from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createScratch } from '../../tools/test-paths.mjs';
import { legacySessionsForWorkspace, writeLegacyHistoryFixture } from '../../tools/legacy-history-fixture';
import { emptyWorkspace, type Workspace } from '../../src/domain/model';
import { commandSchema } from '../../src/shared/commands';
import type { AppDelta } from '../../src/shared/snapshot';
import type { DataReadResult } from '../../src/shared/point-data';
import { WorkspaceService } from '../../src/main/services/workspace';
import { HistoryStore } from '../../src/main/services/history';
import { RuntimeManager } from '../../src/main/runtime/manager';
import { FakeTransport } from '../support/fake';
import { templateWorkspace } from '../support/template-workspace';

async function setup() {
  const root = createScratch('history-reader-');
  const template = templateWorkspace().templates[0]!;
  const block = template.blocks[0]!;
  const point = { ...template.points[0]!, scale: 1, offset: 0, enumMap: {},
    mapping: { ...template.points[0]!.mapping, rawType: 'UInt16' as const, registerCount: 1, offset: 0, bitOffset: 0, bitWidth: 16 } };
  const workspace: Workspace = { ...emptyWorkspace(),
    connections: [{ id: 'c', name: 'C', transport: 'tcp', tcp: { host: '127.0.0.1', port: 15000 },
      timeoutMs: 500, retries: 0, reconnect: 'manual', interFrameMs: 0, rtsControl: 'none', logLevel: 'info' }],
    slaves: [{ id: 's', connectionId: 'c', unitId: 1, name: 'S', templateId: template.id, enabled: true }],
    templates: [{ ...template, blocks: [block], points: [point] }],
    trendGroups: [{ id: 'g', name: 'G', description: '', windowSec: 60,
      signals: [{ id: 'signal', pointRef: { connectionId: 'c', slaveId: 's', pointId: point.id }, visible: true }] }],
  };
  const sessions = legacySessionsForWorkspace(workspace);
  sessions[0]!.schema[0]!.pointName = '历史点位';
  const dbPath = path.join(root, 'history.db');
  await writeLegacyHistoryFixture(dbPath, sessions);
  const service = new WorkspaceService(root);
  service.adopt(workspace, null);
  const history = await HistoryStore.open(dbPath);
  const manager = new RuntimeManager(service, history, { transportFactory: () => new FakeTransport('tcp') });
  manager.start();
  return { root, manager, history, point, block, dbPath, sessionId: sessions[0]!.id };
}

it('rejects removed session controls and the old raw-communication preference at the shared boundary', () => {
  for (const command of [
    { type: 'trend.startRecording', groupId: 'g' },
    { type: 'trend.stopRecording' },
    { type: 'prefs.set', patch: { persistRawComm: true } },
  ]) expect(commandSchema.safeParse(command).success).toBe(false);
  for (const method of ['createSession', 'endSession', 'insertSamples', 'insertEvents', 'insertRawComm', 'insertTransaction']) {
    expect(Object.getOwnPropertyNames(HistoryStore.prototype)).not.toContain(method);
  }
});

it('migrates the old preference while preserving active display and workspace settings', () => {
  const root = createScratch('old-prefs-');
  fs.writeFileSync(path.join(root, 'prefs.json'), JSON.stringify({ persistRawComm: true, timezone: 'UTC', sidebarWidth: 300, lastWorkspacePath: null }));
  const service = new WorkspaceService(root);
  expect(service.getPrefs()).toMatchObject({ timezone: 'UTC', sidebarWidth: 300 });
  expect(Object.keys(service.getPrefs())).not.toContain('persistRawComm');
  service.updatePrefs({ language: 'zh-CN' });
  expect(JSON.parse(fs.readFileSync(path.join(root, 'prefs.json'), 'utf8'))).toMatchObject({ timezone: 'UTC', sidebarWidth: 300 });
  expect(fs.readFileSync(path.join(root, 'prefs.json'), 'utf8')).not.toContain('persistRawComm');
});

it('uses confirmed point buffers and CSV export while old session samples remain independently readable', async () => {
  const h = await setup();
  try {
    h.manager.cache.applyReadResult(`s::${h.block.id}`, { kind: 'registers', fc: 3, registers: Array(h.block.length).fill(7) as number[] }, 1);
    const result = await h.manager.handleCommand({ type: 'data.read', points: [], blocks: [], buffers: [],
      series: [{ slaveId: 's', pointId: h.point.id, limit: 2000 }] });
    expect(result.ok).toBe(true);
    expect((result as { ok: true; value: DataReadResult }).value.series[`s::${h.point.id}`]!.samples.at(-1)?.value).toBe(7);
    const target = path.join(h.root, 'samples.csv');
    expect((await h.manager.handleCommand({ type: 'buffer.export', path: target, points: [{ slaveId: 's', pointId: h.point.id }] })).ok).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toContain(h.point.name);
    expect(h.history.listSessions()).toHaveLength(1);
    expect(h.history.readSamples(h.sessionId).map(sample => sample.value)).toEqual([1500, 1600]);
    expect(Object.keys(h.manager.buildSnapshot())).not.toContain('recording');
  } finally { await h.manager.stop(); }
});

it('reads old session data and publishes persisted note updates through Main', async () => {
  const h = await setup();
  const deltas: AppDelta[] = [];
  h.manager.onDelta = delta => deltas.push(delta);
  try {
    const data = await h.manager.handleCommand({ type: 'history.sessionData', sessionId: h.sessionId });
    expect(data).toMatchObject({ ok: true, value: { detail: { schema: [expect.objectContaining({ pointName: '历史点位' })] },
      samples: [expect.objectContaining({ value: 1500 }), expect.objectContaining({ value: 1600 })], rawComm: [expect.objectContaining({ direction: 'tx' }), expect.objectContaining({ direction: 'rx' })] } });
    await vi.waitFor(() => expect(deltas.some(delta => delta.sessions)).toBe(true));
    deltas.length = 0;
    expect((await h.manager.handleCommand({ type: 'history.addNote', sessionId: h.sessionId, tMs: 1000, text: '旧会话 "备注",🙂' })).ok).toBe(true);
    await vi.waitFor(() => expect(deltas.some(delta => delta.sessions?.[0]?.eventCount === 1)).toBe(true));
  } finally { await h.manager.stop(); }
  const reopened = await HistoryStore.open(h.dbPath);
  try { expect(reopened.readEvents(h.sessionId).at(-1)?.value).toBe('旧会话 "备注",🙂'); }
  finally { reopened.close(); }
});
