import React, { useEffect, useRef, useState } from 'react';
import { ArrowSync16Regular, Checkmark16Regular, Warning16Regular } from '@fluentui/react-icons';
import { canvasPointBinding, type CanvasWidget } from '../../../domain/canvas';
import { bindingError, canvasPoint } from '../../../domain/canvas-binding';
import { useApp, useSlaveState, useWorkspace } from '../../store/app';
import { slaveStatus } from '../../components/ui';
import { blockReadIssue } from '../devices/communication-status';
import { pointKey } from '../../../shared/point-key';
import type { PointWriteResult } from '../../../shared/contracts';
import { CanvasTrendView } from './trend-widget';
import { useDirtyGuard } from '../../workbench/view-context';
import { validateCanvasInput } from './write-value';
import { pointWriteFields } from '../../../domain/point-write-value';
import { CanvasGauge } from './gauge-widget';
import { CanvasInput } from './input-widget';
import { canvasAppearance, canvasTheme } from './style';
import { resolveLamp } from '../../../domain/canvas-lamp';
import { CanvasLamp } from './lamp-widget';
import { canWritePoint } from '../../../domain/point-access';
import { fmtEpochDateTimeMs } from '../../time';
import { previewDisplayValue, previewLampResult, type WidgetPreview } from './preview';
import { statusLampValue } from './status-lamp';
import { CanvasEventButton, useCanvasSignal } from './script-signal';
import type { WidgetEvent } from '../../../domain/canvas-script';

export const WIDGET_LABELS: Record<CanvasWidget['kind'], string> = { text: '文字标签', value: '数值显示', lamp: '指示灯', button: '按钮', switch: '开关', input: '数值输入', gauge: '仪表', trend: '趋势图', container: '容器' };

export function CanvasWidgetView({ widget: w, editing, preview, canvasId = '', revision = 0, active: viewActive = true }: {
  widget: CanvasWidget; editing: boolean; preview?: WidgetPreview; canvasId?: string; revision?: number; active?: boolean;
}) {
  const workspace = useWorkspace();
  const { point, slave, connection } = workspace ? canvasPoint(workspace, w) : {};
  const binding = canvasPointBinding(w.binding);
  const statusBinding = Boolean(w.binding && 'kind' in w.binding && w.binding.kind === 'slave-status');
  const signal = useCanvasSignal(w, canvasId, revision);
  const key = signal.binding ? JSON.stringify([canvasId, w.id, signal.binding]) : pointKey(binding?.slaveId, binding?.pointId ?? '');
  const confirmedValue = useApp(s => binding ? s.snapshot?.points[key] : undefined);
  const simulation = editing ? preview : undefined;
  const value = simulation ? previewDisplayValue(w, simulation, point) : signal.binding ? signal.sample : confirmedValue;
  const commandOnly = !simulation && point?.access === 'wo';
  const lastWrite = confirmedValue?.lastWrite;
  const accepted = commandOnly ? lastWrite?.accepted : undefined;
  const block = useApp(s => s.snapshot?.blocks[`${slave?.id}::${point?.blockId}`]);
  const deviceState = useSlaveState(slave);
  const writeState = useApp(s => s.writeStates[key]);
  const command = useApp(s => s.command);
  const openOverlay = useApp(s => s.openOverlay);
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState('');
  const currentTarget = useRef(key);
  currentTarget.current = key;
  useEffect(() => { setDraft(null); setFeedback(''); }, [key, w.inputMode]);
  useDirtyGuard(w.kind === 'input' && draft !== null);
  const typeError = point ? bindingError(w.kind, point, w.inputMode) : null;
  const validBinding = Boolean(slave && connection && (statusBinding || point));
  const lampValue = statusBinding && !simulation ? validBinding ? statusLampValue(deviceState, w.lamp.mode) : undefined : value;
  const calculatedLamp = w.kind === 'lamp' ? resolveLamp(w.lamp, lampValue, statusBinding || Boolean(point && Object.keys(point.enumMap).length)) : null;
  let lamp = calculatedLamp;
  if (lamp && simulation) lamp = previewLampResult(w, simulation, lamp);
  else if (lamp && validBinding && statusBinding && w.lamp.mode === 'binary' && deviceState !== 'online' && deviceState !== 'offline') {
    lamp = { ...lamp, style: { ...lamp.style, label: slaveStatus(deviceState).label } };
  }
  const deviceUnavailable = deviceState === 'offline' || deviceState === 'disabled' || deviceState === 'connecting';
  const issue = blockReadIssue(deviceState, commandOnly ? undefined : block);
  let quality = '';
  if (simulation) {
    if (simulation.uiState === 'error') quality = '预览：写入失败';
    else if (simulation.uiState === 'writing') quality = '预览：写入中';
    else if (simulation.uiState === 'disabled') quality = '预览：已禁用';
    else if (!value?.hasValue) quality = '预览：未采集';
    else if (lamp ? lamp.invalid : !value.finite && value.boolValue === null && value.stringValue === null) quality = '预览：无效值';
  } else if (signal.binding) {
    quality = signal.status;
  } else if (!['text', 'container', 'trend'].includes(w.kind)) {
    if (!w.binding) quality = '未绑定点位';
    else if (!validBinding) quality = '绑定已失效';
    else if (!statusBinding) quality = typeError ?? issue?.label ?? (commandOnly ? '' : !value?.hasValue ? '等待采集' : lamp?.invalid ? '数值无效' : '');
  }
  const disabled = simulation ? simulation.uiState === 'disabled' || simulation.uiState === 'writing'
    : editing || !viewActive || pending || (signal.binding ? signal.status === '绑定已失效' || signal.binding.kind === 'script-event' && !signal.listening
      : writeState?.phase === 'writing' || !point || !canWritePoint(point) || deviceUnavailable || Boolean(typeError));
  const shownPending = simulation ? simulation.uiState === 'writing' : pending || writeState?.phase === 'writing';
  const status = !simulation && !deviceUnavailable && feedback && feedback !== '写入成功' ? feedback : quality || (!simulation ? feedback : '');
  const statusTitle = !simulation && status === issue?.label && issue.title ? `${status} · ${issue.title}` : status;
  const confirmed = commandOnly ? accepted?.text || (accepted?.value === '' ? '（空字符串）' : '—') : value?.hasValue ? value.engText || (point?.mapping.rawType === 'String' ? '（空字符串）' : '') : '—';
  const active = commandOnly ? Boolean(accepted?.value) : value?.boolValue ?? ((value?.engNumber ?? 0) !== 0);
  const numericValue = commandOnly ? accepted?.engineering ?? null : value?.engNumber ?? value?.rawNumber ?? null;
  const number = (commandOnly ? Boolean(accepted) : value?.hasValue) && numericValue !== null && Number.isFinite(numericValue) ? numericValue : null;
  let confirmedOption = '';
  if (accepted) confirmedOption = typeof accepted.value === 'boolean' ? String(Number(accepted.value)) : String(accepted.value);
  else if (!commandOnly && value?.hasValue) confirmedOption = point?.mapping.rawType === 'Bool' || signal.binding && typeof value.boolValue === 'boolean' ? String(Number(value.boolValue)) : String(value.rawNumber ?? value.engNumber ?? '');
  const source = signal.label || (slave && (statusBinding ? `${slave.name} / 通信状态` : point ? `${slave.name} / ${point.name}` : ''));
  const description = [w.label, simulation ? '本地预览 · 不写入设备' : commandOnly ? '只写命令点' : '', source, !simulation && statusBinding && slave ? slaveStatus(deviceState).label : '', point || simulation ? `${simulation ? '预览值' : commandOnly ? '上次成功写入' : '确认值'}：${confirmed} ${point?.unit ?? ''}` : '', lastWrite ? `最后下发 ${lastWrite.attempted} · ${fmtEpochDateTimeMs(lastWrite.atMs)} · ${lastWrite.phase === 'confirmed' ? '写入成功' : lastWrite.phase === 'rejected' ? '设备拒绝' : lastWrite.phase === 'not-sent' ? '未发送' : '结果未知'}` : '', lamp ? `状态：${lamp.style.label}` : '', statusTitle].filter(Boolean).join('\n');

  const emit = (event: WidgetEvent, pressId?: string) => {
    void signal.send(event, undefined, pressId).then(() => {
      if (currentTarget.current === key) setFeedback('');
    }, error => { if (currentTarget.current === key) setFeedback(error instanceof Error ? error.message : String(error)); });
  };
  const write = async (text: string, confirmedRisk = false) => {
    if (editing || simulation || disabled) return;
    if (signal.binding) {
      try {
        setPending(true);
        const val = w.inputMode === 'text' ? text : w.inputMode === 'select' ? text === '1' : Number(text);
        if (w.kind === 'input' && w.inputMode !== 'text' && !text.trim()) throw new Error('请输入有效值');
        await signal.send(w.kind === 'switch' ? 'change' : 'submit', w.kind === 'input' ? val : undefined);
        setDraft(null); setFeedback('');
      } catch (e) { setFeedback(e instanceof Error ? e.message : String(e)); }
      finally { setPending(false); }
      return;
    }
    if (!point || !slave) return;
    try {
      const fields = pointWriteFields(point.mapping.rawType, text);
      if (w.kind === 'input') validateCanvasInput(w, text);
      if (point.highRisk && !confirmedRisk) {
        openOverlay({ kind: 'dialog', id: 'confirm', title: '确认设备写入', message: `向“${slave.name} / ${point.name}”写入 ${text || '空字符串'}？`, confirmLabel: '确认写入', danger: true, onConfirm: () => void write(text, true) });
        return;
      }
      setPending(true); setFeedback('等待写入应答…');
      useApp.setState(s => ({ writeStates: { ...s.writeStates, [key]: { phase: 'writing', attempted: text, at: Date.now(), exceptionCode: null } } }));
      const result = await command<PointWriteResult>({ type: 'point.write', slaveId: slave.id, pointId: point.id, ...fields });
      if (!result.ok) {
        if (currentTarget.current === key) setFeedback(result.error);
        useApp.setState(s => { const states = { ...s.writeStates }; delete states[key]; return { writeStates: states }; });
      } else {
        const phase = result.value.phase;
        useApp.setState(s => ({ writeStates: { ...s.writeStates, [key]: { phase, attempted: text, at: Date.now(), exceptionCode: result.value.exceptionCode } } }));
        if (currentTarget.current === key) {
          setFeedback(phase === 'confirmed' ? '写入成功' : phase === 'not-sent' ? '预读失败，未发送写入' : phase === 'rejected' ? `设备拒绝写入${result.value.exceptionCode === 1 ? '，设备不支持此功能码' : ''}` : '结果未知，请核对设备状态');
          if (phase === 'confirmed') setDraft(null);
        }
      }
    } catch (error) { if (currentTarget.current === key) setFeedback(error instanceof Error ? error.message : String(error)); }
    finally { setPending(false); }
  };

  return <div className="canvas-widget" data-kind={w.kind} data-editing={editing} data-preview={Boolean(simulation)} data-preview-state={simulation?.uiState} data-appearance={canvasAppearance(w)} title={description}
    style={{ ...canvasTheme(w), background: w.showBackground ? w.background : 'transparent', color: 'var(--canvas-text-color)', outline: w.showBorder ? 'var(--canvas-border-width) solid var(--canvas-border-color)' : undefined, borderRadius: w.borderRadius, padding: w.padding, fontWeight: w.textWeight ? 'var(--canvas-font-weight)' : undefined }}>
    {w.showLabel && w.kind !== 'text' && <div className="canvas-widget-label">{w.label}</div>}
    {simulation && <span className="canvas-preview-badge">预览</span>}
    {commandOnly && w.kind === 'switch' && <span className="canvas-command-badge">命令</span>}
    <div className="canvas-widget-content" style={{ pointerEvents: editing ? 'none' : undefined }}>
      {w.kind === 'text' && <div className="canvas-text" style={{ fontSize: w.fontSize }}>{w.text}</div>}
      {w.kind === 'value' && <div className="canvas-value"><span className="font-medium tabular-nums" style={{ fontSize: w.fontSize }}>{confirmed}</span>{point?.unit && <span className="ml-1.5 text-xs text-ink2">{point.unit}</span>}</div>}
      {lamp && <CanvasLamp widget={w} result={lamp} />}
      {w.kind === 'button' && (signal.binding ? <CanvasEventButton text={w.text} disabled={disabled || editing} send={emit} />
        : <button className="canvas-action focus-ring" tabIndex={editing ? -1 : undefined} disabled={disabled} onClick={() => void write(w.onValue)}>{shownPending ? '写入中…' : w.text}</button>)}
      {w.kind === 'switch' && <button role="switch" tabIndex={editing ? -1 : undefined} aria-checked={Boolean(active && (commandOnly ? accepted : value?.hasValue))} aria-label={w.label} className="focus-ring flex h-full items-center gap-1.5 disabled:opacity-50" disabled={disabled || !commandOnly && !value?.hasValue} onClick={() => void write(active ? '0' : '1')}><span className="relative h-6 w-11 shrink-0 rounded-full" style={{ background: active ? w.color : '#BFC6CE' }}><span className="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all" style={{ left: active ? 22 : 2 }} /></span>{w.showStateText && <span className="text-xs">{(commandOnly ? accepted : value?.hasValue) ? active ? 'ON' : 'OFF' : '—'}</span>}{shownPending && <ArrowSync16Regular className="spin" />}</button>}
      {w.kind === 'input' && <CanvasInput widget={w} point={point} disabled={disabled} confirmed={confirmed} confirmedNumber={number}
        scriptInput={!!signal.binding} confirmationLabel={signal.binding ? '当前值' : commandOnly ? '上次写入' : undefined} confirmedString={commandOnly ? typeof accepted?.value === 'string' ? accepted.value : '' : value?.hasValue ? value.stringValue ?? '' : ''} confirmedOption={confirmedOption} preview={Boolean(simulation)} pending={shownPending} tabIndex={editing ? -1 : undefined}
        draft={simulation ? value?.hasValue && simulation.dataState === 'value' ? simulation.value : null : draft} onDraft={editing ? () => undefined : setDraft} onWrite={text => void write(text)} />}
      {w.kind === 'gauge' && <CanvasGauge widget={w} value={number} confirmed={confirmed} unit={point?.unit ?? ''} decimalPlaces={point?.decimalPlaces} />}
      {w.kind === 'trend' && <CanvasTrendView widget={w} editing={editing} preview={simulation} />}
    </div>
    {signal.binding && status && !simulation ? <span className="canvas-signal-status" role="status" title={statusTitle}>{status}</span> :
      status && w.kind !== 'trend' && <span className={`canvas-widget-status ${simulation?.uiState === 'error' ? 'text-err' : status === '写入成功' ? 'text-ok' : 'text-warn'}`} title={statusTitle} role="status" aria-label={statusTitle}>{shownPending ? <ArrowSync16Regular className="spin" /> : status === '写入成功' ? <Checkmark16Regular /> : <Warning16Regular />}<span className="sr-only">{statusTitle}</span></span>}
  </div>;
}
