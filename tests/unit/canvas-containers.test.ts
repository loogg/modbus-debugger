import { expect, it } from 'vitest';
import { canvasSchema } from '../../src/domain/canvas';
import { descendantIds, widgetWorldPosition } from '../../src/domain/canvas-geometry';
import { copyWidgets, dissolveContainers, fitWidgets, groupWidgets, moveWidgets, newWidget, pasteWidgets, reparentWidget } from '../../src/renderer/features/canvas/editing';

function fixture() {
  const canvas = canvasSchema.parse({ id: 'scene', name: 'Scene', width: 800, height: 600 });
  canvas.widgets = [newWidget('value', 'value', canvas, 32, 40), newWidget('lamp', 'lamp', canvas, 240, 40), newWidget('text', 'text', canvas, 32, 96)];
  return canvas;
}

it('uses compact transparent primitives and a standalone text label', () => {
  const canvas = fixture();
  expect(canvas.widgets[1]).toMatchObject({ width: 24, height: 24, showLabel: false, showBackground: false, showBorder: false });
  expect(canvas.widgets[2]).toMatchObject({ kind: 'text', height: 28, text: '文字标签' });
  const fitted = fitWidgets({ ...canvas, widgets: canvas.widgets.map(w => ({ ...w, width: 400, height: 200 })) }, ['value', 'lamp']);
  expect(fitted.widgets[0]).toMatchObject({ width: 128, height: 32 });
  expect(fitted.widgets[1]).toMatchObject({ width: 24, height: 24 });
});

it('groups without changing world positions, moves children once, and ungroups losslessly', () => {
  const original = fixture();
  const grouped = groupWidgets(original, ['value', 'lamp'], 'container');
  expect(canvasSchema.safeParse(grouped).success).toBe(true);
  for (const id of ['value', 'lamp']) expect(widgetWorldPosition(grouped, grouped.widgets.find(w => w.id === id)!)).toEqual(widgetWorldPosition(original, original.widgets.find(w => w.id === id)!));
  const moved = moveWidgets(grouped, ['container', 'value', 'lamp'], 40, 24);
  expect(widgetWorldPosition(moved, moved.widgets.find(w => w.id === 'value')!)).toEqual({ x: 72, y: 64 });
  const ungrouped = dissolveContainers(moved, ['container']);
  expect(ungrouped.widgets.find(w => w.id === 'value')).toMatchObject({ parentId: null, x: 72, y: 64 });
  expect(canvasSchema.safeParse(ungrouped).success).toBe(true);
});

it('copies whole subtrees with fresh ids and rejects cycles/missing parents/overflow', () => {
  const grouped = groupWidgets(fixture(), ['value', 'lamp'], 'container');
  let id = 0;
  const pasted = pasteWidgets(grouped, copyWidgets(grouped, ['container']), () => `copy-${++id}`);
  expect(canvasSchema.safeParse(pasted.canvas).success).toBe(true);
  expect(pasted.selected).toHaveLength(1);
  expect(descendantIds(pasted.canvas, pasted.selected).size).toBe(3);
  expect(() => reparentWidget(grouped, 'container', 'container')).toThrow();
  expect(canvasSchema.safeParse({ ...grouped, widgets: grouped.widgets.map(w => w.id === 'value' ? { ...w, parentId: 'missing' } : w) }).success).toBe(false);
  expect(canvasSchema.safeParse({ ...grouped, widgets: grouped.widgets.map(w => w.id === 'container' ? { ...w, parentId: 'container' } : w) }).success).toBe(false);
  expect(canvasSchema.safeParse({ ...grouped, widgets: grouped.widgets.map(w => w.id === 'value' ? { ...w, x: 700 } : w) }).success).toBe(false);
});

it('supports nesting and moving a child out of a container at the same canvas position', () => {
  const grouped = groupWidgets(fixture(), ['value', 'lamp'], 'inner');
  const nested = groupWidgets(grouped, ['inner', 'text'], 'outer');
  expect(canvasSchema.safeParse(nested).success).toBe(true);
  const value = nested.widgets.find(w => w.id === 'value')!;
  const position = widgetWorldPosition(nested, value);
  const extracted = reparentWidget(nested, 'value', null);
  expect(extracted.widgets.find(w => w.id === 'value')).toMatchObject({ ...position, parentId: null });
  const dissolved = dissolveContainers(nested, ['outer', 'inner']);
  expect(dissolved.widgets.every(w => w.parentId === null)).toBe(true);
  expect(dissolved.widgets.find(w => w.id === 'value')).toMatchObject(position);
});
