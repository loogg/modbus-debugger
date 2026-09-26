export interface WindowBounds { x: number; y: number; width: number; height: number }

function intersectionArea(a: WindowBounds, b: WindowBounds): number {
  const overlapWidth = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const overlapHeight = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return overlapWidth * overlapHeight;
}

/** Keep a restored window inside the nearest visible work area after monitor changes. */
export function clampToWorkAreas(window: WindowBounds, workAreas: WindowBounds[]): WindowBounds {
  if (workAreas.length === 0) return window;
  const area = workAreas.reduce((best, next) => intersectionArea(window, next) > intersectionArea(window, best) ? next : best);
  const width = Math.min(window.width, area.width);
  const height = Math.min(window.height, area.height);
  return {
    x: Math.max(area.x, Math.min(window.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(window.y, area.y + area.height - height)),
    width,
    height,
  };
}
