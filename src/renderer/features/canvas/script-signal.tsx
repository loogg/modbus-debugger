import React, { useCallback, useEffect, useRef } from 'react';
import type { CanvasWidget } from '../../../domain/canvas';
import { variableAcceptsWidget } from '../../../domain/canvas-binding';
import { widgetKey, type SignalValue, type WidgetEvent } from '../../../domain/canvas-script';
import { scriptIsActive, scriptRunFor } from '../../../shared/script-run';
import { useApp, useWorkspace } from '../../store/app';
import { useViewWindow } from '../../workbench/view-context';

export function useCanvasSignal(w: CanvasWidget, canvasId: string, revision: number) {
  const binding = w.binding && 'kind' in w.binding && w.binding.kind !== 'slave-status' ? w.binding : null;
  const workspace = useWorkspace();
  const tag = binding?.kind === 'workspace-variable' ? workspace?.variables?.find(v => v.id === binding.variableId) : undefined;
  const script = binding?.kind === 'script-variable' ? workspace?.masterScripts?.find(s => s.id === binding.scriptId) : undefined;
  const run = useApp(s => script ? scriptRunFor(s.snapshot, script.id) : null);
  const key = widgetKey(canvasId, w.id);
  const current = useApp(s => {
    const signals = s.snapshot?.canvasSignals;
    if (binding?.kind === 'workspace-variable') return signals && Object.hasOwn(signals.variables, binding.variableId) ? signals.variables[binding.variableId] : tag?.initial;
    if (binding?.kind === 'script-event') return signals?.controls[key] ?? (w.kind === 'switch' ? false : undefined);
    return undefined;
  });
  const epoch = useApp(s => binding ? s.snapshot?.canvasSignals?.epoch : undefined);
  const listening = useApp(s => binding?.kind === 'script-event' && Object.values(s.snapshot?.scriptRuns ?? {}).some(r => scriptIsActive(r) &&
    r.events?.inputs?.some(input => input.kind === 'widget' && input.canvasId === canvasId && input.widgetId === w.id)));
  const command = useApp(s => s.command);
  let value: SignalValue | undefined = current, status = '', label = tag?.name ?? '';
  if (binding?.kind === 'script-event' && !listening) status = '无运行中的监听';
  if (binding?.kind === 'workspace-variable' && (!tag || !variableAcceptsWidget(w, tag.type))) { status = '绑定已失效'; value = undefined; }
  if (binding?.kind === 'script-variable') {
    label = `${script?.name ?? '脚本'} / ${binding.name}`;
    const row = run?.variableScopes.find(scope => scope.functionId === null)?.values.find(v => v.name === binding.name);
    const valid = script?.publishedVariables?.includes(binding.name);
    value = valid ? row?.value : undefined;
    status = !valid ? '绑定已失效' : !run ? '未运行' : !scriptIsActive(run) ? `${run.state === 'failed' ? '失败' : run.state === 'stopped' ? '已停止' : '已结束'} · ${row ? '末值' : '未赋值'}`
      : !row ? '未赋值' : '';
    if (valid && row && w.kind !== 'value' && (row.kind === 'integer64' || !variableAcceptsWidget(w, typeof row.value as 'boolean' | 'string' | 'number'))) {
      value = undefined;
      status = row.kind === 'integer64' ? '超出控件数值精度' : '变量与控件类型不匹配';
    }
  }
  const send = useCallback(async (event: WidgetEvent, value?: SignalValue) => {
    if (!epoch) throw new Error('工作区尚未就绪');
    const reply = await command<number>({ type: 'canvas.interact', epoch, actionId: crypto.randomUUID(), canvasId, widgetId: w.id, revision, event, value });
    if (!reply.ok) throw new Error(reply.error);
    return reply.value;
  }, [epoch, canvasId, w.id, revision, command]);
  const number = typeof value === 'number' ? value : null;
  const sample = value === undefined ? undefined : { hasValue: true, finite: typeof value !== 'number' || Number.isFinite(value),
    rawNumber: number, engNumber: number, boolValue: typeof value === 'boolean' ? value : null,
    stringValue: typeof value === 'string' ? value : null, engText: String(value) };
  return { binding, sample, status, label, send, listening };
}

export function CanvasEventButton({ text, disabled, send }: {
  text: string; disabled: boolean; send(event: WidgetEvent): void;
}) {
  const win = useViewWindow();
  const pressed = useRef<{ origin: string; send(event: WidgetEvent): void } | null>(null);
  const suppressClick = useRef(false);
  const end = useCallback((event: 'release' | 'cancel') => {
    const held = pressed.current;
    if (!held) return;
    pressed.current = null;
    suppressClick.current = event === 'cancel';
    held.send(event);
  }, []);
  useEffect(() => {
    if (disabled) return;
    const cancel = () => end('cancel');
    win.addEventListener('blur', cancel);
    return () => { win.removeEventListener('blur', cancel); cancel(); };
  }, [win, disabled, end]);
  const begin = (origin: string) => {
    if (pressed.current || disabled) return;
    suppressClick.current = false; pressed.current = { origin, send }; send('press');
  };
  return <button type="button" className="canvas-action focus-ring" disabled={disabled}
    onPointerDown={e => { if (e.button === 0 && e.isPrimary && !pressed.current) { begin(String(e.pointerId)); e.currentTarget.setPointerCapture(e.pointerId); } }}
    onPointerUp={e => {
      if (pressed.current?.origin !== String(e.pointerId)) return;
      const r = e.currentTarget.getBoundingClientRect();
      end(e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom ? 'release' : 'cancel');
    }}
    onPointerCancel={e => { if (pressed.current?.origin === String(e.pointerId)) end('cancel'); }}
    onLostPointerCapture={e => { if (pressed.current?.origin === String(e.pointerId)) end('cancel'); }}
    onBlur={() => end('cancel')}
    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!e.repeat) begin(e.key); } }}
    onKeyUp={e => { if (pressed.current?.origin === e.key) { e.preventDefault(); end('release'); send('click'); } }}
    onClick={e => { if (!suppressClick.current || e.detail === 0) send('click'); suppressClick.current = false; }}>{text}</button>;
}
