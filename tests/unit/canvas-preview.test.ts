import { expect, it } from 'vitest';
import { canvasWidgetSchema } from '../../src/domain/canvas';
import { lampConfigSchema, resolveLamp } from '../../src/domain/canvas-lamp';
import { defaultWidgetPreview, previewDisplayValue, previewLampResult } from '../../src/renderer/features/canvas/preview';
import { templateWorkspace } from '../support/template-workspace';

const widget = canvasWidgetSchema.parse({ id: 'preview', kind: 'gauge', label: '预览', x: 0, y: 0, width: 200, height: 120, min: 10, max: 30 });
const point = templateWorkspace().templates[0]!.points[0]!;

it('projects engineering values, enums, booleans and explicit empty text without changing the definition', () => {
  const preview = { ...defaultWidgetPreview(widget), value: '22.5' };
  expect(previewDisplayValue(widget, preview, point)).toMatchObject({ engNumber: 22.5, hasValue: true, finite: true });
  const enumPoint = { ...point, enumMap: { '2': '运行' } };
  expect(previewDisplayValue(widget, { ...preview, value: '2' }, enumPoint)).toMatchObject({ rawNumber: 2, enumLabel: '运行', engText: '运行' });
  expect(previewDisplayValue({ ...widget, kind: 'switch' }, { ...preview, value: '1' })).toMatchObject({ boolValue: true });
  expect(previewDisplayValue({ ...widget, kind: 'input', inputMode: 'text' }, { ...preview, value: '' })).toMatchObject({ stringValue: '', hasValue: true });
  expect(widget.min).toBe(10);
  expect(defaultWidgetPreview(widget).value).toBe('20');
});

it('distinguishes unavailable and invalid values and rejects non-finite or blank numeric previews', () => {
  const preview = defaultWidgetPreview(widget);
  expect(previewDisplayValue(widget, { ...preview, dataState: 'unavailable' })).toMatchObject({ hasValue: false, engNumber: null });
  for (const value of ['', 'NaN', 'Infinity', '1e999']) {
    expect(previewDisplayValue(widget, { ...preview, value })).toMatchObject({ hasValue: true, finite: false, engNumber: null });
  }
  expect(previewDisplayValue(widget, { ...preview, dataState: 'invalid' })).toMatchObject({ engText: '无效值', engNumber: null });
});

it('previews shadowed rules and the fallback independently of matching, then restores automatic matching', () => {
  const lamp = { ...widget, kind: 'lamp' as const, lamp: lampConfigSchema.parse({ mode: 'states', rules: [{ id: 'first', value: 0, label: '先匹配' }, { id: 'shadowed', value: 0, label: '被覆盖', color: '#7A5AF8' }] }) };
  const preview = { ...defaultWidgetPreview(lamp), value: '0' };
  const calculated = resolveLamp(lamp.lamp, previewDisplayValue(lamp, preview), false);
  expect(calculated.ruleId).toBe('first');
  expect(previewLampResult(lamp, { ...preview, lampState: 'rule:shadowed' }, calculated)).toMatchObject({ ruleId: 'shadowed', style: { label: '被覆盖' } });
  expect(previewLampResult(lamp, { ...preview, lampState: 'fallback' }, calculated)).toMatchObject({ state: 'fallback', ruleId: undefined });
  expect(previewLampResult(lamp, { ...preview, lampState: 'rule:deleted' }, calculated)).toBe(calculated);
  expect(previewLampResult(lamp, preview, calculated)).toBe(calculated);
});
