import type { CanvasGrid } from './canvas';

export interface CanvasRect { x: number; y: number; width: number; height: number }
export interface CanvasPoint { x: number; y: number }
type ResizeDirection = 'top' | 'right' | 'bottom' | 'left' | 'topRight' | 'bottomRight' | 'bottomLeft' | 'topLeft';

/** Local coordinates snap to the same canvas-origin lattice through nested containers. */
export function snapCanvasCoordinate(value: number, origin: number, grid: CanvasGrid, bypass = false): number {
  return grid.snap && !bypass ? Math.round((value + origin) / grid.size) * grid.size - origin : value;
}

function resizeAxis(position: number, size: number, delta: number, fromStart: boolean, frame: number, minimum: number, origin: number, grid: CanvasGrid, bypass: boolean) {
  if (delta === 0) return { position, size };
  const fixedEnd = position + size;
  const min = Math.min(minimum, fromStart ? fixedEnd : frame - position);
  const movingEdge = fromStart ? position - delta : fixedEnd + delta;
  const snapped = snapCanvasCoordinate(movingEdge, origin, grid, bypass);
  const start = fromStart ? Math.max(0, Math.min(fixedEnd - min, snapped)) : position;
  const end = fromStart ? fixedEnd : Math.max(position + min, Math.min(frame, snapped));
  return { position: start, size: end - start };
}

export function resizeCanvasRect(base: CanvasRect, direction: ResizeDirection, delta: { width: number; height: number }, frame: { width: number; height: number }, minimum: { width: number; height: number }, origin: CanvasPoint, grid: CanvasGrid, bypass = false): CanvasRect {
  const lower = direction.toLowerCase();
  const horizontal = lower.includes('left') || lower.includes('right');
  const vertical = lower.includes('top') || lower.includes('bottom');
  const x = resizeAxis(base.x, base.width, horizontal ? delta.width : 0, lower.includes('left'), frame.width, minimum.width, origin.x, grid, bypass);
  const y = resizeAxis(base.y, base.height, vertical ? delta.height : 0, lower.includes('top'), frame.height, minimum.height, origin.y, grid, bypass);
  return { x: x.position, y: y.position, width: x.size, height: y.size };
}
