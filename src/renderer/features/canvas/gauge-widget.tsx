import React, { useId } from 'react';
import type { CanvasWidget } from '../../../domain/canvas';
import { formatEngineeringNumber } from '../../../domain/point-format';
import { canvasTextSize } from './style';

interface Props { widget: CanvasWidget; value: number | null; confirmed: string; unit: string; decimalPlaces?: number }
const polar = (radius: number, ratio: number) => {
  const angle = (135 + ratio * 270) * Math.PI / 180;
  return { x: 80 + Math.cos(angle) * radius, y: 80 + Math.sin(angle) * radius };
};

export function CanvasGauge({ widget: w, value, confirmed, unit, decimalPlaces }: Props) {
  const clipId = `tank-${useId().replace(/:/g, '')}`;
  const finite = value !== null && Number.isFinite(value);
  const ratio = finite && w.max > w.min ? Math.max(0, Math.min(1, (value - w.min) / (w.max - w.min))) : 0;
  const display = <div className="canvas-gauge-readout"><span className="tabular-nums">{confirmed}</span>{unit && <span>{unit}</span>}</div>;
  const limits = <div className="flex justify-between text-[10px] text-ink2"><span>{w.min}</span><span>{w.max}</span></div>;
  const needle = polar(42, ratio);
  return <div className={`canvas-gauge gauge-${w.gaugeStyle}`} role="meter" aria-label={w.label || '仪表'}
    aria-valuemin={w.min} aria-valuemax={w.max} aria-valuenow={finite ? value : undefined} aria-valuetext={`${confirmed} ${unit}`.trim()}>
    {w.gaugeStyle === 'arc' && <>
      <svg viewBox="0 0 160 94" className="min-h-0 w-full flex-1" aria-hidden="true">
        <path d="M16 80 A64 64 0 0 1 144 80" pathLength="100" fill="none" stroke="#DDE2E8" strokeWidth="10" strokeLinecap="round" />
        <path d="M16 80 A64 64 0 0 1 144 80" pathLength="100" fill="none" stroke={w.color} strokeWidth="10" strokeDasharray={`${ratio * 100} 100`} strokeLinecap="round" />
        <text x="80" y="74" textAnchor="middle" fill="currentColor" fontSize={canvasTextSize(w)}>{confirmed}</text>
      </svg>
      <div className="flex justify-between text-[10px] text-ink2"><span>{w.min}</span><span>{unit}</span><span>{w.max}</span></div>
    </>}
    {w.gaugeStyle === 'dial' && <svg viewBox="0 0 160 160" className="h-full w-full" aria-hidden="true">
      <path d="M37.574 122.426 A60 60 0 1 1 122.426 122.426" pathLength="100" fill="none" stroke="#DDE2E8" strokeWidth="9" />
      <path d="M37.574 122.426 A60 60 0 1 1 122.426 122.426" pathLength="100" fill="none" stroke={w.color} strokeWidth="9" strokeDasharray={`${ratio * 100} 100`} />
      {Array.from({ length: 11 }, (_, index) => {
        const start = polar(52, index / 10);
        const end = polar(index % 2 ? 48 : 45, index / 10);
        const label = polar(35, index / 10);
        return <g key={index}><line x1={start.x} y1={start.y} x2={end.x} y2={end.y} stroke="#62666F" strokeWidth="1" />
          {index % 2 === 0 && <text x={label.x} y={label.y + 3} textAnchor="middle" fontSize="8" fill="#62666F">{formatEngineeringNumber(w.min + (w.max - w.min) * index / 10, decimalPlaces)}</text>}
        </g>;
      })}
      {finite && <><line x1="80" y1="80" x2={needle.x} y2={needle.y} stroke={w.color} strokeWidth="2.5" strokeLinecap="round" /><circle cx="80" cy="80" r="4" fill={w.color} /></>}
      <text x="80" y="132" textAnchor="middle" fontSize={canvasTextSize(w)} fill="currentColor">{confirmed}</text>
      <text x="80" y="148" textAnchor="middle" fontSize="10" fill="#62666F">{unit}</text>
    </svg>}
    {w.gaugeStyle === 'bar' && <>
      {display}<div className="canvas-gauge-track"><div style={{ width: `${ratio * 100}%`, background: w.color }} /></div>{limits}
    </>}
    {w.gaugeStyle === 'vertical' && <>
      <svg viewBox="0 0 100 148" className="min-h-0 w-full flex-1" aria-hidden="true">
        <rect x="24" y="8" width="24" height="128" rx="3" fill="#DDE2E8" />
        <rect x="24" y={136 - ratio * 128} width="24" height={ratio * 128} rx="3" fill={w.color} />
        {Array.from({ length: 6 }, (_, index) => <g key={index}>
          <line x1="52" y1={136 - index * 25.6} x2="58" y2={136 - index * 25.6} stroke="#A8B1BE" />
          <text x="62" y={139 - index * 25.6} fontSize="9" fill="#62666F">{formatEngineeringNumber(w.min + (w.max - w.min) * index / 5, decimalPlaces)}</text>
        </g>)}
      </svg>{display}
    </>}
    {w.gaugeStyle === 'tank' && <>
      <svg viewBox="0 0 120 140" className="min-h-0 w-full flex-1" aria-hidden="true">
        <defs><clipPath id={clipId}><rect x="24" y="12" width="72" height="112" rx="8" /></clipPath></defs>
        <rect x="24" y="12" width="72" height="112" rx="8" fill="#E8ECF1" />
        {ratio > 0 && <path d={`M24 ${124 - ratio * 112} Q42 ${120 - ratio * 112} 60 ${124 - ratio * 112} T96 ${124 - ratio * 112} V124 H24 Z`} fill={w.color} fillOpacity=".75" clipPath={`url(#${clipId})`} />}
        <rect x="24" y="12" width="72" height="112" rx="8" fill="none" stroke="#A8B1BE" strokeWidth="1.5" />
        {[0, .25, .5, .75, 1].map(tick => <line key={tick} x1="84" x2="94" y1={124 - tick * 112} y2={124 - tick * 112} stroke="#62666F" />)}
        <text x="60" y="76" textAnchor="middle" fontSize="14" fill="#1A1C21">{finite ? `${Math.round(ratio * 100)}%` : '—'}</text>
      </svg>{display}{limits}
    </>}
  </div>;
}
