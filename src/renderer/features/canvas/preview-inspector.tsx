import React from 'react';
import { canvasPointBinding, type CanvasWidget } from '../../../domain/canvas';
import { canvasPoint, canvasInputOptions } from '../../../domain/canvas-binding';
import { useApp, useSlaveState, useWorkspace } from '../../store/app';
import { pointKey } from '../../../shared/point-key';
import { CanvasSelect } from './select';
import { defaultWidgetPreview, previewValueType, type WidgetPreview } from './preview';
import { statusLampOptions, statusLampValue } from './status-lamp';

interface Props { widget: CanvasWidget; preview?: WidgetPreview; onChange: (preview: WidgetPreview | undefined) => void }
export function CanvasPreviewInspector({ widget: w, preview, onChange }: Props) {
  const workspace = useWorkspace();
  const { point, slave } = workspace ? canvasPoint(workspace, w) : {};
  const binding = canvasPointBinding(w.binding);
  const current = useApp(state => binding ? state.snapshot?.points[pointKey(binding.slaveId, binding.pointId)] : undefined);
  const deviceStatus = Boolean(w.binding && 'kind' in w.binding);
  const state = useSlaveState(deviceStatus ? slave : undefined);
  if (['text', 'container'].includes(w.kind)) return null;
  const update = (patch: Partial<WidgetPreview>) => onChange({ ...preview!, ...patch });
  const type = previewValueType(w, point);
  const states = w.lamp.mode === 'binary'
    ? [{ value: 'on', label: `亮灯 · ${w.lamp.on.label}` }, { value: 'off', label: `灭灯 · ${w.lamp.off.label}` }]
    : w.lamp.rules.map((rule, index) => ({ value: `rule:${rule.id}`, label: `${index + 1} · ${rule.label}` }));
  const lampOptions = [{ value: 'auto', label: '按模拟值匹配' }, ...states, { value: 'fallback', label: `默认状态 · ${w.lamp.fallback.label}` }];
  const lampSelection = lampOptions.some(option => option.value === preview?.lampState) ? preview!.lampState : 'auto';
  const changeSource = (source: string) => {
    if (source === 'device') { onChange(undefined); return; }
    const initial = defaultWidgetPreview(w, point, current);
    if (deviceStatus && slave) {
      const sample = statusLampValue(state, w.lamp.mode);
      initial.value = String(sample.boolValue === null ? sample.rawNumber : Number(sample.boolValue));
    }
    onChange(initial);
  };
  return <section className="mb-5 space-y-3 rounded border border-accent/20 bg-accentsoft/40 p-3" aria-label="控件状态预览">
    <div className="text-xs font-semibold text-ink">状态预览</div>
    <label className="canvas-field">数据源<CanvasSelect label="预览数据源" value={preview ? 'local' : 'device'}
      options={[{ value: 'device', label: '跟随设备' }, { value: 'local', label: '模拟预览' }]}
      onChange={changeSource} /></label>
    {preview && <>
      <p className="text-[11px] leading-5 text-accent">本地预览，运行模式使用设备确认值。</p>
      {w.kind === 'trend' && <p className="text-[11px] leading-5 text-ink2">以模拟值为中心生成示例波形。</p>}
      {w.kind === 'lamp' && <label className="canvas-field">灯状态<CanvasSelect label="预览灯状态" value={lampSelection} options={lampOptions} onChange={lampState => update({ lampState, dataState: 'value' })} /></label>}
      {(w.kind !== 'lamp' || lampSelection === 'auto') && <>
        <label className="canvas-field">数据状态<CanvasSelect label="预览数据状态" value={preview.dataState}
          options={[{ value: 'value', label: '正常值' }, { value: 'unavailable', label: '未采集' }, { value: 'invalid', label: '无效值' }]}
          onChange={dataState => update({ dataState: dataState as WidgetPreview['dataState'] })} /></label>
        {preview.dataState === 'value' && (type === 'bool'
          ? <label className="canvas-field">模拟开关值<CanvasSelect label="模拟开关值" value={preview.value === '1' ? '1' : '0'} options={[{ value: '0', label: 'OFF / 0' }, { value: '1', label: 'ON / 1' }]} onChange={value => update({ value })} /></label>
          : deviceStatus ? <label className="canvas-field">模拟通信状态<CanvasSelect label="模拟通信状态" value={preview.value} options={statusLampOptions()} onChange={value => update({ value })} /></label>
          : <label className="canvas-field">{type === 'text' ? '模拟文本' : '模拟值'}<input aria-label={type === 'text' ? '预览文本' : '预览数值'} type={type === 'text' ? 'text' : 'number'} step="any" value={preview.value} maxLength={type === 'text' ? 2000 : undefined} onChange={event => update({ value: event.target.value })} /></label>)}
        {preview.dataState === 'value' && point && Object.keys(point.enumMap).length > 0 && <label className="canvas-field">枚举快捷值<CanvasSelect label="预览枚举快捷值" value={preview.value} options={canvasInputOptions(point)} onChange={value => update({ value })} /></label>}
        {w.kind === 'gauge' && <div className="flex gap-3 text-xs text-accent">
          <button className="focus-ring" onClick={() => update({ value: String(w.min), dataState: 'value' })}>最小值</button>
          <button className="focus-ring" onClick={() => update({ value: String((w.min + w.max) / 2), dataState: 'value' })}>中间值</button>
          <button className="focus-ring" onClick={() => update({ value: String(w.max), dataState: 'value' })}>最大值</button>
        </div>}
      </>}
      {['input', 'button', 'switch'].includes(w.kind) && <label className="canvas-field">控件状态<CanvasSelect label="预览控件状态" value={preview.uiState}
        options={[{ value: 'normal', label: '正常' }, { value: 'disabled', label: '禁用' }, { value: 'writing', label: '写入中' }, { value: 'error', label: '失败' }]}
        onChange={uiState => update({ uiState: uiState as WidgetPreview['uiState'] })} /></label>}
    </>}
  </section>;
}
