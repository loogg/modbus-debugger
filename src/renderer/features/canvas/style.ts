import type { CSSProperties } from 'react';
import type { CanvasDef, CanvasWidget } from '../../../domain/canvas';
import { inputRowHeight } from '../../../domain/canvas-geometry';

export function canvasGridStyle(canvas: Pick<CanvasDef, 'background' | 'grid'>): CSSProperties {
  const [red, green, blue] = [1, 3, 5].map(offset => parseInt(canvas.background.slice(offset, offset + 2), 16));
  const brightness = red! * .299 + green! * .587 + blue! * .114;
  return {
    backgroundSize: `${canvas.grid.size}px ${canvas.grid.size}px`,
    backgroundPosition: `${-canvas.grid.size / 2}px ${-canvas.grid.size / 2}px`,
    '--canvas-grid-color': brightness > 148 ? 'rgba(26,28,33,0.28)' : 'rgba(255,255,255,0.30)',
  } as CSSProperties;
}

export function canvasTextSize(widget: CanvasWidget) {
  if (['text', 'value'].includes(widget.kind)) return widget.fontSize;
  return widget.textSize ?? (widget.kind === 'gauge' ? 20 : 13);
}

export function canvasTheme(widget?: CanvasWidget, menu = false): CSSProperties {
  const appearance = widget ? canvasAppearance(widget) : 'outline';
  const foreground = menu ? '#1A1C21' : appearance === 'solid' ? '#FFFFFF' : widget && ['text', 'value', 'gauge', 'button'].includes(widget.kind) ? widget.color : '#1A1C21';
  return {
    '--canvas-accent': widget?.color ?? '#0078D4',
    '--canvas-text-color': widget?.textColor ?? foreground,
    '--canvas-font-size': `${widget ? canvasTextSize(widget) : 13}px`,
    '--canvas-control-height': `${inputRowHeight(widget ? canvasTextSize(widget) : 13)}px`,
    '--canvas-font-weight': widget?.textWeight === 'bold' ? 700 : widget?.textWeight === 'medium' || (!widget?.textWeight && ['button', 'value'].includes(widget?.kind ?? '')) ? 500 : 400,
    '--canvas-align': widget?.textAlign ?? (widget?.kind === 'button' || widget?.kind === 'gauge' ? 'center' : 'left'),
    '--canvas-justify': widget?.textAlign === 'center' ? 'center' : widget?.textAlign === 'right' ? 'flex-end' : 'flex-start',
    '--canvas-border-color': widget?.borderColor ?? (widget?.kind === 'container' ? widget.color : '#D9DEE5'),
    '--canvas-border-width': `${widget?.borderWidth ?? 1}px`,
    '--canvas-radius': `${widget?.borderRadius ?? 6}px`,
  } as CSSProperties;
}

export function canvasAppearance(widget: CanvasWidget) {
  if (widget.appearance !== 'auto') return widget.appearance;
  if (widget.kind === 'button') return 'solid';
  return widget.kind === 'input' && widget.inputMode === 'select' ? 'soft' : 'outline';
}
