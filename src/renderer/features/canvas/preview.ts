import type { CanvasWidget } from '../../../domain/canvas';
import type { PointDef } from '../../../domain/model';
import type { PointViewState } from '../../../shared/snapshot';
import type { LampResult } from '../../../domain/canvas-lamp';
import { formatEngineeringNumber } from '../../../domain/point-format';

/** Editor-only display data. Never added to Workspace, AppStore or IPC payloads. */
export interface WidgetPreview {
  value: string;
  dataState: 'value' | 'unavailable' | 'invalid';
  uiState: 'normal' | 'disabled' | 'writing' | 'error';
  lampState: string;
}
export type PreviewDisplayValue = Omit<PointViewState, 'pointId' | 'slaveId'>;

export function previewValueType(widget: CanvasWidget, point?: PointDef): 'number' | 'bool' | 'text' {
  if (widget.kind === 'switch') return 'bool';
  if (widget.binding && 'kind' in widget.binding && widget.lamp.mode === 'binary') return 'bool';
  if (widget.kind === 'input') return widget.inputMode === 'text' ? 'text' : widget.inputMode === 'select' && point?.mapping.rawType === 'Bool' ? 'bool' : 'number';
  if (['gauge', 'trend'].includes(widget.kind)) return 'number';
  if (point?.mapping.rawType === 'String') return 'text';
  return point?.mapping.rawType === 'Bool' ? 'bool' : 'number';
}

export function defaultWidgetPreview(widget: CanvasWidget, point?: PointDef, current?: PointViewState): WidgetPreview {
  const type = previewValueType(widget, point);
  let value = '0';
  if (current?.hasValue) {
    if (type === 'bool') value = current.boolValue ? '1' : '0';
    else if (type === 'text') value = current.stringValue ?? '';
    else value = String(Object.keys(point?.enumMap ?? {}).length ? current.rawNumber ?? 0 : current.engNumber ?? 0);
  } else if (widget.kind === 'gauge' || widget.inputMode === 'slider') value = String((widget.min + widget.max) / 2);
  return { value, dataState: 'value', uiState: 'normal', lampState: 'auto' };
}

export function previewDisplayValue(widget: CanvasWidget, preview: WidgetPreview, point?: PointDef): PreviewDisplayValue {
  const result: PreviewDisplayValue = { hasValue: preview.dataState !== 'unavailable', finite: false, rawText: '—', engText: '—', rawNumber: null, engNumber: null, boolValue: null, stringValue: null, enumLabel: null };
  if (!result.hasValue) return result;
  if (preview.dataState === 'invalid') return { ...result, engText: '无效值', rawText: '无效值' };
  const type = previewValueType(widget, point);
  if (type === 'text') return { ...result, rawText: preview.value, engText: preview.value, stringValue: preview.value };
  if (type === 'bool') {
    const active = ['1', 'true', 'on'].includes(preview.value.toLowerCase());
    return { ...result, boolValue: active, rawText: active ? '1' : '0', engText: active ? 'ON' : 'OFF' };
  }
  const number = Number(preview.value);
  if (!preview.value.trim() || !Number.isFinite(number)) return { ...result, engText: '无效值', rawText: '无效值' };
  const enumLabel = point?.enumMap[String(number)] ?? null;
  return { ...result, finite: true, rawNumber: number, engNumber: number, enumLabel,
    rawText: String(number), engText: enumLabel ?? formatEngineeringNumber(number, point?.decimalPlaces) };
}

/** Force a state for visual inspection, including rules shadowed by earlier rules. */
export function previewLampResult(widget: CanvasWidget, preview: WidgetPreview, calculated: LampResult): LampResult {
  if (preview.lampState === 'fallback') return { ...calculated, style: widget.lamp.fallback, state: 'fallback', ruleId: undefined, invalid: false };
  if (widget.lamp.mode === 'binary' && (preview.lampState === 'on' || preview.lampState === 'off')) {
    return { ...calculated, style: widget.lamp[preview.lampState], state: preview.lampState, ruleId: undefined, invalid: false };
  }
  const rule = widget.lamp.rules.find(item => `rule:${item.id}` === preview.lampState);
  return rule ? { ...calculated, style: rule, state: 'rule', ruleId: rule.id, invalid: false } : calculated;
}
