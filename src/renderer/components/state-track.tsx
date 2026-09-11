import React, { useEffect, useRef, useState } from 'react';
import { fmtDuration, fmtEpoch } from '../time';

export interface TrackEvent {
  tMs: number;
  value: string;
}

const ENUM_COLORS = ['#0078D4', '#C76C00', '#178A4D', '#7A5AF8', '#C42B1C', '#0E7C86'];

function useWidth(): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/**
 * Discrete / text signal track. Bool renders a digital waveform with edge times,
 * Enum renders named state segments with switch times, String renders change markers
 * (value above, time below). Colors are never the only state hint.
 */
export function StateTrack(props: {
  kind: 'bool' | 'enum' | 'string';
  label: string;
  sublabel?: string;
  color?: string;
  initialValue: string | null;
  events: TrackEvent[];
  startMs: number;
  endMs: number;
  height?: number;
  /** 'epoch' (default): tMs are wall-clock epoch ms; 'duration': ms since session start. */
  xMode?: 'epoch' | 'duration';
}) {
  const [ref, width] = useWidth();
  const height = props.height ?? 72;
  const fmtTime = props.xMode === 'duration' ? fmtDuration : fmtEpoch;
  const padL = 150;
  const padR = 16;
  const span = Math.max(1, props.endMs - props.startMs);
  const x = (t: number) => padL + ((t - props.startMs) / span) * (width - padL - padR);

  const segments: Array<{ from: number; to: number; value: string }> = [];
  let cur = props.initialValue;
  let curFrom = props.startMs;
  for (const ev of props.events) {
    if (cur !== null) segments.push({ from: curFrom, to: ev.tMs, value: cur });
    cur = ev.value;
    curFrom = ev.tMs;
  }
  if (cur !== null) segments.push({ from: curFrom, to: props.endMs, value: cur });

  return (
    <div ref={ref} className="w-full">
      <svg width={width} height={height} className="block">
        <text x={8} y={18} fontSize={12} fill="#1A1C21" fontWeight={600}>
          {props.label}
        </text>
        {props.sublabel ? (
          <text x={8} y={34} fontSize={11} fill="#62666F">
            {props.sublabel}
          </text>
        ) : null}
        <line x1={padL} x2={width - padR} y1={height - 14} y2={height - 14} stroke="#E7EAEE" />
        {props.kind === 'bool' &&
          (() => {
            const hi = 26;
            const lo = height - 20;
            const path: string[] = [];
            segments.forEach((seg, i) => {
              const on = seg.value === 'true' || seg.value === '1' || seg.value === 'ON';
              const y = on ? hi : lo;
              const x1 = x(seg.from);
              const x2 = x(seg.to);
              if (i === 0) path.push(`M ${x1} ${y}`);
              else path.push(`L ${x1} ${y}`);
              path.push(`L ${x2} ${y}`);
            });
            return (
              <g>
                <text x={padL - 34} y={hi + 4} fontSize={10} fill="#62666F">ON</text>
                <text x={padL - 34} y={lo + 4} fontSize={10} fill="#62666F">OFF</text>
                <path d={path.join(' ')} fill="none" stroke={props.color ?? '#178A4D'} strokeWidth={1.5} />
                {props.events.map((ev, i) => (
                  <text key={i} x={x(ev.tMs)} y={height - 2} fontSize={10} fill="#62666F" textAnchor="middle">
                    {fmtTime(ev.tMs)}
                  </text>
                ))}
              </g>
            );
          })()}
        {props.kind === 'enum' &&
          segments.map((seg, i) => {
            const idx = Math.max(0, parseInt(seg.value, 10) || 0);
            const color = ENUM_COLORS[idx % ENUM_COLORS.length];
            const x1 = x(seg.from);
            const x2 = x(seg.to);
            return (
              <g key={i}>
                <rect x={x1} y={20} width={Math.max(2, x2 - x1)} height={22} fill={color} opacity={0.18} rx={3} />
                {x2 - x1 > 44 ? (
                  <text x={(x1 + x2) / 2} y={35} fontSize={11} fill={color} textAnchor="middle" fontWeight={600}>
                    {seg.value}
                  </text>
                ) : null}
                {i > 0 ? (
                  <text x={x1} y={height - 2} fontSize={10} fill="#62666F" textAnchor="middle">
                    {fmtTime(seg.from)}
                  </text>
                ) : null}
              </g>
            );
          })}
        {props.kind === 'string' && (
          <g>
            <line x1={padL} x2={width - padR} y1={40} y2={40} stroke="#D9DEE5" strokeDasharray="3 3" />
            {props.initialValue !== null ? (
              <text x={padL + 4} y={30} fontSize={11} fill="#62666F">
                {props.initialValue}
              </text>
            ) : null}
            {props.events.map((ev, i) => (
              <g key={i}>
                <circle cx={x(ev.tMs)} cy={40} r={4} fill={props.color ?? '#7A5AF8'} />
                <text x={x(ev.tMs)} y={26} fontSize={11} fill={props.color ?? '#7A5AF8'} textAnchor="middle" fontWeight={600}>
                  {ev.value}
                </text>
                <text x={x(ev.tMs)} y={height - 2} fontSize={10} fill="#62666F" textAnchor="middle">
                  {fmtTime(ev.tMs)}
                </text>
              </g>
            ))}
          </g>
        )}
      </svg>
    </div>
  );
}