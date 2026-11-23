import React from 'react';
import { canvasPointBinding, canvasSignals, type CanvasDef, type CanvasWidget } from '../../../domain/canvas';
import { descendantIds, parentFrame, widgetMinimum } from '../../../domain/canvas-geometry';
import { bindingError } from '../../../domain/canvas-binding';
import { useApp, useWorkspace } from '../../store/app';
import { bufferCapacity } from '../../../domain/point-buffers';
import { WIDGET_LABELS } from './widget';
import { pointKey } from '../../../shared/point-key';
import { CanvasNumberField } from './number-field';
import { CURVE_COLORS } from './trend-widget';
import { GAUGE_STYLES, INPUT_MODES } from './presets';
import { CanvasStyleInspector } from './style-inspector';
import { CanvasLampInspector } from './lamp-inspector';
import { statusLampConfig } from './status-lamp';

const statusBindingKey = (slaveId: string) => `status:${encodeURIComponent(slaveId)}`;

export function CanvasInspector({ widget: w, canvas, onChange, onReparent, onFit }: { widget: CanvasWidget; canvas: CanvasDef; onChange: (patch: Partial<CanvasWidget>) => void; onReparent: (id: string | null) => void; onFit: () => void }) {
  const workspace = useWorkspace();
  const openOverlay = useApp(state => state.openOverlay);
  const points = (workspace?.slaves ?? []).flatMap(slave => {
    const template = workspace?.templates.find(t => t.id === slave.templateId);
    const connection = workspace?.connections.find(c => c.id === slave.connectionId);
    return (template?.points ?? []).map(point => ({ value: pointKey(slave.id, point.id), slave, point, label: `${connection?.name} / ${slave.name} / ${point.name}`, error: bindingError(w.kind, point, w.inputMode) }));
  });
  const pointBinding = canvasPointBinding(w.binding);
  const statusBinding = w.binding && 'kind' in w.binding ? w.binding : null;
  const binding = pointBinding ? pointKey(pointBinding.slaveId, pointBinding.pointId) : statusBinding ? statusBindingKey(statusBinding.slaveId) : '';
  const statusOptions = w.kind === 'lamp' ? (workspace?.slaves ?? []).flatMap(slave => {
    const connection = workspace?.connections.find(item => item.id === slave.connectionId);
    return connection ? [{ slaveId: slave.id, label: `${connection.name} / ${slave.name} · 通信状态` }] : [];
  }) : [];
  const bindingLabel = w.kind === 'lamp' ? '绑定变量' : '绑定点位';
  const pointOptions = points.map(p => <option value={p.value} key={p.value} disabled={Boolean(p.error)}>{p.label} · {p.point.mapping.rawType}{p.error ? `（${p.error}）` : ''}</option>);
  const bindingExists = points.some(p => p.value === binding) || statusOptions.some(option => statusBindingKey(option.slaveId) === binding);
  const frame = parentFrame(canvas, w);
  const changeBinding = (next: string) => {
    const device = statusOptions.find(option => statusBindingKey(option.slaveId) === next);
    if (device) {
      const binding = { kind: 'slave-status' as const, slaveId: device.slaveId };
      if (statusBinding) { onChange({ binding }); return; }
      const width = Math.max(w.width, Math.min(144, frame.width));
      const height = Math.max(w.height, Math.min(28 + (w.showLabel ? 18 : 0), frame.height));
      onChange({ binding, lamp: statusLampConfig(), showStateText: true, width, height,
        x: Math.min(w.x, frame.width - width), y: Math.min(w.y, frame.height - height) });
      return;
    }
    const point = points.find(item => item.value === next);
    onChange({ binding: point ? { slaveId: point.slave.id, pointId: point.point.id } : null });
  };
  const excluded = descendantIds(canvas, [w.id]);
  const minimum = widgetMinimum(w);
  const signals = canvasSignals(w);
  const number = (field: 'x' | 'y' | 'width' | 'height' | 'fontSize' | 'min' | 'max' | 'windowSec' | 'step', label: string, min?: number, max?: number) => <CanvasNumberField label={label} min={min} max={max ?? (['x', 'y', 'width', 'height'].includes(field) ? 8192 : undefined)} value={w[field]} onChange={value => onChange({ [field]: value })} />;
  return <div className="space-y-4">
    <div><div className="text-sm font-semibold">{w.kind === 'input' ? INPUT_MODES[w.inputMode] : w.kind === 'gauge' ? GAUGE_STYLES[w.gaugeStyle] : WIDGET_LABELS[w.kind]}属性</div><p className="mt-1 text-xs text-ink2">调整控件并保存到画布</p></div>
    <label className="canvas-field">名称<input aria-label="控件名称" maxLength={200} value={w.label} onChange={e => onChange({ label: e.target.value })} /></label>
    {w.kind === 'gauge' && <label className="canvas-field">仪表样式<select aria-label="仪表样式" value={w.gaugeStyle} onChange={event => onChange({ gaugeStyle: event.target.value as CanvasWidget['gaugeStyle'] })}>
      {Object.entries(GAUGE_STYLES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select></label>}
    {w.kind === 'input' && <label className="canvas-field">输入类型<select aria-label="输入类型" value={w.inputMode} onChange={event => {
      const inputMode = event.target.value as CanvasWidget['inputMode'];
      const current = points.find(item => item.value === binding);
      onChange({ inputMode, binding: current && bindingError('input', current.point, inputMode) ? null : w.binding });
    }}>{Object.entries(INPUT_MODES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
    <label className="canvas-field">所属容器<select aria-label="所属容器" value={w.parentId ?? ''} onChange={e => onReparent(e.target.value || null)}><option value="">画布根层</option>{canvas.widgets.filter(parent => parent.kind === 'container' && !excluded.has(parent.id)).map(parent => <option key={parent.id} value={parent.id}>{parent.label || '容器'}</option>)}</select></label>
    <div className="grid grid-cols-2 gap-3">{number('x', 'X', 0)}{number('y', 'Y', 0)}{number('width', '宽度', minimum.width)}{number('height', '高度', minimum.height)}</div>
    <button className="focus-ring text-xs text-accent" onClick={onFit}>适合内容</button>
    {!['text', 'container', 'trend'].includes(w.kind) && <label className="canvas-field">{bindingLabel}
      <select aria-label={bindingLabel} value={binding} onChange={e => changeBinding(e.target.value)}>
        <option value="">{w.kind === 'lamp' ? '选择状态或设备点位…' : '选择设备点位…'}</option>
        {binding && !bindingExists && <option value={binding}>绑定已失效，请重新选择</option>}
        {statusOptions.length > 0 && <optgroup label="设备通信状态">
          {statusOptions.map(item => <option key={item.slaveId} value={statusBindingKey(item.slaveId)}>{item.label}</option>)}
        </optgroup>}
        {w.kind === 'lamp' && pointOptions.length > 0 ? <optgroup label="设备点位">{pointOptions}</optgroup> : pointOptions}
      </select>
      <span className="font-normal text-ink2">{statusBinding ? '只读 · 随设备通信状态更新' : '沿用点位的单位、精度和读写权限。'}</span>
    </label>}
    {w.kind === 'trend' && <div className="space-y-3">
      <div className="text-xs font-medium text-ink2">曲线信号 · {signals.length}/16</div>
      {signals.map((signal, index) => {
        const key = pointKey(signal.slaveId, signal.pointId);
        const item = points.find(point => point.value === key);
        return <div key={key} className="space-y-1.5 border-b border-line pb-2 text-xs">
          <div className="flex items-center gap-2">
            <input aria-label={`曲线 ${index + 1} 颜色`} type="color" className="h-6 w-7 shrink-0 border-0 p-0"
              value={('color' in signal && typeof signal.color === 'string' ? signal.color : undefined) ?? CURVE_COLORS[index % CURVE_COLORS.length]}
              onChange={event => onChange({ binding: null, signals: signals.map((value, position) => position === index ? { ...value, color: event.target.value } : value) })} />
            <span className="min-w-0 flex-1 truncate" title={item?.label}>{item?.point.name ?? '绑定已失效'}</span>
            <button className="focus-ring shrink-0 text-ink2" aria-label={`移除曲线 ${index + 1}`} onClick={() => onChange({ binding: null, signals: signals.filter((_, position) => position !== index) })}>移除</button>
          </div>
          <button className="focus-ring text-accent" aria-label={`曲线 ${index + 1} 缓冲容量`} disabled={!item}
            onClick={() => openOverlay({ kind: 'dialog', id: 'point-buffer', pointRef: signal })}>共享容量 · {workspace ? bufferCapacity(workspace, signal).toLocaleString() : '—'} 点</button>
        </div>;
      })}
      <label className="canvas-field">添加信号<select aria-label="添加曲线信号" value="" disabled={signals.length >= 16} onChange={event => {
        const item = points.find(point => point.value === event.target.value);
        if (!item) return;
        const ref = { slaveId: item.slave.id, pointId: item.point.id };
        onChange({ binding: null, signals: [...signals, ref] });
        openOverlay({ kind: 'dialog', id: 'point-buffer', pointRef: ref });
      }}><option value="">选择数值点位…</option>{points.filter(point => !point.error && !signals.some(signal => pointKey(signal.slaveId, signal.pointId) === point.value)).map(point => <option key={point.value} value={point.value}>{point.label}{point.point.unit ? ` (${point.point.unit})` : ''}</option>)}</select></label>
      <p className="text-[11px] leading-5 text-ink2">每个信号按实际采样时间绘制。共享缓冲容量可在设备实例中修改。</p>
    </div>}
    {['text', 'button'].includes(w.kind) && <label className="canvas-field">{w.kind === 'text' ? '文本内容' : '按钮文字'}<textarea aria-label={w.kind === 'text' ? '文本内容' : '按钮文字'} rows={3} maxLength={2000} value={w.text} onChange={e => onChange({ text: e.target.value })} /></label>}
    {w.kind === 'button' && <label className="canvas-field">点击写入值<input aria-label="点击写入值" value={w.onValue} onChange={e => onChange({ onValue: e.target.value })} /><span className="font-normal text-ink2">一次点击发送一次写入，匹配的正常写应答表示成功。</span></label>}
    {w.kind === 'switch' && <p className="text-xs text-ink2">打开写入 1，关闭写入 0；开关位置始终反映设备确认值。</p>}
    {w.kind === 'lamp' && <CanvasLampInspector widget={w} point={points.find(item => item.value === binding)?.point} frame={frame} onChange={onChange} />}
    {w.kind === 'gauge' && <div className="grid grid-cols-2 gap-3">{number('min', '量程下限')}{number('max', '量程上限')}</div>}
    {w.kind === 'input' && w.inputMode === 'select' && <p className="text-xs leading-5 text-ink2">选项来自点位的枚举映射，Bool 默认提供 OFF/ON。选择后点击写入。</p>}
    {w.kind === 'input' && w.inputMode === 'text' && <p className="text-xs leading-5 text-ink2">绑定 String 点位，按其编码和长度写入。清空文本后写入可清除设备字符串。</p>}
    {w.kind === 'input' && ['number', 'stepper', 'slider'].includes(w.inputMode) && <>
      {number('step', '步长')}
      {w.inputMode !== 'slider' && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={w.limitInput} onChange={event => onChange({ limitInput: event.target.checked })} />限制输入范围</label>}
      {(w.inputMode === 'slider' || w.limitInput) && <div className="grid grid-cols-2 gap-3">{number('min', '输入下限')}{number('max', '输入上限')}</div>}
    </>}
    {w.kind === 'trend' && number('windowSec', '趋势窗口（秒）', 5, 3600)}
    <div className="space-y-2 text-xs">
      {w.kind !== 'text' && <label className="flex items-center gap-2"><input type="checkbox" checked={w.showLabel} onChange={e => onChange({ showLabel: e.target.checked, height: w.height + (e.target.checked && w.kind !== 'container' ? 18 : 0) })} />显示名称标签</label>}
      {['lamp', 'switch'].includes(w.kind) && <label className="flex items-center gap-2"><input type="checkbox" checked={w.showStateText} onChange={e => onChange({ showStateText: e.target.checked, width: e.target.checked ? Math.max(w.width, w.kind === 'lamp' ? 72 : 96) : w.width })} />{w.kind === 'lamp' ? '显示状态文字' : '显示 ON/OFF 文字'}</label>}
      {w.kind === 'input' && <label className="flex items-center gap-2"><input type="checkbox" checked={w.showConfirmed} onChange={e => onChange({ showConfirmed: e.target.checked, height: e.target.checked ? Math.max(w.height, 56 + (w.showLabel ? 18 : 0)) : w.height })} />显示设备确认值</label>}
      <label className="flex items-center gap-2"><input type="checkbox" checked={w.showBorder} onChange={e => onChange({ showBorder: e.target.checked })} />显示边框</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={w.showBackground} onChange={e => onChange({ showBackground: e.target.checked })} />填充背景</label>
    </div>
    <CanvasStyleInspector widget={w} frame={frame} onChange={onChange} />
  </div>;
}
