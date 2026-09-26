import { expect, it } from 'vitest';
import path from 'node:path';
import { createScratch } from '../../tools/test-paths.mjs';
import { commandSchema } from '../../src/shared/commands';
import { mutateWorkspace } from '../../src/domain/workspace-mutations';
import { workspaceSchema, type Workspace } from '../../src/domain/model';
import { RuntimeManager } from '../../src/main/runtime/manager';
import { WorkspaceService } from '../../src/main/services/workspace';
import { HistoryStore } from '../../src/main/services/history';
import { FakeTransport } from '../support/fake';
import { templateWorkspace } from '../support/template-workspace';

async function harness(initial = templateWorkspace()) {
  const root = createScratch('workspace-mutations-');
  const workspace = new WorkspaceService(path.join(root, 'data'));
  workspace.adopt(initial, null);
  const history = await HistoryStore.open(path.join(root, 'history.db'));
  const manager = new RuntimeManager(workspace, history, { transportFactory: () => new FakeTransport('tcp') });
  const deltas: Workspace[] = [];
  manager.onDelta = (delta) => { if (delta.workspace) deltas.push(delta.workspace); };
  manager.start();
  return { workspace, manager, deltas };
}

it('applies fine-grained commands to the current Main workspace and publishes each accepted edit', async () => {
  const { workspace, manager, deltas } = await harness();
  try {
    const originalRuntime = manager.runtimeFor('c1');
    const original = workspace.current;
    const connection = { ...original.connections[0]!, id: 'c2', name: 'Second connection' };
    const template = { id: 't3', name: 'Fresh template', version: '1.0', description: '', blocks: [], points: [] };
    const block = { ...original.templates[0]!.blocks[0]!, id: 'b3', length: 10 };
    const point = { ...original.templates[0]!.points[0]!, id: 'p3', blockId: 'b3', mapping: { ...original.templates[0]!.points[0]!.mapping, offset: 0 } };
    const slave = { ...original.slaves[0]!, id: 's4', connectionId: 'c2', unitId: 4, templateId: 't3' };
    const group = { id: 'g2', name: 'Second group', description: '', windowSec: 60, signals: [{ id: 'sig3', visible: true, pointRef: { connectionId: 'c2', slaveId: 's4', pointId: 'p3' } }] };
    const commands = [
      { type: 'connection.upsert', connection },
      { type: 'template.add', template },
      { type: 'template.upsertBlock', templateId: 't3', block },
      { type: 'template.upsertPoint', templateId: 't3', point },
      { type: 'slave.upsert', slave },
      { type: 'trend.upsertGroup', group },
      { type: 'trend.deleteGroup', groupId: 'g2' },
    ];
    const initialRevision = workspace.revision;
    for (const raw of commands) {
      expect(await manager.handleCommand(commandSchema.parse(raw))).toMatchObject({ ok: true });
    }
    expect(workspace.revision).toBe(initialRevision + commands.length);
    expect(deltas).toHaveLength(commands.length);
    expect(manager.runtimeFor('c1')).toBe(originalRuntime);
    expect(workspace.current.connections.map((item) => item.id)).toEqual(['c1', 'c2']);
    expect(workspace.current.templates.find((item) => item.id === 't3')?.points.map((item) => item.id)).toEqual(['p3']);
    expect(workspace.current.slaves.find((item) => item.id === 's4')?.templateId).toBe('t3');
    expect(workspace.current.trendGroups.some((item) => item.id === 'g2')).toBe(false);
    expect(workspace.current.trendGroups.find((item) => item.id === 'g1')).toEqual(original.trendGroups[0]);
  } finally { await manager.stop(); }
});

it('copies IDs safely and imports content without replacing a newer template edit', async () => {
  const { workspace, manager } = await harness();
  try {
    expect(await manager.handleCommand(commandSchema.parse({ type: 'template.copy', sourceTemplateId: 't1', newId: 't3', name: 'Copied template' }))).toMatchObject({ ok: true });
    const source = workspace.current.templates.find((item) => item.id === 't1')!;
    const copy = workspace.current.templates.find((item) => item.id === 't3')!;
    expect(copy.blocks.map((item) => item.id)).not.toEqual(source.blocks.map((item) => item.id));
    expect(copy.points.map((item) => item.id)).not.toEqual(source.points.map((item) => item.id));
    expect(workspaceSchema.safeParse(workspace.current).success).toBe(true);

    const importedBlock = { ...source.blocks[0]!, id: 'b-import', start: 200, length: 4 };
    const importedPoint = { ...source.points[0]!, id: 'p-import', blockId: importedBlock.id, mapping: { ...source.points[0]!.mapping, offset: 0 } };
    expect(await manager.handleCommand(commandSchema.parse({ type: 'template.patchBlock', templateId: 't1', blockId: 'b1', patch: { name: 'newer edit' } }))).toMatchObject({ ok: true });
    expect(await manager.handleCommand(commandSchema.parse({
      type: 'template.importContent', templateId: 't1', blocks: [importedBlock], points: [importedPoint],
    }))).toMatchObject({ ok: true });
    const updated = workspace.current.templates.find((item) => item.id === 't1')!;
    expect(updated.blocks.find((block) => block.id === 'b1')?.name).toBe('newer edit');
    expect(updated.blocks.some((block) => block.id === 'b-import')).toBe(true);
    expect(updated.points.some((point) => point.id === 'Ia')).toBe(true);
    expect(updated.points.some((point) => point.id === 'p-import')).toBe(true);
    expect(workspace.current.templates.find((item) => item.id === 't2')).toEqual(templateWorkspace().templates[1]);
    expect(workspace.current.trendGroups[0]!.signals.map((signal) => signal.id)).toEqual(['a', 'b', 'keep', 'other']);
  } finally { await manager.stop(); }
});

it('rejects duplicate IDs, missing parents and invalid blocks without changing the workspace or emitting a delta', async () => {
  const { workspace, manager, deltas } = await harness();
  try {
    const original = workspace.current;
    const revision = workspace.revision;
    const invalid = [
      { type: 'template.add', template: original.templates[0] },
      { type: 'template.copy', sourceTemplateId: 'missing', newId: 'new', name: 'Copy' },
      { type: 'template.copy', sourceTemplateId: 't1', newId: 't2', name: 'Copy' },
      { type: 'slave.upsert', slave: { ...original.slaves[0], id: 'new', connectionId: 'missing' } },
      { type: 'template.upsertBlock', templateId: 'missing', block: original.templates[0]!.blocks[0] },
      { type: 'template.upsertBlock', templateId: 't1', block: { ...original.templates[0]!.blocks[0], id: 'overlap' } },
      { type: 'template.upsertPoint', templateId: 't1', point: { ...original.templates[1]!.points[0], blockId: 'b1' } },
      { type: 'template.upsertPoint', templateId: 'missing', point: original.templates[0]!.points[0] },
      { type: 'trend.deleteGroup', groupId: 'missing' },
    ];
    for (const raw of invalid) {
      const result = await manager.handleCommand(commandSchema.parse(raw));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
    }
    expect(workspace.current).toBe(original);
    expect(workspace.revision).toBe(revision);
    expect(deltas).toHaveLength(0);
    expect(commandSchema.safeParse({ type: 'connection.upsert', connection: { ...original.connections[0], tcp: { host: '127.0.0.1', port: 0 } } }).success).toBe(false);
  } finally { await manager.stop(); }
});

it('keeps a surviving slave cache intact when an unrelated connection with the same ID is removed', async () => {
  const original = templateWorkspace();
  const survivor = { ...original.slaves[0]!, id: 'c1', connectionId: 'c2', unitId: 4, enabled: false };
  const initial: Workspace = {
    ...original,
    connections: [...original.connections, { ...original.connections[0]!, id: 'c2' }],
    slaves: [...original.slaves, survivor],
  };
  const { workspace, manager } = await harness(initial);
  try {
    manager.cache.applyReadResult('c1::b1', { kind: 'registers', fc: 3, registers: [123] }, 1);
    expect(manager.cache.get('c1::b1')?.status).toBe('ok');
    const reduced = {
      ...workspace.current,
      connections: workspace.current.connections.filter((connection) => connection.id !== 'c1'),
      slaves: workspace.current.slaves.filter((slave) => slave.connectionId !== 'c1'),
    };
    expect(await manager.handleCommand(commandSchema.parse({ type: 'workspace.apply', workspace: reduced }))).toMatchObject({ ok: true });
    expect(manager.cache.get('c1::b1')?.status).toBe('ok');
    expect(manager.cache.get('c1::b1')?.memory).toMatchObject({ kind: 'registers', registers: expect.any(Uint16Array) });
    expect((manager.cache.get('c1::b1')?.memory as { registers: Uint16Array }).registers[0]).toBe(123);
    expect(manager.cache.entriesForSlave('s1')).toHaveLength(0);
  } finally { await manager.stop(); }
});

it('uses the same workspace validation in the pure mutation path used by Browser Review', () => {
  const initial = templateWorkspace();
  const next = mutateWorkspace(initial, { type: 'template.upsertBlock', templateId: 't1', block: { ...initial.templates[0]!.blocks[0]!, name: 'Renamed block' } });
  expect(next.templates[0]!.blocks[0]!.name).toBe('Renamed block');
  expect(initial.templates[0]!.blocks[0]!.name).toBe('控制寄存器');
});

it('applies successive block and trend edits to Main current state without losing earlier edits', async () => {
  const { workspace, manager } = await harness();
  try {
    const commands = [
      { type: 'template.patchBlock', templateId: 't1', blockId: 'b1', patch: { name: 'Updated name' } },
      { type: 'template.patchBlock', templateId: 't1', blockId: 'b1', patch: { periodMs: 250 } },
      { type: 'trend.setSignalVisible', groupId: 'g1', signalId: 'a', visible: false },
      { type: 'trend.addSignals', groupId: 'g1', signals: [{ id: 'new-flag', visible: true, pointRef: { connectionId: 'c1', slaveId: 's1', pointId: 'Flag' } }] },
      { type: 'trend.setWindow', groupId: 'g1', windowSec: 300 },
    ];
    for (const raw of commands) {
      expect(await manager.handleCommand(commandSchema.parse(raw))).toMatchObject({ ok: true });
    }
    const block = workspace.current.templates[0]!.blocks[0]!;
    const group = workspace.current.trendGroups[0]!;
    expect(block).toMatchObject({ name: 'Updated name', periodMs: 250 });
    expect(group.windowSec).toBe(300);
    expect(group.signals.find((signal) => signal.id === 'a')?.visible).toBe(false);
    expect(group.signals.some((signal) => signal.id === 'new-flag')).toBe(true);

    const before = workspace.current;
    expect(await manager.handleCommand(commandSchema.parse({
      type: 'trend.addSignals', groupId: 'g1', signals: [{ id: 'duplicate-flag', visible: true, pointRef: { connectionId: 'c1', slaveId: 's1', pointId: 'Flag' } }],
    }))).toMatchObject({ ok: false });
    expect(workspace.current).toBe(before);
  } finally { await manager.stop(); }
});

it('waits for the old transport to close before connecting a replacement', async () => {
  class SlowCloseTransport extends FakeTransport {
    closeStarted = false;
    connectCalls = 0;
    releaseClose: () => void = () => undefined;
    private readonly closeGate = new Promise<void>((resolve) => { this.releaseClose = resolve; });

    constructor(private readonly delayClose: boolean) { super('tcp'); }

    override async connect(): Promise<void> {
      this.connectCalls += 1;
      await super.connect();
    }

    override async close(): Promise<void> {
      this.closeStarted = true;
      if (this.delayClose) await this.closeGate;
      await super.close();
    }
  }

  const root = createScratch('runtime-replacement-');
  const workspace = new WorkspaceService(path.join(root, 'data'));
  workspace.adopt(templateWorkspace(), null);
  const history = await HistoryStore.open(path.join(root, 'history.db'));
  const transports: SlowCloseTransport[] = [];
  const manager = new RuntimeManager(workspace, history, { transportFactory: () => {
    const transport = new SlowCloseTransport(transports.length === 0);
    transports.push(transport);
    return transport;
  } });
  manager.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transports[0]?.connected).toBe(true);
    const connection = { ...workspace.current.connections[0]!, timeoutMs: 900 };
    expect(await manager.handleCommand(commandSchema.parse({ type: 'connection.upsert', connection }))).toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transports[0]?.closeStarted).toBe(true);
    expect(transports[1]?.connected).toBe(false);
    const manualConnect = manager.handleCommand(commandSchema.parse({ type: 'connection.connect', connectionId: 'c1' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transports[1]?.connected).toBe(false);
    transports[0]!.releaseClose();
    expect(await manualConnect).toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transports[1]?.connected).toBe(true);
    expect(transports[1]?.connectCalls).toBe(1);
  } finally {
    transports[0]?.releaseClose();
    await manager.stop();
  }
});
