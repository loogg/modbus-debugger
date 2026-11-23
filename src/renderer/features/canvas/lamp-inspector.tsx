import React, { useEffect, useState } from 'react';
import { ArrowDown16Regular, ArrowUp16Regular, Delete16Regular } from '@fluentui/react-icons';
import type { CanvasWidget } from '../../../domain/canvas';
import type { PointDef } from '../../../domain/model';
import { canvasInputOptions } from '../../../domain/canvas-binding';
import { lampBackground, lampRuleSchema, type LampConfig, type LampRule, type LampStateStyle } from '../../../domain/canvas-lamp';
import { CanvasNumberField } from './number-field';
import { CanvasSelect } from './select';
import { uid } from '../../uid';
import { defaultLampRules } from './presets';
import { useDirtyGuard } from '../../workbench/view-context';
import { statusLampOptions } from './status-lamp';

function StateColorField({ label, color, onChange }: { label: string; color: string; onChange: (color: string) => void }) {
  const [text, setText] = useState(color);
  useEffect(() => setText(color), [color]);
  useDirtyGuard(text !== color);
  const commit = () => {
    const candidate = text.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(candidate)) { onChange(candidate); setText(candidate); }
    else setText(color);
  };
  return <label className="canvas-field">{label}<div className="flex min-w-0 gap-2">
    <input type="color" aria-label={label} value={color} style={{ width: 34, flexShrink: 0 }} onChange={event => { setText(event.target.value); onChange(event.target.value); }} />
    <input aria-label={`${label} HEX`} className="min-w-0 flex-1 font-mono" value={text} maxLength={7} onChange={event => setText(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
  </div></label>;
}

function StateStyleEditor({ prefix, style, theme, followTheme = false, onChange }: {
  prefix: string; style: LampStateStyle; theme: string; followTheme?: boolean; onChange: (style: LampStateStyle) => void;
}) {
  return <div className="space-y-3">
    <label className="canvas-field">状态文字<input aria-label={`${prefix} 文字`} value={style.label} maxLength={100} onChange={event => onChange({ ...style, label: event.target.value })} /></label>
    <StateColorField label={`${prefix} 颜色`} color={style.color ?? theme} onChange={color => onChange({ ...style, color })} />
    <label className="canvas-field">填充<CanvasSelect label={`${prefix} 填充`} value={style.fill.type}
        options={[{ value: 'solid', label: '纯色' }, { value: 'linear', label: '线性渐变' }, { value: 'radial', label: '径向渐变' }]}
        onChange={type => onChange({ ...style, fill: { ...style.fill, type: type as LampStateStyle['fill']['type'] } })} /></label>
    {followTheme && <label className="flex items-center gap-2 text-xs text-ink2"><input type="checkbox" checked={style.color === null} onChange={event => onChange({ ...style, color: event.target.checked ? null : theme })} />亮色跟随控件主题色</label>}
    {style.fill.type !== 'solid' && <StateColorField label={`${prefix} 渐变色`} color={style.fill.secondary} onChange={secondary => onChange({ ...style, fill: { ...style.fill, secondary } })} />}
    {style.fill.type === 'linear' && <CanvasNumberField label={`${prefix} 渐变角度`} min={0} max={360} value={style.fill.angle} onChange={angle => onChange({ ...style, fill: { ...style.fill, angle } })} />}
  </div>;
}

interface Props {
  widget: CanvasWidget;
  point?: PointDef;
  frame: { width: number; height: number };
  onChange: (patch: Partial<CanvasWidget>) => void;
}

export function CanvasLampInspector({ widget: w, point, frame, onChange }: Props) {
  const config = w.lamp;
  const deviceStatus = Boolean(w.binding && 'kind' in w.binding);
  const update = (patch: Partial<LampConfig>) => onChange({ lamp: { ...config, ...patch } });
  const updateRule = (id: string, patch: Partial<LampRule>) => update({ rules: config.rules.map(rule => rule.id === id ? { ...rule, ...patch } : rule) });
  const options = (deviceStatus ? statusLampOptions() : point ? canvasInputOptions(point).map(option => ({ ...option, color: '#0078D4' })) : [])
    .filter((option, index, all) => all.findIndex(candidate => Number(candidate.value) === Number(option.value)) === index);
  const missing = options.filter(option => !config.rules.some(rule => rule.match === 'equals' && rule.value === Number(option.value)));
  const importEnums = () => {
    const rules = options.map(option => {
      const existing = config.rules.find(rule => rule.match === 'equals' && rule.value === Number(option.value));
      const label = (option.label.trim() || option.value).slice(0, 100);
      return existing ? { ...existing, label } : lampRuleSchema.parse({ id: uid('state'), value: Number(option.value), label, color: option.color });
    });
    const rest = config.rules.filter(rule => !options.some(option => rule.match === 'equals' && rule.value === Number(option.value)));
    update({ rules: [...rules, ...rest] });
  };
  const move = (index: number, offset: number) => {
    const rules = [...config.rules];
    [rules[index], rules[index + offset]] = [rules[index + offset]!, rules[index]!];
    update({ rules });
  };
  const mode = (value: string) => {
    if (value === 'binary') { update({ mode: 'binary' }); return; }
    const width = Math.max(w.width, Math.min(160, frame.width));
    const height = Math.max(w.height, Math.min(28 + (w.showLabel ? 18 : 0), frame.height));
    onChange({ lamp: { ...config, mode: 'states', rules: config.rules.length ? config.rules : defaultLampRules() }, showStateText: true,
      width, height, x: Math.min(w.x, frame.width - width), y: Math.min(w.y, frame.height - height) });
  };
  return <section className="space-y-3 border-t border-line pt-4" aria-label="指示灯状态">
    <label className="canvas-field">显示模式<CanvasSelect label="指示灯模式" value={config.mode} onChange={mode}
      options={[{ value: 'binary', label: '亮 / 灭' }, { value: 'states', label: '多状态' }]} /></label>
    {config.mode === 'binary' ? <>
      <details className="canvas-state-editor" open><summary>亮灯</summary><StateStyleEditor prefix="亮灯" style={config.on} theme={w.color} followTheme onChange={on => update({ on })} /></details>
      <details className="canvas-state-editor"><summary>灭灯</summary><StateStyleEditor prefix="灭灯" style={config.off} theme={w.color} onChange={off => update({ off })} /></details>
      <p className="text-[11px] leading-5 text-ink2">{deviceStatus ? '在线时亮灯。' : '确认值为 0 时灭灯，非 0 时亮灯。Bool 使用 OFF/ON。'}</p>
    </> : <>
      <div className="flex flex-wrap gap-3 text-xs">
        <button className="focus-ring text-accent disabled:opacity-40" disabled={!options.length || config.rules.length + missing.length > 64} onClick={importEnums}>{deviceStatus ? '读取通信状态枚举' : '读取变量枚举'}</button>
        <button className="focus-ring text-accent disabled:opacity-40" disabled={config.rules.length >= 64} onClick={() => update({ rules: [...config.rules, lampRuleSchema.parse({ id: uid('state'), value: config.rules.length, label: `状态 ${config.rules.length + 1}`, color: '#0078D4' })] })}>添加状态</button>
      </div>
      <p className="text-[11px] leading-5 text-ink2">按顺序取第一条匹配。{deviceStatus ? '使用设备通信状态枚举值。' : point && Object.keys(point.enumMap).length ? '使用变量原始枚举值。' : '普通数值使用工程值，Bool 使用 0/1。'}可手动配置等值或区间。</p>
      {config.rules.map((rule, index) => {
        const prefix = `状态 ${index + 1}`;
        return <details key={rule.id} className="canvas-state-editor" open={index === 0}>
          <summary><span className="mr-1 inline-block h-2.5 w-2.5 rounded-full" style={{ background: lampBackground(rule, w.color) }} />{prefix} · {rule.label}</summary>
          <div className="mb-3 flex justify-end gap-1">
            <button className="workbench-tool" aria-label={`上移${prefix}`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp16Regular /></button>
            <button className="workbench-tool" aria-label={`下移${prefix}`} disabled={index === config.rules.length - 1} onClick={() => move(index, 1)}><ArrowDown16Regular /></button>
            <button className="workbench-tool" aria-label={`删除${prefix}`} onClick={() => update({ rules: config.rules.filter(item => item.id !== rule.id) })}><Delete16Regular /></button>
          </div>
          <label className="canvas-field">匹配方式<CanvasSelect label={`${prefix} 匹配方式`} value={rule.match}
            options={[{ value: 'equals', label: '等于' }, { value: 'range', label: '数值区间' }]}
            onChange={match => updateRule(rule.id, { match: match as LampRule['match'], ...(match === 'range' && rule.lower === null && rule.upper === null ? { lower: 0, upper: 100 } : {}) })} /></label>
          <div className="my-3 space-y-3">
            {rule.match === 'equals' ? <CanvasNumberField label={`${prefix} 匹配值`} value={rule.value} onChange={value => updateRule(rule.id, { value })} /> : <>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={rule.lower !== null} onChange={event => updateRule(rule.id, { lower: event.target.checked ? 0 : null })} />设置下限</label>
              {rule.lower !== null && <><CanvasNumberField label={`${prefix} 下限`} value={rule.lower} onChange={lower => updateRule(rule.id, { lower })} /><label className="flex items-center gap-2 text-xs"><input type="checkbox" aria-label={`${prefix} 包含下限`} checked={rule.includeLower} onChange={event => updateRule(rule.id, { includeLower: event.target.checked })} />包含下限</label></>}
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={rule.upper !== null} onChange={event => updateRule(rule.id, { upper: event.target.checked ? 100 : null })} />设置上限</label>
              {rule.upper !== null && <><CanvasNumberField label={`${prefix} 上限`} value={rule.upper} onChange={upper => updateRule(rule.id, { upper })} /><label className="flex items-center gap-2 text-xs"><input type="checkbox" aria-label={`${prefix} 包含上限`} checked={rule.includeUpper} onChange={event => updateRule(rule.id, { includeUpper: event.target.checked })} />包含上限</label></>}
            </>}
          </div>
          <StateStyleEditor prefix={prefix} style={rule} theme={w.color} onChange={style => updateRule(rule.id, style)} />
        </details>;
      })}
      {!config.rules.length && <p className="text-xs text-ink2">添加状态或读取变量枚举，当前使用默认状态。</p>}
    </>}
    <details className="canvas-state-editor"><summary>未匹配默认状态</summary>
      <StateStyleEditor prefix="默认状态" style={config.fallback} theme={w.color} onChange={fallback => update({ fallback })} />
      <p className="mt-2 text-[11px] leading-5 text-ink2">用于未匹配值或无效数值，未采集和离线另外显示通信质量。</p>
    </details>
  </section>;
}
