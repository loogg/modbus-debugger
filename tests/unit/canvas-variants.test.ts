import { expect, it } from 'vitest';
import { canvasSchema, canvasWidgetSchema } from '../../src/domain/canvas';
import { bindingError, canvasInputOptions } from '../../src/domain/canvas-binding';
import { newWidget, copyWidgets, pasteWidgets, fitWidgets } from '../../src/renderer/features/canvas/editing';
import { parseWidgetPreset } from '../../src/renderer/features/canvas/presets';
import { validateCanvasInput } from '../../src/renderer/features/canvas/write-value';
import { templateWorkspace } from '../support/template-workspace';

const original = { id: 'control', kind: 'input', label: 'Input', x: 0, y: 0, width: 176, height: 56 };
it('keeps legacy gauges/inputs compatible and rejects invalid step/range definitions', () => {
  expect(canvasWidgetSchema.parse(original)).toMatchObject({ inputMode: 'number', gaugeStyle: 'arc', step: 1, limitInput: false });
  const canvas = { id: 'panel', name: 'Panel', widgets: [{ ...original, inputMode: 'slider', min: 10, max: 10 }] };
  expect(canvasSchema.safeParse(canvas).success).toBe(false);
  expect(canvasWidgetSchema.safeParse({ ...original, step: 0 }).success).toBe(false);
  expect(canvasWidgetSchema.safeParse({ ...original, appearance: 'unknown' }).success).toBe(false);
  expect(canvasWidgetSchema.safeParse({ ...original, borderRadius: -1 }).success).toBe(false);
  expect(canvasSchema.safeParse({ ...canvas, widgets: [{ ...original, min: 10, max: 10 }] }).success).toBe(true);
});

it('preserves selected types through adding, copying and fitting', () => {
  const canvas = canvasSchema.parse({ id: 'panel', name: 'Panel' });
  const preset = parseWidgetPreset('{"kind":"gauge","gaugeStyle":"bar"}')!;
  canvas.widgets = [newWidget(preset.kind, 'bar', canvas, 0, 0, null, preset)];
  expect(canvas.widgets[0]).toMatchObject({ gaugeStyle: 'bar', width: 208, height: 64 });
  const pasted = pasteWidgets(canvas, copyWidgets(canvas, ['bar']), () => 'copy').canvas;
  expect(fitWidgets(pasted, ['copy']).widgets[1]).toMatchObject({ gaugeStyle: 'bar', width: 208, height: 64 });
  expect(parseWidgetPreset('{"kind":"gauge","gaugeStyle":"unknown"}')).toBeNull();
});

it('enforces String, enum, Bool and numeric bindings for each input mode', () => {
  const points = templateWorkspace().templates[0]!.points;
  const numeric = points[0]!;
  const text = points.find(p => p.id === 'Late')!;
  const flag = points.find(p => p.id === 'Flag')!;
  expect(bindingError('input', text, 'text')).toBeNull();
  expect(bindingError('input', numeric, 'text')).toContain('String');
  expect(bindingError('input', numeric, 'select')).toContain('枚举');
  expect(bindingError('input', flag, 'select')).toBeNull();
  expect(canvasInputOptions(flag).map(item => item.value)).toEqual(['0', '1']);
  expect(bindingError('input', { ...numeric, enumMap: { '0': '停止', '1': '运行' } }, 'select')).toBeNull();
  expect(bindingError('input', text, 'stepper')).toContain('数值');
  expect(bindingError('input', { ...text, access: 'ro' }, 'text')).toContain('可写');
});

it('applies numeric bounds only when configured and always bounds slider writes', () => {
  const widget = canvasWidgetSchema.parse(original);
  expect(() => validateCanvasInput(widget, '1729')).not.toThrow();
  expect(() => validateCanvasInput({ ...widget, inputMode: 'stepper', limitInput: true }, '101')).toThrow('范围');
  expect(() => validateCanvasInput({ ...widget, inputMode: 'slider' }, '-1')).toThrow('范围');
  expect(() => validateCanvasInput({ ...widget, inputMode: 'text' }, '')).not.toThrow();
});
