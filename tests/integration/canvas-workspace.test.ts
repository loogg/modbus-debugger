import { expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createScratch } from '../../tools/test-paths.mjs';
import { WorkspaceService } from '../../src/main/services/workspace';
import { HistoryStore } from '../../src/main/services/history';
import { RuntimeManager } from '../../src/main/runtime/manager';
import { commandSchema } from '../../src/shared/commands';
import { canvasSchema, diffCanvas } from '../../src/domain/canvas';
import { newWidget } from '../../src/renderer/features/canvas/editing';
import { templateWorkspace } from '../support/template-workspace';
import { FakeTransport } from '../support/fake';
import { migrateWorkspace } from '../../src/domain/model';
import { lampConfigSchema, lampRuleSchema } from '../../src/domain/canvas-lamp';
import { bufferReferences } from '../../src/domain/point-buffers';

it('persists canvas commands, rejects concurrent edits, and reuses the existing runtimes', async () => {
  const root = createScratch('canvas-workspace-');
  const workspace = new WorkspaceService(path.join(root, 'data'));
  workspace.adopt(templateWorkspace(), null);
  const history = await HistoryStore.open(path.join(root, 'history.db'));
  const manager = new RuntimeManager(workspace, history, { transportFactory: () => new FakeTransport('tcp') });
  manager.start();
  try {
    const runtime = manager.runtimeFor('c1');
    const run = (raw: unknown) => manager.handleCommand(commandSchema.parse(raw));
    const canvas = canvasSchema.parse({ id: 'panel', name: 'Test panel' });
    const widget = newWidget('value', 'value', canvas);
    widget.binding = { slaveId: workspace.current.slaves[0]!.id, pointId: workspace.current.templates[0]!.points[0]!.id };
    canvas.widgets.push(widget);
    expect(await run({ type: 'canvas.create', canvas })).toMatchObject({ ok: true });
    const edits = diffCanvas(canvas, { ...canvas, name: 'Renamed', grid: { visible: false, snap: false, size: 24 }, widgets: [{ ...widget, x: 64 }] });
    expect(await run({ type: 'canvas.edit', canvasId: 'panel', expectedRevision: 0, changes: edits })).toMatchObject({ ok: true });
    const committed = workspace.current;
    expect(await run({ type: 'canvas.edit', canvasId: 'panel', expectedRevision: 0, changes: { name: 'Stale draft' } })).toMatchObject({ ok: false });
    expect(workspace.current).toBe(committed);
    expect(await run({ type: 'canvas.edit', canvasId: 'panel', expectedRevision: 1, changes: { upsertWidgets: [{ ...widget, binding: { slaveId: 'missing', pointId: 'missing' } }] } })).toMatchObject({ ok: false });
    expect(workspace.current).toBe(committed);
    expect(await run({ type: 'workbench.saveLayout', layout: { activeId: 'a', views: [{ id: 'a', module: 'canvas', selection: { canvasId: 'panel' } }, { id: 'b', module: 'canvas', selection: { canvasId: 'panel' } }] } })).toMatchObject({ ok: true });
    workspace.flushAutosave();
    const restored = migrateWorkspace(JSON.parse(fs.readFileSync(workspace.currentPath!, 'utf8')));
    expect(restored.canvases?.[0]).toMatchObject({ name: 'Renamed', revision: 1, grid: { visible: false, snap: false, size: 24 }, widgets: [{ id: 'value', x: 64 }] });
    expect(restored.workbench?.views).toHaveLength(2);
    expect(manager.runtimeFor('c1')).toBe(runtime);
    expect(await run({ type: 'canvas.delete', canvasId: 'panel', expectedRevision: 0 })).toMatchObject({ ok: false });
    expect(await run({ type: 'canvas.delete', canvasId: 'panel', expectedRevision: 1 })).toMatchObject({ ok: true });
    expect(workspace.current.canvases).toEqual([]);
  } finally { await manager.stop(); }
});

it('migrates existing workspaces and rejects unsupported future versions without losing canvas data', () => {
  const workspace = templateWorkspace();
  expect(migrateWorkspace({ ...workspace, schemaVersion: 1 }).schemaVersion).toBe(2);
  expect(() => migrateWorkspace({ ...workspace, schemaVersion: 3 })).toThrow('newer');
});

it('persists a device communication binding and rejects a missing or unsupported target', async () => {
  const root = createScratch('canvas-device-status-');
  const workspace = new WorkspaceService(path.join(root, 'data'));
  workspace.adopt(templateWorkspace(), null);
  const history = await HistoryStore.open(path.join(root, 'history.db'));
  const manager = new RuntimeManager(workspace, history, { transportFactory: () => new FakeTransport('tcp') });
  manager.start();
  try {
    const run = (raw: unknown) => manager.handleCommand(commandSchema.parse(raw));
    const canvas = canvasSchema.parse({ id: 'device-status', name: 'Status' });
    const buffers = bufferReferences(workspace.current);
    const binding = { kind: 'slave-status' as const, slaveId: workspace.current.slaves[0]!.id };
    const lamp = { ...newWidget('lamp', 'lamp', canvas), binding };
    expect(canvasSchema.safeParse({ ...canvas, widgets: [{ ...lamp, kind: 'input' }] }).success).toBe(false);
    expect(await run({ type: 'canvas.create', canvas: { ...canvas, widgets: [{ ...lamp, binding: { ...binding, slaveId: 'missing' } }] } })).toMatchObject({ ok: false });
    expect(await run({ type: 'canvas.create', canvas: { ...canvas, widgets: [lamp] } })).toMatchObject({ ok: true });
    workspace.flushAutosave();
    const restored = migrateWorkspace(JSON.parse(fs.readFileSync(workspace.currentPath!, 'utf8')));
    expect(restored.canvases?.[0]?.widgets[0]?.binding).toEqual(binding);
    expect(bufferReferences(restored)).toEqual(buffers);
  } finally { await manager.stop(); }
});

it('exports and imports all lamp rules/defaults/gradients and rejects invalid rule edits atomically', async () => {
  const root = createScratch('canvas-lamp-');
  const workspace = new WorkspaceService(path.join(root, 'data'));
  workspace.adopt(templateWorkspace(), null);
  const history = await HistoryStore.open(path.join(root, 'history.db'));
  const manager = new RuntimeManager(workspace, history, { transportFactory: () => new FakeTransport('tcp') });
  manager.start();
  try {
    const canvas = canvasSchema.parse({ id: 'lamps', name: 'Lamp panel' });
    const lamp = { ...newWidget('lamp', 'lamp', canvas), binding: { slaveId: 's1', pointId: 'Ia' }, lamp: lampConfigSchema.parse({ mode: 'states', rules: [lampRuleSchema.parse({ id: 'range', match: 'range', lower: 60, upper: 80, label: '告警', color: '#D97706', fill: { type: 'radial' } })], fallback: { label: '默认', color: '#94A3B8', fill: { type: 'linear', angle: 90, secondary: '#FFFFFF' } } }) };
    canvas.widgets = [lamp];
    expect(await manager.handleCommand({ type: 'canvas.create', canvas })).toMatchObject({ ok: true });
    const committed = workspace.current;
    const bad = { ...lamp, lamp: { ...lamp.lamp, rules: [{ ...lamp.lamp.rules[0]!, lower: 90, upper: 80 }] } };
    expect(await manager.handleCommand({ type: 'canvas.edit', canvasId: canvas.id, expectedRevision: 0, changes: { upsertWidgets: [bad], removeWidgetIds: [] } })).toMatchObject({ ok: false });
    expect(workspace.current).toBe(committed);
    const target = path.join(root, 'export.workspace.json');
    expect(workspace.exportToFile(target)).toMatchObject({ ok: true });
    const imported = new WorkspaceService(path.join(root, 'import')).importFromBuffer(fs.readFileSync(target, 'utf8'));
    expect(imported.ok).toBe(true);
    expect(imported.workspace!.canvases![0]!.widgets[0]!.lamp).toEqual(lamp.lamp);
  } finally { await manager.stop(); }
});

it('revalidates a changed input mode even when its bound point id stays the same', async () => {
  const root = createScratch('canvas-input-mode-');
  const workspace = new WorkspaceService(path.join(root, 'data'));
  workspace.adopt(templateWorkspace(), null);
  const history = await HistoryStore.open(path.join(root, 'history.db'));
  const manager = new RuntimeManager(workspace, history, { transportFactory: () => new FakeTransport('tcp') });
  manager.start();
  try {
    const run = (raw: unknown) => manager.handleCommand(commandSchema.parse(raw));
    const canvas = canvasSchema.parse({ id: 'inputs', name: 'Inputs' });
    const input = { ...newWidget('input', 'input', canvas), binding: { slaveId: 's1', pointId: 'Ia' } };
    canvas.widgets = [input];
    expect(await run({ type: 'canvas.create', canvas })).toMatchObject({ ok: true });
    const committed = workspace.current;
    expect(await run({ type: 'canvas.edit', canvasId: canvas.id, expectedRevision: 0, changes: { upsertWidgets: [{ ...input, inputMode: 'text' }] } })).toMatchObject({ ok: false });
    expect(workspace.current).toBe(committed);
    expect(await run({ type: 'canvas.edit', canvasId: canvas.id, expectedRevision: 0, changes: { upsertWidgets: [{ ...input, inputMode: 'text', binding: { slaveId: 's1', pointId: 'Late' }, appearance: 'soft', textSize: 16, textColor: '#123456', textWeight: 'bold', textAlign: 'right', borderColor: '#456789', borderWidth: 2, borderRadius: 12, padding: 4 }] } })).toMatchObject({ ok: true });
    workspace.flushAutosave();
    const restored = migrateWorkspace(JSON.parse(fs.readFileSync(workspace.currentPath!, 'utf8')));
    expect(restored.canvases![0]!.widgets[0]).toMatchObject({ inputMode: 'text', binding: { pointId: 'Late' }, appearance: 'soft', textSize: 16, textColor: '#123456', textWeight: 'bold', textAlign: 'right', borderColor: '#456789', borderWidth: 2, borderRadius: 12, padding: 4 });
  } finally { await manager.stop(); }
});

it('round-trips nested containers and multiple signals while atomically rejecting invalid edits', async () => {
  const root = createScratch('canvas-hierarchy-');
  const workspace = new WorkspaceService(path.join(root, 'data'));
  workspace.adopt(templateWorkspace(), null);
  const history = await HistoryStore.open(path.join(root, 'history.db'));
  const manager = new RuntimeManager(workspace, history, { transportFactory: () => new FakeTransport('tcp') });
  manager.start();
  try {
    const run = (raw: unknown) => manager.handleCommand(commandSchema.parse(raw));
    const canvas = canvasSchema.parse({ id: 'nested', name: 'Nested panel' });
    const parent = { ...newWidget('container', 'parent', canvas), width: 600, height: 400 };
    const child = { ...newWidget('container', 'child', canvas), parentId: parent.id, x: 8, y: 32, width: 400, height: 300 };
    const slaveId = workspace.current.slaves[0]!.id;
    const points = workspace.current.templates[0]!.points.filter(p => !['Bool', 'String'].includes(p.mapping.rawType)).slice(0, 2);
    expect(points).toHaveLength(2);
    const curve = { ...newWidget('trend', 'curve', canvas), parentId: child.id, x: 8, y: 32, signals: points.map(p => ({ slaveId, pointId: p.id })) };
    canvas.widgets = [parent, child, curve];
    expect(await run({ type: 'canvas.create', canvas })).toMatchObject({ ok: true });
    const committed = workspace.current;
    expect(await run({ type: 'canvas.edit', canvasId: canvas.id, expectedRevision: 0, changes: { removeWidgetIds: ['child'] } })).toMatchObject({ ok: false });
    expect(workspace.current).toBe(committed);
    expect(await run({ type: 'canvas.edit', canvasId: canvas.id, expectedRevision: 0, changes: { upsertWidgets: [{ ...curve, signals: [...curve.signals, { slaveId, pointId: 'missing' }] }] } })).toMatchObject({ ok: false });
    expect(workspace.current).toBe(committed);
    workspace.flushAutosave();
    const restored = migrateWorkspace(JSON.parse(fs.readFileSync(workspace.currentPath!, 'utf8')));
    expect(restored.canvases?.[0]?.widgets).toMatchObject([
      { id: 'parent', parentId: null }, { id: 'child', parentId: 'parent' }, { id: 'curve', parentId: 'child', signals: curve.signals },
    ]);
  } finally { await manager.stop(); }
});
