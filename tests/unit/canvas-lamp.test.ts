import { expect, it } from 'vitest';
import { lampBackground, lampConfigSchema, lampRuleSchema, resolveLamp, type LampValue } from '../../src/domain/canvas-lamp';
import { canvasWidgetSchema } from '../../src/domain/canvas';

const value = (number: number): LampValue => ({ hasValue: true, boolValue: null, engNumber: number, rawNumber: number });
const rule = (id: string, extra = {}) => lampRuleSchema.parse({ id, value: 1, label: id, color: '#178A4D', ...extra });

it('keeps old lamp colors and maps confirmed Bool and numeric values to binary states', () => {
  const widget = canvasWidgetSchema.parse({ id: 'old', kind: 'lamp', label: 'Old', x: 0, y: 0, width: 24, height: 24, color: '#123456' });
  expect(lampBackground(resolveLamp(widget.lamp, value(1), false).style, widget.color)).toBe('#123456');
  expect(lampBackground(resolveLamp(widget.lamp, value(0), false).style, widget.color)).toBe('#BFC6CE');
  expect(resolveLamp(widget.lamp, { ...value(99), boolValue: false }, false).state).toBe('off');
  expect(resolveLamp(widget.lamp, { ...value(0), boolValue: true }, false).state).toBe('on');
  expect(resolveLamp(widget.lamp, value(-1), false).state).toBe('on');
});

it('uses enum raw values consistently and engineering values for ordinary numeric rules', () => {
  const config = lampConfigSchema.parse({ mode: 'states', rules: [rule('enum', { value: 2 }), rule('scaled', { value: 20 })] });
  const scaled = { ...value(20), rawNumber: 2 };
  expect(resolveLamp(config, scaled, true).ruleId).toBe('enum');
  expect(resolveLamp(config, scaled, false).ruleId).toBe('scaled');
  expect(resolveLamp(lampConfigSchema.parse({}), { ...value(0), engNumber: null, rawNumber: 2 }, true).state).toBe('on');
});

it('matches interval endpoints, open-ended ranges and first-rule priority', () => {
  const config = lampConfigSchema.parse({ mode: 'states', rules: [
    rule('exact', { value: 60 }),
    rule('low', { match: 'range', upper: 60 }),
    rule('medium', { match: 'range', lower: 60, upper: 80 }),
    rule('high', { match: 'range', lower: 80 }),
  ] });
  expect([59, 60, 60.1, 79.99, 80].map(number => resolveLamp(config, value(number), false).ruleId)).toEqual(['low', 'exact', 'medium', 'medium', 'high']);
  const moved = { ...config, rules: [config.rules[2]!, ...config.rules.filter(item => item.id !== 'medium')] };
  expect(resolveLamp(moved, value(60), false).ruleId).toBe('medium');
  const exclusive = lampConfigSchema.parse({ mode: 'states', rules: [rule('interval', { match: 'range', lower: 1, upper: 2, includeLower: false, includeUpper: true })] });
  expect(resolveLamp(exclusive, value(1), false).state).toBe('fallback');
  expect(resolveLamp(exclusive, value(2), false).ruleId).toBe('interval');
});

it('uses the configured fallback for unmatched, unavailable and non-finite values', () => {
  const config = lampConfigSchema.parse({ mode: 'states', rules: [rule('one')], fallback: { label: '未定义', color: '#123456', fill: { type: 'radial' } } });
  expect(resolveLamp(config, value(5), false)).toMatchObject({ state: 'fallback', invalid: false, style: { label: '未定义', color: '#123456' } });
  expect(resolveLamp(config, undefined, false)).toMatchObject({ state: 'fallback', invalid: true });
  expect(resolveLamp(config, { ...value(1), hasValue: false }, false).invalid).toBe(true);
  expect(resolveLamp(config, value(NaN), false)).toMatchObject({ numericValue: null, invalid: true });
  expect(resolveLamp(config, value(Infinity), false).invalid).toBe(true);
  expect(resolveLamp(config, { ...value(2), engNumber: null }, false).invalid).toBe(true);
});

it('validates state definitions and keeps gradient settings explicit and portable', () => {
  expect(lampConfigSchema.safeParse({ rules: [rule('a'), rule('a')] }).success).toBe(false);
  expect(lampConfigSchema.safeParse({ rules: [rule('range', { match: 'range' })] }).success).toBe(false);
  expect(lampConfigSchema.safeParse({ rules: [rule('range', { match: 'range', lower: 80, upper: 60 })] }).success).toBe(false);
  expect(lampConfigSchema.safeParse({ on: { fill: { secondary: 'url(unsafe)' } } }).success).toBe(false);
  const config = lampConfigSchema.parse({ on: { color: '#178A4D', fill: { type: 'linear', secondary: '#FFFFFF', angle: 90 } } });
  expect(lampBackground(config.on, '#000000')).toBe('linear-gradient(90deg, #FFFFFF, #178A4D)');
  expect(lampBackground({ ...config.on, fill: { ...config.on.fill, type: 'radial' } }, '#000000')).toContain('radial-gradient');
});
