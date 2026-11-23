import React from 'react';
import type { CanvasWidget } from '../../../domain/canvas';
import { lampBackground, type LampResult } from '../../../domain/canvas-lamp';

export function CanvasLamp({ widget: w, result }: { widget: CanvasWidget; result: LampResult }) {
  const height = Math.max(12, w.height - w.padding * 2 - (w.showLabel ? 18 : 0));
  const diameter = Math.min(height, Math.max(12, w.width - w.padding * 2));
  return <div className="flex h-full w-full min-w-0 items-center gap-1.5" data-lamp-state={result.state} data-lamp-rule={result.ruleId ?? ''} data-lamp-value={result.numericValue ?? ''}>
    <span className="canvas-lamp shrink-0" role="img" aria-label={result.style.label} data-lamp-fill={result.style.fill.type}
      style={{ width: diameter, height: diameter, background: lampBackground(result.style, w.color), borderColor: w.borderColor ?? '#A8B1BE', borderWidth: w.borderWidth }} />
    {w.showStateText && <span className="min-w-0 truncate text-xs" title={result.style.label}>{result.style.label}</span>}
  </div>;
}
