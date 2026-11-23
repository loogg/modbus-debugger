import React from 'react';
import { Add16Regular, Subtract16Regular } from '@fluentui/react-icons';
import type { CanvasWidget } from '../../../domain/canvas';
import type { PointDef } from '../../../domain/model';
import { canvasInputOptions } from '../../../domain/canvas-binding';
import { formatEngineeringNumber } from '../../../domain/point-format';
import { CanvasSelect } from './select';
import { canvasAppearance } from './style';

interface Props {
  widget: CanvasWidget;
  point?: PointDef;
  disabled: boolean;
  tabIndex?: number;
  preview?: boolean;
  pending?: boolean;
  confirmed: string;
  confirmationLabel?: string;
  confirmedNumber: number | null;
  confirmedString: string;
  confirmedOption: string;
  draft: string | null;
  onDraft: (draft: string | null) => void;
  onWrite: (text: string) => void;
}

export function CanvasInput(props: Props) {
  const { widget: w, point, draft, disabled, onDraft, onWrite } = props;
  const options = point ? canvasInputOptions(point) : props.preview ? [{ value: props.confirmedOption || '0', label: `预览值 ${props.confirmedOption || '0'}` }] : [];
  const selected = props.confirmedOption === '' ? '' : options.find(option => Number(option.value) === Number(props.confirmedOption))?.value ?? props.confirmedOption;
  const bounded = w.inputMode === 'slider' || w.limitInput;
  const minimum = bounded ? w.min : undefined;
  const maximum = bounded ? w.max : undefined;
  const base = draft !== null && Number.isFinite(Number(draft)) ? Number(draft) : props.confirmedNumber ?? 0;
  const slider = Math.max(w.min, Math.min(w.max, base));
  const update = (text: string) => onDraft(text === '' && w.inputMode === 'number' ? null : text);
  const step = (direction: number) => {
    let next = Number((base + w.step * direction).toPrecision(15));
    if (bounded) next = Math.max(w.min, Math.min(w.max, next));
    onDraft(String(next));
  };
  const canSubmit = draft !== null && (w.inputMode === 'text' || draft.trim() !== '');
  const input = <input aria-label={`${w.label} 写入值`} type={w.inputMode === 'text' ? 'text' : 'number'}
    className="canvas-input-field focus-ring" value={draft ?? (w.inputMode === 'text' ? props.confirmedString : w.inputMode === 'stepper' ? props.confirmedNumber ?? '' : '')}
    step={w.step} min={minimum} max={maximum} maxLength={w.inputMode === 'text' ? point?.mapping.stringLength : undefined}
    onChange={event => update(event.target.value)} disabled={disabled} tabIndex={props.tabIndex}
    onKeyDown={event => { if (event.key === 'Enter' && canSubmit) onWrite(draft!); }} />;
  return <div className={`canvas-input input-${w.inputMode}`} data-appearance={canvasAppearance(w)}>
    <div className="canvas-input-row">
      {w.inputMode === 'stepper' && <button className="canvas-step focus-ring" tabIndex={props.tabIndex} aria-label={`${w.label} 减少`} disabled={disabled || (bounded && base <= w.min)} onClick={() => step(-1)}><Subtract16Regular /></button>}
      {w.inputMode === 'select' ? <CanvasSelect widget={w} label={`${w.label} 选择值`} value={draft ?? selected} disabled={disabled || !options.length} tabIndex={props.tabIndex}
        options={[
          ...(!selected || options.some(option => option.value === selected) ? [] : [{ value: selected, label: `未映射值 ${selected}`, disabled: true }]),
          ...options,
        ]} onChange={value => onDraft(value === selected ? null : value)} /> : w.inputMode === 'slider' ? <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between text-[10px] text-ink2"><span>{w.min}</span><output className="text-xs font-medium tabular-nums text-ink">{formatEngineeringNumber(slider, point?.decimalPlaces)} {point?.unit}</output><span>{w.max}</span></div>
        <input type="range" aria-label={`${w.label} 滑动值`} min={w.min} max={w.max} step={w.step} value={slider} disabled={disabled} tabIndex={props.tabIndex}
          className="block h-4 w-full" style={{ accentColor: w.color }} onChange={event => onDraft(event.target.value)} />
      </div> : input}
      {w.inputMode === 'stepper' && <button className="canvas-step focus-ring" tabIndex={props.tabIndex} aria-label={`${w.label} 增加`} disabled={disabled || (bounded && base >= w.max)} onClick={() => step(1)}><Add16Regular /></button>}
      <button className="canvas-input-submit focus-ring" tabIndex={props.tabIndex} style={{ background: w.color }} disabled={disabled || !canSubmit} onClick={() => onWrite(draft!)}>{props.pending ? '写入中…' : '写入'}</button>
    </div>
    {w.showConfirmed && <div className="mt-1 truncate text-[11px] text-ink2">{props.preview ? '预览值' : props.confirmationLabel ?? '确认值'}：{props.confirmed} {point?.unit}</div>}
  </div>;
}
