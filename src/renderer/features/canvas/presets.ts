import { z } from 'zod';
import { gaugeStyleSchema, inputModeSchema, widgetKindSchema, type GaugeStyle, type InputMode } from '../../../domain/canvas';
import { lampModeSchema, lampRuleSchema, type LampRule } from '../../../domain/canvas-lamp';
import { uid } from '../../uid';

export const widgetPresetSchema = z.object({ kind: widgetKindSchema, gaugeStyle: gaugeStyleSchema.optional(), inputMode: inputModeSchema.optional(), lampMode: lampModeSchema.optional() });
export type WidgetPreset = z.infer<typeof widgetPresetSchema>;
export const GAUGE_STYLES: Record<GaugeStyle, string> = { arc: '半圆仪表', dial: '指针表盘', bar: '横向条形', vertical: '纵向条形', tank: '液位仪表' };
export const INPUT_MODES: Record<InputMode, string> = { number: '数值输入', text: '文本输入', select: '下拉选择', stepper: '步进输入', slider: '滑块输入' };

export function defaultLampRules(): LampRule[] {
  return [
    { value: 0, label: '停止', color: '#94A3B8' },
    { value: 1, label: '运行', color: '#178A4D' },
    { value: 2, label: '故障', color: '#C42B1C' },
  ].map(state => lampRuleSchema.parse({ ...state, id: uid('state') }));
}

export function parseWidgetPreset(raw: string): WidgetPreset | null {
  try { return widgetPresetSchema.parse(JSON.parse(raw)); }
  catch { return null; }
}
