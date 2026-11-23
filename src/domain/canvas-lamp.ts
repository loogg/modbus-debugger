import { z } from 'zod';

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const lampModeSchema = z.enum(['binary', 'states']);
export const lampFillSchema = z.object({
  type: z.enum(['solid', 'linear', 'radial']).default('solid'),
  secondary: color.default('#FFFFFF'),
  angle: z.number().finite().min(0).max(360).default(135),
});
export const lampStateStyleSchema = z.object({
  label: z.string().trim().min(1).max(100).default('状态'),
  color: color.nullable().default(null),
  fill: lampFillSchema.default({}),
});
export const lampRuleSchema = lampStateStyleSchema.extend({
  id: z.string().min(1).max(200),
  match: z.enum(['equals', 'range']).default('equals'),
  value: z.number().finite().default(0),
  lower: z.number().finite().nullable().default(null),
  upper: z.number().finite().nullable().default(null),
  includeLower: z.boolean().default(true),
  includeUpper: z.boolean().default(false),
});
export const lampConfigSchema = z.object({
  mode: lampModeSchema.default('binary'),
  on: lampStateStyleSchema.default({ label: 'ON' }),
  off: lampStateStyleSchema.default({ label: 'OFF', color: '#BFC6CE' }),
  fallback: lampStateStyleSchema.default({ label: '未知', color: '#94A3B8' }),
  rules: z.array(lampRuleSchema).max(64).default([]),
}).superRefine((config, context) => {
  if (new Set(config.rules.map(rule => rule.id)).size !== config.rules.length) context.addIssue({ code: 'custom', message: '指示灯状态 ID 重复' });
  config.rules.forEach((rule, index) => {
    if (rule.match !== 'range') return;
    if (rule.lower === null && rule.upper === null) context.addIssue({ code: 'custom', path: ['rules', index], message: '状态区间至少配置一个边界' });
    if (rule.lower !== null && rule.upper !== null && rule.lower >= rule.upper) context.addIssue({ code: 'custom', path: ['rules', index], message: '状态区间上限必须大于下限' });
  });
});
export type LampConfig = z.infer<typeof lampConfigSchema>;
export type LampStateStyle = z.infer<typeof lampStateStyleSchema>;
export type LampRule = z.infer<typeof lampRuleSchema>;
export interface LampValue {
  hasValue: boolean;
  boolValue: boolean | null;
  engNumber: number | null;
  rawNumber: number | null;
}
export interface LampResult {
  style: LampStateStyle;
  state: 'on' | 'off' | 'rule' | 'fallback';
  ruleId?: string;
  numericValue: number | null;
  invalid: boolean;
}

export function resolveLamp(config: LampConfig, value: LampValue | undefined, preferRaw: boolean): LampResult {
  let numericValue: number | null = null;
  if (value?.hasValue) {
    if (typeof value.boolValue === 'boolean') numericValue = value.boolValue ? 1 : 0;
    else numericValue = preferRaw ? value.rawNumber : value.engNumber;
  }
  if (numericValue === null || !Number.isFinite(numericValue)) return { style: config.fallback, state: 'fallback', numericValue: null, invalid: true };
  if (config.mode === 'binary') {
    const state = numericValue === 0 ? 'off' : 'on';
    return { style: config[state], state, numericValue, invalid: false };
  }
  const rule = config.rules.find(candidate => {
    if (candidate.match === 'equals') return numericValue === candidate.value;
    const lower = candidate.lower === null || (candidate.includeLower ? numericValue >= candidate.lower : numericValue > candidate.lower);
    const upper = candidate.upper === null || (candidate.includeUpper ? numericValue <= candidate.upper : numericValue < candidate.upper);
    return lower && upper;
  });
  if (rule) return { style: rule, state: 'rule', ruleId: rule.id, numericValue, invalid: false };
  return { style: config.fallback, state: 'fallback', numericValue, invalid: false };
}

export function lampBackground(style: LampStateStyle, themeColor: string): string {
  const primary = style.color ?? themeColor;
  if (style.fill.type === 'linear') return `linear-gradient(${style.fill.angle}deg, ${style.fill.secondary}, ${primary})`;
  if (style.fill.type === 'radial') return `radial-gradient(circle at 30% 25%, ${style.fill.secondary}, ${primary} 75%)`;
  return primary;
}
