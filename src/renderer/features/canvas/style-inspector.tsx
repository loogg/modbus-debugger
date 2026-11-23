import React from 'react';
import type { CanvasWidget } from '../../../domain/canvas';
import { CanvasNumberField } from './number-field';
import { CanvasSelect } from './select';
import { canvasTextSize } from './style';
import { inputRowHeight } from '../../../domain/canvas-geometry';

export function CanvasStyleInspector({ widget: w, frame, onChange }: { widget: CanvasWidget; frame: { width: number; height: number }; onChange: (patch: Partial<CanvasWidget>) => void }) {
  const color = (label: string, value: string, field: 'color' | 'textColor' | 'borderColor' | 'background') => <label className="canvas-field">{label}<input type="color" aria-label={label} value={value} onChange={event => onChange({ [field]: event.target.value })} /></label>;
  const resize = (patch: Partial<CanvasWidget>, dx: number, dy: number) => {
    const width = Math.max(16, Math.min(frame.width, w.width + dx));
    const height = Math.max(16, Math.min(frame.height, w.height + dy));
    onChange({ ...patch, width, height, x: Math.min(w.x, frame.width - width), y: Math.min(w.y, frame.height - height) });
  };
  return <section className="space-y-3 border-t border-line pt-4" aria-label="控件样式">
    <div className="flex items-center justify-between"><h3 className="text-xs font-semibold text-ink2">样式</h3><button className="focus-ring text-xs text-accent" onClick={() => onChange({ appearance: 'auto', textColor: null, textSize: null, textWeight: null, textAlign: null, borderColor: null, borderWidth: 1, borderRadius: 6, padding: 0, fontSize: 20, showBorder: w.kind === 'container', showBackground: false, background: '#FFFFFF' })}>恢复默认样式</button></div>
    {['input', 'button'].includes(w.kind) && <label className="canvas-field">外观<CanvasSelect label="控件外观" value={w.appearance} onChange={appearance => onChange({ appearance: appearance as CanvasWidget['appearance'] })}
      options={[{ value: 'auto', label: '默认' }, { value: 'outline', label: '描边' }, { value: 'soft', label: '柔和填充' }, { value: 'solid', label: '实色填充' }, { value: 'underline', label: '下划线' }]} /></label>}
    <div className="grid grid-cols-2 gap-3">
      <CanvasNumberField label="字号" value={canvasTextSize(w)} min={10} max={72} onChange={value => {
        if (['text', 'value'].includes(w.kind)) onChange({ fontSize: value });
        else resize({ textSize: value }, 0, w.kind === 'input' ? inputRowHeight(value) - inputRowHeight(canvasTextSize(w)) : 0);
      }} />
      <label className="canvas-field">字重<CanvasSelect label="文字字重" value={w.textWeight ?? 'default'} onChange={value => onChange({ textWeight: value === 'default' ? null : value as CanvasWidget['textWeight'] })}
        options={[{ value: 'default', label: '默认' }, { value: 'normal', label: '常规' }, { value: 'medium', label: '中等' }, { value: 'bold', label: '加粗' }]} /></label>
    </div>
    {['text', 'value', 'button', 'input'].includes(w.kind) && <label className="canvas-field">文字对齐<CanvasSelect label="文字对齐" value={w.textAlign ?? 'default'} onChange={value => onChange({ textAlign: value === 'default' ? null : value as CanvasWidget['textAlign'] })}
      options={[{ value: 'default', label: '默认' }, { value: 'left', label: '左对齐' }, { value: 'center', label: '居中' }, { value: 'right', label: '右对齐' }]} /></label>}
    <div className="grid grid-cols-2 gap-3">
      {color('控件主题色', w.color, 'color')}{color('文字颜色', w.textColor ?? (['text', 'value', 'gauge'].includes(w.kind) ? w.color : '#1A1C21'), 'textColor')}
      {color('边框颜色', w.borderColor ?? (w.kind === 'container' ? w.color : '#D9DEE5'), 'borderColor')}
      {w.showBackground && color('控件背景色', w.background, 'background')}
    </div>
    <div className="grid grid-cols-2 gap-3">
      <CanvasNumberField label="边框粗细" value={w.borderWidth} min={1} max={8} onChange={borderWidth => onChange({ borderWidth })} />
      <CanvasNumberField label="圆角" value={w.borderRadius} min={0} max={32} onChange={borderRadius => onChange({ borderRadius })} />
      {w.kind !== 'container' && <CanvasNumberField label="内边距" value={w.padding} min={0} max={32} onChange={padding => resize({ padding }, (padding - w.padding) * 2, (padding - w.padding) * 2)} />}
    </div>
  </section>;
}
