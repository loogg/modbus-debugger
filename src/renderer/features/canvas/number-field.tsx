import React, { useEffect, useState } from 'react';
import { useDirtyGuard } from '../../workbench/view-context';

/** Keep incomplete typing local; commit bounded geometry only on blur/Enter. */
export function CanvasNumberField({ label, value, min = -1e12, max = 1e12, onChange }: { label: string; value: number; min?: number; max?: number; onChange: (value: number) => void }) {
  const [text, setText] = useState(String(value));
  useDirtyGuard(text !== String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const parsed = Number(text);
    const next = text.trim() && Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : value;
    setText(String(next)); onChange(next);
  };
  return <label className="canvas-field">{label}<input type="number" aria-label={label} min={min} max={max} value={text} onChange={e => setText(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} /></label>;
}
