import React, { useContext, useEffect, useMemo, useState } from 'react';
import { ArrowSync16Regular, ArrowDownload16Regular, Pause16Regular, Play16Regular, Warning16Regular } from '@fluentui/react-icons';
import { canvasSignals, type CanvasWidget } from '../../../domain/canvas';
import { canvasPoint } from '../../../domain/canvas-binding';
import { pointKey } from '../../../shared/point-key';
import { NumericChart, type LineSeries } from '../../components/chart';
import { slaveCommunicationState, useApp, useWorkspace } from '../../store/app';
import { fmtEpochDateTime } from '../../time';
import type { WidgetPreview } from './preview';
import { CurveWindowContext } from './curve-window';
import { BufferRangeStatus } from '../buffers/range-status';
import { blockReadIssue } from '../devices/communication-status';

export const CURVE_COLORS = ['#0078D4', '#D97706', '#178A4D', '#7A5AF8', '#C42B1C', '#0E7C86'];

export function CanvasTrendView({ widget: w, editing, preview }: { widget: CanvasWidget; editing: boolean; preview?: WidgetPreview }) {
  const workspace = useWorkspace();
  const live = useApp(s => s.live);
  const connections = useApp(s => s.snapshot?.connections);
  const slaveStates = useApp(s => s.snapshot?.slaveStates);
  const blocks = useApp(s => s.snapshot?.blocks);
  const openOverlay = useApp(state => state.openOverlay);
  const refreshMs = useApp(state => state.selection.refreshMs ?? 100);
  const [windowOverride, setWindowOverride] = useState<number | null>(null);
  const [frozen, setFrozen] = useState<{ series: LineSeries[]; end: number } | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [previewEnd] = useState(() => Date.now());
  const simulation = editing ? preview : undefined;
  const period = windowOverride ?? w.windowSec;
  const reportWindow = useContext(CurveWindowContext);
  useEffect(() => {
    reportWindow(w.id, { windowMs: period * 1000, endMs: frozen?.end });
    return () => reportWindow(w.id, undefined);
  }, [reportWindow, w.id, period, frozen?.end]);
  const references = useMemo(() => canvasSignals({ signals: w.signals, binding: w.binding }), [w.signals, w.binding]);
  const series = useMemo(() => references.flatMap((binding, index) => {
    if (!workspace) return [];
    const { slave, point, connection } = canvasPoint(workspace, { ...w, binding });
    if (!slave || !point || !connection) return [];
    return [{ name: `${slave.name} · ${point.name}`, unit: point.unit, decimalPlaces: point.decimalPlaces,
      color: ('color' in binding && typeof binding.color === 'string' ? binding.color : undefined) ?? CURVE_COLORS[index % CURVE_COLORS.length]!,
      data: live[pointKey(slave.id, point.id)]?.samples ?? [] }];
  }), [workspace, w, live, references]);
  const end = Math.max(Date.now(), ...series.map(s => s.data.at(-1)?.[0] ?? 0));
  const pause = () => { if (!frozen) setFrozen({ series: series.map(s => ({ ...s, data: s.data.map(point => [...point] as [number, number, number?]) })), end }); };
  const follow = () => { setFrozen(null); setResetKey(key => key + 1); };
  const issues = references.flatMap(binding => {
    const target = workspace && canvasPoint(workspace, { ...w, binding });
    if (!target || !target.slave || !target.point || !target.connection) return ['绑定已失效'];
    const state = slaveCommunicationState(connections && { connections, slaveStates }, target.slave);
    const issue = blockReadIssue(state, blocks?.[pointKey(target.slave.id, target.point.blockId)]);
    if (!issue) return [];
    const fault = issue.title ? `${issue.label} · ${issue.title}` : issue.label;
    return [`${target.slave.name} / ${target.point.name} · ${fault}`];
  });
  const quality = simulation ? simulation.dataState === 'unavailable' ? '预览：未采集' : simulation.dataState === 'invalid' || !simulation.value.trim() || !Number.isFinite(Number(simulation.value)) ? '预览：无效值' : ''
    : issues.join('\n');
  const loading = references.some(binding => live[pointKey(binding.slaveId, binding.pointId)]?.loading);
  // Generated display samples are isolated from the shared live stream and persisted data.
  const previewSeries = useMemo(() => {
    if (!simulation) return [];
    const centre = Number(simulation.value);
    const valid = simulation.dataState === 'value' && simulation.value.trim() !== '' && Number.isFinite(centre);
    const amplitude = Math.max(Math.abs(centre) * .08, 1);
    const definitions = series.length ? series : [{ name: '预览信号', unit: '', color: w.color, data: [] }];
    return definitions.map((signal, index) => ({ ...signal, name: `${signal.name} · 预览`, data: valid ? Array.from({ length: 61 }, (_, tick): [number, number] => [previewEnd - (60 - tick) / 60 * period * 1000, centre + Math.sin(tick / 6 + index) * amplitude]).filter(sample => Number.isFinite(sample[1])) : [] }));
  }, [simulation, series, w.color, previewEnd, period]);
  const shown = simulation ? previewSeries : frozen?.series ?? series;
  const shownEnd = simulation ? previewEnd : frozen?.end ?? end;
  const units = [...new Set(shown.map(s => s.unit ?? ''))];
  const plots = units.length > 2 ? units.map(unit => shown.filter(s => (s.unit ?? '') === unit)) : [shown];
  const height = Math.max(120, w.height - 28 - (w.showLabel ? 18 : 0));
  return <div className="canvas-trend">
    <div className="canvas-trend-tools" style={{ pointerEvents: editing ? 'none' : undefined }}>
      <span className={simulation ? 'text-accent' : frozen ? 'text-warn' : 'text-ink2'} title={simulation ? '本地生成预览曲线，不写入历史' : frozen ? `暂停于 ${fmtEpochDateTime(frozen.end)}` : '跟随最新确认值'}>{simulation ? '模拟曲线' : frozen ? '已暂停' : '实时'}</span>
      {loading && !simulation && !frozen && <span role="status" className="text-ink2">加载中…</span>}
      <select aria-label={`${w.label} 时间窗口`} value={period} disabled={editing} onChange={e => { setWindowOverride(Number(e.target.value)); follow(); }}>
        {[...new Set([30, 60, 300, w.windowSec, period])].sort((a, b) => a - b).map(value => <option key={value} value={value}>{value < 60 ? `${value} 秒` : `${value / 60} 分钟`}</option>)}
      </select>
      <button title={frozen ? '恢复跟随' : '暂停曲线'} aria-label={frozen ? '恢复跟随' : '暂停曲线'} disabled={editing} onClick={frozen ? follow : pause}>{frozen ? <Play16Regular /> : <Pause16Regular />}</button>
      <button title="还原缩放并跟随" aria-label="还原缩放并跟随" disabled={editing} onClick={follow}><ArrowSync16Regular /></button>
      <button title="导出采样数据" aria-label={`${w.label} 导出采样数据`} disabled={editing || !references.length} onClick={() => openOverlay({ kind: 'dialog', id: 'buffer-export', points: references, name: w.label })}><ArrowDownload16Regular /></button>
      {quality && <span role="status" aria-label={quality} title={quality} className="ml-auto text-warn"><Warning16Regular /></span>}
    </div>
    {!simulation && <BufferRangeStatus points={references} live={live} paused={Boolean(frozen)} startMs={shownEnd - period * 1000} endMs={shownEnd} />}
    {!references.length && !simulation ? <div className="flex flex-1 items-center justify-center text-xs text-ink2">在属性中添加曲线信号</div> : <div className={`min-h-0 flex-1 ${plots.length > 1 ? 'overflow-y-auto' : 'overflow-hidden'}`}>
      {plots.map((plot, index) => <div key={index} style={{ width: '100%', height: plots.length === 1 ? '100%' : Math.max(120, height / plots.length) }}>
        <NumericChart series={plot} height="100%" startMs={shownEnd - period * 1000} endMs={shownEnd} interactive={!editing} resetKey={resetKey} updateIntervalMs={refreshMs} />
      </div>)}
    </div>}
  </div>;
}
