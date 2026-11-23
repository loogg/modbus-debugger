import { expect, it } from 'vitest';
import { applyCanvasChanges, canvasGridSchema, canvasSchema, canvasWidgetSchema, diffCanvas } from '../../src/domain/canvas';
import { resizeCanvasRect, snapCanvasCoordinate } from '../../src/domain/canvas-grid';
import { widgetWorldPosition } from '../../src/domain/canvas-geometry';
import { alignWidgets, distributeWidgets, moveWidgets, newWidget, type WidgetAlignment } from '../../src/renderer/features/canvas/editing';
import { canvasGridStyle } from '../../src/renderer/features/canvas/style';

const grid = canvasGridSchema.parse({ size: 16 });
it('places visible grid dots at the canvas origin and adapts contrast to the background', () => {
  expect(canvasGridStyle({ background: '#FFFFFF', grid })).toMatchObject({ backgroundSize: '16px 16px', backgroundPosition: '-8px -8px', '--canvas-grid-color': 'rgba(26,28,33,0.28)' });
  expect(canvasGridStyle({ background: '#111111', grid })).toMatchObject({ '--canvas-grid-color': 'rgba(255,255,255,0.30)' });
});
function fixture() {
  return canvasSchema.parse({ id: 'c', name: 'Layout', width: 800, height: 600, grid,
    widgets: [
      { id: 'a', kind: 'lamp', label: 'A', x: 41, y: 59, width: 24, height: 24 },
      { id: 'b', kind: 'switch', label: 'B', x: 150, y: 103, width: 56, height: 28 },
      { id: 'c', kind: 'text', label: 'C', x: 300, y: 179, width: 160, height: 28 },
    ] });
}

it('loads old canvases with default grid settings and commits versioned grid edits', () => {
  const old = canvasSchema.parse({ id: 'old', name: 'Old' });
  expect(old.grid).toEqual({ visible: true, snap: true, size: 8 });
  const updated = { ...old, grid: { visible: false, snap: false, size: 24 } };
  const saved = applyCanvasChanges(old, 0, diffCanvas(old, updated));
  expect(saved.grid).toEqual(updated.grid);
  expect(old.grid.size).toBe(8);
  expect(() => applyCanvasChanges(saved, 0, diffCanvas(old, updated))).toThrow('其他页面');
  for (const size of [0, 1, 129, 8.5, NaN, Infinity]) expect(canvasGridSchema.safeParse({ size }).success).toBe(false);
});

it('snaps new controls and nested coordinates to the visible canvas-origin grid', () => {
  const canvas = fixture();
  expect(newWidget('lamp', 'new', canvas, 41, 59)).toMatchObject({ x: 48, y: 64 });
  const free = { ...canvas, grid: { ...grid, snap: false } };
  expect(newWidget('lamp', 'new', free, 41, 59)).toMatchObject({ x: 41, y: 59 });
  const parent = canvasWidgetSchema.parse({ id: 'parent', kind: 'container', label: '', x: 7, y: 11, width: 400, height: 300 });
  canvas.widgets.push(parent);
  const child = newWidget('lamp', 'child', canvas, 13, 16, parent.id);
  expect(child).toMatchObject({ x: 9, y: 21 });
  expect(widgetWorldPosition(canvas, child)).toEqual({ x: 16, y: 32 });
  expect(snapCanvasCoordinate(13, 7, grid, true)).toBe(13);
  expect(snapCanvasCoordinate(13, 7, { ...grid, snap: false })).toBe(13);
});

it.each(['left', 'centerX', 'right', 'top', 'centerY', 'bottom'] as WidgetAlignment[])('aligns mixed-size controls by %s exactly', alignment => {
  const canvas = fixture();
  const result = alignWidgets(canvas, ['a', 'b', 'c'], alignment);
  const horizontal = ['left', 'centerX', 'right'].includes(alignment);
  const position = horizontal ? 'x' : 'y';
  const size = horizontal ? 'width' : 'height';
  const centers = alignment === 'centerX' || alignment === 'centerY';
  const ends = alignment === 'right' || alignment === 'bottom';
  const coordinates = result.widgets.map(widget => widget[position] + (centers ? widget[size] / 2 : ends ? widget[size] : 0));
  expect(new Set(coordinates).size).toBe(1);
  expect(result.widgets.map(widget => widget[horizontal ? 'y' : 'x'])).toEqual(canvas.widgets.map(widget => widget[horizontal ? 'y' : 'x']));
  expect(canvasSchema.safeParse(result).success).toBe(true);
});

it.each(['horizontal', 'vertical'] as const)('distributes edge gaps on the %s axis with fixed endpoints', axis => {
  const canvas = fixture();
  const result = distributeWidgets(canvas, ['a', 'b', 'c'], axis);
  const position = axis === 'horizontal' ? 'x' : 'y';
  const size = axis === 'horizontal' ? 'width' : 'height';
  const [first, middle, last] = result.widgets;
  expect(first![position]).toBe(canvas.widgets[0]![position]);
  expect(last![position]).toBe(canvas.widgets[2]![position]);
  expect(middle![position] - first![position] - first![size]).toBeCloseTo(last![position] - middle![position] - middle![size]);
  expect(canvasSchema.safeParse(result).success).toBe(true);
  expect(distributeWidgets(canvas, ['a', 'b'], axis)).toBe(canvas);
});

it('preserves container descendants and rejects cross-parent or out-of-bounds layouts atomically', () => {
  const canvas = fixture();
  const parent = canvasWidgetSchema.parse({ id: 'parent', kind: 'container', label: '', x: 200, y: 300, width: 400, height: 200 });
  const child = newWidget('lamp', 'child', { ...canvas, widgets: [parent] }, 13, 16, parent.id);
  canvas.widgets.push(parent, child);
  const aligned = alignWidgets(canvas, ['a', 'parent', 'child'], 'left');
  expect(aligned.widgets.find(widget => widget.id === child.id)).toEqual(child);
  expect(widgetWorldPosition(aligned, child).x).toBe(41 + child.x);
  expect(() => alignWidgets(canvas, ['a', 'child'], 'left')).toThrow('同一容器');
  expect(() => distributeWidgets(canvas, ['a', 'b', 'child'], 'horizontal')).toThrow('同一容器');
  const impossible = canvasSchema.parse({ ...fixture(), widgets: [
    { ...fixture().widgets[0], x: 0, width: 16 },
    { ...fixture().widgets[1], x: 20, width: 400 },
    { ...fixture().widgets[2], x: 100, width: 16 },
  ] });
  const before = JSON.stringify(impossible);
  expect(() => distributeWidgets(impossible, ['a', 'b', 'c'], 'horizontal')).toThrow('当前范围');
  expect(JSON.stringify(impossible)).toBe(before);
  const moved = moveWidgets(canvas, ['parent', 'child'], 32, 16);
  expect(moved.widgets.find(widget => widget.id === child.id)).toEqual(child);
});

it.each(['top', 'right', 'bottom', 'left', 'topRight', 'bottomRight', 'bottomLeft', 'topLeft'] as const)('snaps only moving edges for %s resizing', direction => {
  const base = { x: 41, y: 59, width: 101, height: 67 };
  const origin = { x: 7, y: 11 };
  const result = resizeCanvasRect(base, direction, { width: 13, height: 17 }, { width: 800, height: 600 }, { width: 16, height: 16 }, origin, grid);
  const lower = direction.toLowerCase();
  if (lower.includes('left')) { expect((result.x + origin.x) % 16).toBe(0); expect(result.x + result.width).toBe(base.x + base.width); }
  if (lower.includes('right')) { expect((result.x + result.width + origin.x) % 16).toBe(0); expect(result.x).toBe(base.x); }
  if (lower.includes('top')) { expect((result.y + origin.y) % 16).toBe(0); expect(result.y + result.height).toBe(base.y + base.height); }
  if (lower.includes('bottom')) { expect((result.y + result.height + origin.y) % 16).toBe(0); expect(result.y).toBe(base.y); }
});

it('clamps resizing to frame/children bounds and allows free or unchanged resize gestures', () => {
  const base = { x: 41, y: 59, width: 101, height: 67 };
  const frame = { width: 180, height: 180 };
  const minimum = { width: 100, height: 60 };
  const origin = { x: 7, y: 11 };
  expect(resizeCanvasRect(base, 'bottomRight', { width: 1000, height: 1000 }, frame, minimum, origin, grid)).toEqual({ x: 41, y: 59, width: 139, height: 121 });
  expect(resizeCanvasRect(base, 'topLeft', { width: -1000, height: -1000 }, frame, minimum, origin, grid)).toEqual({ x: 42, y: 66, width: 100, height: 60 });
  expect(resizeCanvasRect(base, 'bottomRight', { width: 13, height: 17 }, frame, minimum, origin, grid, true)).toEqual({ ...base, width: 114, height: 84 });
  expect(resizeCanvasRect(base, 'bottomRight', { width: 0, height: 0 }, frame, minimum, origin, grid)).toEqual(base);
});
