import { canvasWidgetSchema, type CanvasDef, type CanvasWidget, type WidgetKind } from '../../../domain/canvas';
import { descendantIds, parentFrame, selectionRoots, widgetDepth, widgetMinimum, widgetWorldPosition, widgetDefaultSize } from '../../../domain/canvas-geometry';
import { defaultLampRules, type WidgetPreset } from './presets';
import { snapCanvasCoordinate } from '../../../domain/canvas-grid';

export function newWidget(kind: WidgetKind, id: string, canvas: CanvasDef, x = 24, y = 24, parentId: string | null = null, preset?: WidgetPreset): CanvasWidget {
  const parent = canvas.widgets.find(w => w.id === parentId && w.kind === 'container');
  const frame = parent ?? canvas;
  const multiLamp = kind === 'lamp' && preset?.lampMode === 'states';
  const size = multiLamp ? { width: 160, height: 28 } : widgetDefaultSize({ kind, gaugeStyle: preset?.gaugeStyle ?? 'arc', inputMode: preset?.inputMode ?? 'number' });
  const width = Math.min(frame.width, size.width);
  const height = Math.min(frame.height, size.height);
  const origin = parent ? widgetWorldPosition(canvas, parent) : { x: 0, y: 0 };
  const widget = canvasWidgetSchema.parse({ ...preset, id, kind, parentId, label: '', text: kind === 'button' ? '写入' : '文字标签',
    color: ['text', 'value'].includes(kind) ? '#1A1C21' : kind === 'lamp' ? '#178A4D' : kind === 'container' ? '#A8B1BE' : '#0078D4',
    lamp: multiLamp ? { mode: 'states', rules: defaultLampRules() } : undefined, showStateText: multiLamp,
    showBorder: kind === 'container', x: Math.max(0, Math.min(frame.width - width, snapCanvasCoordinate(x, origin.x, canvas.grid))), y: Math.max(0, Math.min(frame.height - height, snapCanvasCoordinate(y, origin.y, canvas.grid))), width, height });
  const min = widgetMinimum(widget);
  if (width < min.width || height < min.height) throw new Error('容器尺寸不足，请先放大容器');
  return widget;
}

export function moveWidgets(canvas: CanvasDef, ids: string[], dx: number, dy: number): CanvasDef {
  const selected = selectionRoots(canvas, ids);
  if (!selected.length) return canvas;
  const x = Math.max(-Math.min(...selected.map(w => w.x)), Math.min(dx, ...selected.map(w => parentFrame(canvas, w).width - w.x - w.width)));
  const y = Math.max(-Math.min(...selected.map(w => w.y)), Math.min(dy, ...selected.map(w => parentFrame(canvas, w).height - w.y - w.height)));
  const roots = new Set(selected.map(w => w.id));
  return { ...canvas, widgets: canvas.widgets.map(w => roots.has(w.id) ? { ...w, x: w.x + x, y: w.y + y } : w) };
}

export type WidgetAlignment = 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom';

export function alignWidgets(canvas: CanvasDef, ids: string[], edge: WidgetAlignment): CanvasDef {
  const selected = selectionRoots(canvas, ids);
  if (!selected.length) return canvas;
  if (new Set(selected.map(w => w.parentId)).size > 1) throw new Error('请在同一容器内选择控件后对齐');
  const horizontal = ['left', 'centerX', 'right'].includes(edge);
  const position = horizontal ? 'x' : 'y';
  const size = horizontal ? 'width' : 'height';
  const first = Math.min(...selected.map(w => w[position]));
  const last = Math.max(...selected.map(w => w[position] + w[size]));
  const center = edge === 'centerX' || edge === 'centerY';
  const end = edge === 'right' || edge === 'bottom';
  const roots = new Set(selected.map(w => w.id));
  return { ...canvas, widgets: canvas.widgets.map(w => roots.has(w.id) ? { ...w, [position]: center ? (first + last - w[size]) / 2 : end ? last - w[size] : first } : w) };
}

export function distributeWidgets(canvas: CanvasDef, ids: string[], axis: 'horizontal' | 'vertical'): CanvasDef {
  const selected = selectionRoots(canvas, ids);
  if (selected.length < 3) return canvas;
  if (new Set(selected.map(w => w.parentId)).size > 1) throw new Error('请在同一容器内选择控件后排列');
  const position = axis === 'horizontal' ? 'x' : 'y';
  const size = axis === 'horizontal' ? 'width' : 'height';
  const ordered = [...selected].sort((left, right) => left[position] - right[position]);
  const first = ordered[0]!;
  const last = ordered.at(-1)!;
  const occupied = ordered.slice(0, -1).reduce((sum, widget) => sum + widget[size], 0);
  const gap = (last[position] - first[position] - occupied) / (ordered.length - 1);
  const positions = new Map<string, number>();
  let cursor = first[position];
  for (const widget of ordered.slice(0, -1)) {
    const frame = parentFrame(canvas, widget);
    if (cursor < 0 || cursor + widget[size] > frame[size]) throw new Error('当前范围无法完成等间距排列，请先拉开首尾控件');
    positions.set(widget.id, cursor);
    cursor += widget[size] + gap;
  }
  return { ...canvas, widgets: canvas.widgets.map(widget => positions.has(widget.id) ? { ...widget, [position]: positions.get(widget.id)! } : widget) };
}

export function reparentWidget(canvas: CanvasDef, id: string, parentId: string | null): CanvasDef {
  const widget = canvas.widgets.find(w => w.id === id);
  const parent = canvas.widgets.find(w => w.id === parentId);
  if (!widget || (parentId && parent?.kind !== 'container') || descendantIds(canvas, [id]).has(parentId ?? '')) throw new Error('不能移入该容器');
  const world = widgetWorldPosition(canvas, widget);
  const origin = parent ? widgetWorldPosition(canvas, parent) : { x: 0, y: 0 };
  const frame = parent ?? canvas;
  if (widget.width > frame.width || widget.height > frame.height) throw new Error('控件大于容器，请先调整容器尺寸');
  return { ...canvas, widgets: canvas.widgets.map(w => w.id === id ? { ...w, parentId, x: Math.max(0, Math.min(frame.width - w.width, world.x - origin.x)), y: Math.max(0, Math.min(frame.height - w.height, world.y - origin.y)) } : w) };
}

export function groupWidgets(canvas: CanvasDef, ids: string[], containerId: string): CanvasDef {
  const selected = selectionRoots(canvas, ids);
  if (!selected.length) return canvas;
  const worlds = selected.map(w => ({ ...widgetWorldPosition(canvas, w), w }));
  const x = Math.max(0, Math.min(...worlds.map(w => w.x)) - 8);
  const y = Math.max(0, Math.min(...worlds.map(w => w.y)) - 8);
  const container = { ...newWidget('container', containerId, canvas, x, y), x, y, label: '容器', width: Math.min(canvas.width - x, Math.max(...worlds.map(p => p.x + p.w.width)) - x + 8), height: Math.min(canvas.height - y, Math.max(...worlds.map(p => p.y + p.w.height)) - y + 8) };
  return { ...canvas, widgets: [container, ...canvas.widgets.map(w => { const position = worlds.find(p => p.w.id === w.id); return position ? { ...w, parentId: container.id, x: position.x - x, y: position.y - y } : w; })] };
}

export function dissolveContainers(canvas: CanvasDef, ids: string[]): CanvasDef {
  let result = canvas;
  const containers = canvas.widgets.filter(w => w.kind === 'container' && ids.includes(w.id)).sort((a, b) => widgetDepth(canvas, b) - widgetDepth(canvas, a));
  for (const c of containers) {
    const current = result.widgets.find(w => w.id === c.id)!;
    result = { ...result, widgets: result.widgets.filter(w => w.id !== current.id).map(w => w.parentId === current.id ? { ...w, parentId: current.parentId, x: w.x + current.x, y: w.y + current.y } : w) };
  }
  return result;
}

export function copyWidgets(canvas: CanvasDef, ids: string[]): CanvasWidget[] {
  const roots = new Set(selectionRoots(canvas, ids).map(w => w.id));
  const included = descendantIds(canvas, [...roots]);
  return canvas.widgets.filter(w => included.has(w.id)).map(w => roots.has(w.id) ? { ...w, ...widgetWorldPosition(canvas, w), parentId: null } : { ...w });
}

export function pasteWidgets(canvas: CanvasDef, widgets: CanvasWidget[], nextId: () => string) {
  const ids = new Map(widgets.map(w => [w.id, nextId()]));
  const copies = widgets.map(w => ({ ...w, id: ids.get(w.id)!, parentId: w.parentId ? ids.get(w.parentId) ?? null : null,
    x: w.parentId ? w.x : Math.max(0, Math.min(canvas.width - w.width, w.x + 16)), y: w.parentId ? w.y : Math.max(0, Math.min(canvas.height - w.height, w.y + 16)) }));
  return { canvas: { ...canvas, widgets: [...canvas.widgets, ...copies] }, selected: copies.filter(w => !w.parentId).map(w => w.id) };
}

export function fitWidgets(canvas: CanvasDef, ids: string[], measureText?: (text: string, fontSize: number) => number): CanvasDef {
  let result = canvas;
  for (const widget of canvas.widgets.filter(w => ids.includes(w.id)).sort((a, b) => widgetDepth(canvas, b) - widgetDepth(canvas, a))) {
    const w = result.widgets.find(item => item.id === widget.id)!;
    const frame = parentFrame(result, w);
    let { width, height } = widgetDefaultSize(w);
    if (w.kind === 'text') {
      const lines = w.text.split('\n');
      width = Math.max(24, Math.ceil(Math.max(...lines.map(line => measureText?.(line, w.fontSize) ?? [...line].reduce((n, char) => n + (char.charCodeAt(0) > 255 ? w.fontSize : w.fontSize * .6), 0)))) + 2);
      height = Math.max(20, Math.ceil(lines.length * w.fontSize * 1.3));
    }
    if (w.kind === 'lamp' && w.showStateText) {
      const labels = w.lamp.mode === 'binary' ? [w.lamp.on.label, w.lamp.off.label, w.lamp.fallback.label] : [...w.lamp.rules.map(rule => rule.label), w.lamp.fallback.label];
      width = 32 + Math.ceil(Math.max(...labels.map(label => measureText?.(label, w.textSize ?? 13) ?? label.length * (w.textSize ?? 13))));
    }
    if (w.kind === 'switch' && w.showStateText) width = 96;
    if (w.kind === 'input' && !w.showConfirmed) height = 32;
    if (w.showLabel && !['text', 'container'].includes(w.kind)) height += 18;
    if (w.kind === 'container') {
      const children = result.widgets.filter(item => item.parentId === w.id);
      if (children.length) { width = Math.max(40, ...children.map(child => child.x + child.width + 8)); height = Math.max(40, ...children.map(child => child.y + child.height + 8)); }
    }
    if (w.kind !== 'container') { width += w.padding * 2; height += w.padding * 2; }
    width = Math.min(width, frame.width); height = Math.min(height, frame.height);
    result = { ...result, widgets: result.widgets.map(item => item.id === w.id ? { ...item, width, height, x: Math.min(item.x, frame.width - width), y: Math.min(item.y, frame.height - height) } : item) };
  }
  return result;
}
