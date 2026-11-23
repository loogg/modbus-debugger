import { describe, expect, it } from 'vitest';
import { applyCanvasChanges, canvasSchema, diffCanvas } from '../../src/domain/canvas';
import { alignWidgets, moveWidgets, newWidget } from '../../src/renderer/features/canvas/editing';
import { pointWriteFields } from '../../src/domain/point-write-value';
import { bindingError } from '../../src/domain/canvas-binding';
import { templateWorkspace } from '../support/template-workspace';
import { workbenchLayoutSchema } from '../../src/shared/workbench';

describe('canvas editing', () => {
  it('validates restored view identities and typed selections', () => {
    expect(workbenchLayoutSchema.safeParse({ activeId: 'missing', views: [] }).success).toBe(false);
    expect(workbenchLayoutSchema.safeParse({ activeId: 'v', views: [{ id: 'v', module: 'devices', selection: { deviceView: 'unsupported' } }] }).success).toBe(false);
    expect(workbenchLayoutSchema.parse({ activeId: 'v', views: [{ id: 'v', module: 'devices', selection: { slaveId: 's1' } }] }).views[0]?.selection.slaveId).toBe('s1');
  });
  it('moves a selection within the canvas without changing the spacing between controls', () => {
    const canvas = canvasSchema.parse({ id: 'c', name: 'Panel', width: 640, height: 480 });
    canvas.widgets = [newWidget('value', 'a', canvas, 16, 16), newWidget('value', 'b', canvas, 320, 100)];
    const moved = moveWidgets(canvas, ['a', 'b'], 1000, -1000);
    expect(moved.widgets[1]!.x + moved.widgets[1]!.width).toBe(640);
    expect(moved.widgets[0]!.y).toBe(0);
    expect(moved.widgets[1]!.x - moved.widgets[0]!.x).toBe(canvas.widgets[1]!.x - canvas.widgets[0]!.x);
    expect(alignWidgets(canvas, ['a', 'b'], 'left').widgets.map(w => w.x)).toEqual([16, 16]);
  });
  it('rejects stale saves, invalid bounds, duplicate controls, and inconsistent layer order atomically', () => {
    const canvas = canvasSchema.parse({ id: 'c', name: 'Panel' });
    const changed = { ...canvas, widgets: [newWidget('gauge', 'a', canvas)] };
    const edits = diffCanvas(canvas, changed);
    const saved = applyCanvasChanges(canvas, 0, edits);
    expect(saved.revision).toBe(1);
    expect(saved.widgets).toHaveLength(1);
    expect(canvas.widgets).toHaveLength(0);
    expect(() => applyCanvasChanges(saved, 0, edits)).toThrow('其他页面');
    expect(() => applyCanvasChanges(saved, 1, { upsertWidgets: [], removeWidgetIds: [], order: ['missing'] })).toThrow('层次');
    expect(canvasSchema.safeParse({ ...changed, width: 320, widgets: [{ ...changed.widgets[0], x: 300 }] }).success).toBe(false);
    expect(canvasSchema.safeParse({ ...changed, widgets: [changed.widgets[0], changed.widgets[0]] }).success).toBe(false);
    expect(canvasSchema.safeParse({ ...changed, widgets: [{ ...changed.widgets[0], min: 10, max: 10 }] }).success).toBe(false);
  });
});

it('converts input without manufacturing confirmed values and rejects empty/non-finite writes', () => {
  expect(pointWriteFields('Bool', 'OFF')).toEqual({ boolValue: false, engineering: null, stringValue: null });
  expect(pointWriteFields('Float32', '12.5').engineering).toBe(12.5);
  expect(pointWriteFields('String', '  A  ').stringValue).toBe('  A  ');
  expect(() => pointWriteFields('Bool', '2')).toThrow();
  for (const input of ['', ' ', 'NaN', 'Infinity']) expect(() => pointWriteFields('Float32', input)).toThrow();
  const point = templateWorkspace().templates[0]!.points[0]!;
  expect(bindingError('switch', point)).toContain('Bool');
  expect(bindingError('input', { ...point, access: 'ro' })).toContain('可写');
});
