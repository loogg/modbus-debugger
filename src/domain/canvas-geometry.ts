import type { CanvasDef, CanvasWidget, WidgetKind } from './canvas';

export const WIDGET_SIZES: Record<WidgetKind, { width: number; height: number }> = {
  text: { width: 160, height: 28 }, value: { width: 128, height: 32 }, lamp: { width: 24, height: 24 },
  button: { width: 96, height: 32 }, switch: { width: 56, height: 28 }, input: { width: 176, height: 56 },
  gauge: { width: 160, height: 128 }, trend: { width: 360, height: 220 }, container: { width: 320, height: 200 },
};

export const inputRowHeight = (fontSize: number) => Math.max(32, Math.ceil(fontSize * 1.4) + 10);

export function widgetDefaultSize(widget: Pick<CanvasWidget, 'kind' | 'gaugeStyle' | 'inputMode'>) {
  if (widget.kind === 'gauge') {
    const sizes = { arc: WIDGET_SIZES.gauge, dial: { width: 176, height: 176 }, bar: { width: 208, height: 64 }, vertical: { width: 104, height: 192 }, tank: { width: 128, height: 192 } };
    return sizes[widget.gaugeStyle];
  }
  if (widget.kind === 'input' && ['text', 'stepper', 'slider'].includes(widget.inputMode)) return { width: 240, height: 56 };
  return WIDGET_SIZES[widget.kind];
}

export function widgetMinimum(w: CanvasWidget) {
  const sizes: Record<WidgetKind, { width: number; height: number }> = {
    text: { width: 24, height: 20 }, value: { width: 40, height: 24 }, lamp: { width: 16, height: 16 },
    button: { width: 48, height: 28 }, switch: { width: 40, height: 24 }, input: { width: 120, height: inputRowHeight(w.textSize ?? 13) + (w.showConfirmed ? 20 : 0) },
    gauge: { width: 96, height: 80 }, trend: { width: 240, height: 160 }, container: { width: 40, height: 40 },
  };
  if (w.kind === 'gauge') {
    const gauges = { arc: sizes.gauge, dial: { width: 96, height: 96 }, bar: { width: 120, height: 48 }, vertical: { width: 64, height: 104 }, tank: { width: 80, height: 104 } };
    sizes.gauge = gauges[w.gaugeStyle];
  }
  const size = sizes[w.kind];
  return { width: size.width, height: size.height + (w.showLabel && w.kind !== 'container' && w.kind !== 'text' ? 18 : 0) };
}

export function parentFrame(canvas: CanvasDef, widget: CanvasWidget) {
  return canvas.widgets.find(w => w.id === widget.parentId && w.kind === 'container') ?? canvas;
}

export function widgetWorldPosition(canvas: CanvasDef, widget: CanvasWidget) {
  let x = widget.x; let y = widget.y; let parentId = widget.parentId;
  for (let depth = 0; parentId && depth < 8; depth++) {
    const parent = canvas.widgets.find(w => w.id === parentId);
    if (!parent) break;
    x += parent.x; y += parent.y; parentId = parent.parentId;
  }
  return { x, y };
}

export function descendantIds(canvas: CanvasDef, ids: string[]) {
  const result = new Set(ids);
  for (let depth = 0; depth < 8; depth++) {
    const count = result.size;
    for (const w of canvas.widgets) if (w.parentId && result.has(w.parentId)) result.add(w.id);
    if (count === result.size) break;
  }
  return result;
}

export function selectionRoots(canvas: CanvasDef, ids: string[]) {
  const chosen = new Set(ids);
  return canvas.widgets.filter(w => {
    if (!chosen.has(w.id)) return false;
    let parentId = w.parentId;
    for (let depth = 0; parentId && depth < 8; depth++) {
      if (chosen.has(parentId)) return false;
      parentId = canvas.widgets.find(p => p.id === parentId)?.parentId ?? null;
    }
    return true;
  });
}

export function widgetDepth(canvas: CanvasDef, widget: CanvasWidget) {
  let depth = 0; let parent = widget.parentId;
  while (parent && depth < 8) { depth++; parent = canvas.widgets.find(w => w.id === parent)?.parentId ?? null; }
  return depth;
}
