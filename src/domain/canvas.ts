import { z } from 'zod';
import { lampConfigSchema } from './canvas-lamp';
import { signalId } from './canvas-script';

const id = z.string().min(1).max(200);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const widgetKindSchema = z.enum(['text', 'value', 'lamp', 'button', 'switch', 'input', 'gauge', 'trend', 'container']);
export type WidgetKind = z.infer<typeof widgetKindSchema>;
export const gaugeStyleSchema = z.enum(['arc', 'dial', 'bar', 'vertical', 'tank']);
export const inputModeSchema = z.enum(['number', 'text', 'select', 'stepper', 'slider']);
export type GaugeStyle = z.infer<typeof gaugeStyleSchema>;
export type InputMode = z.infer<typeof inputModeSchema>;
const canvasPointBindingSchema = z.object({ slaveId: id, pointId: id });
const canvasStatusBindingSchema = z.object({ slaveId: id, kind: z.literal('slave-status') });
const canvasBindingSchema = z.union([canvasStatusBindingSchema, canvasPointBindingSchema,
  z.object({ kind: z.literal('script-event') }),
  z.object({ kind: z.literal('workspace-variable'), variableId: signalId }),
  z.object({ kind: z.literal('script-variable'), scriptId: signalId, name: z.string().min(1).max(120) }),
]);
export type CanvasBinding = z.infer<typeof canvasBindingSchema>;
export const canvasSignalSchema = canvasPointBindingSchema.extend({ color: color.optional() });
export type CanvasSignal = z.infer<typeof canvasSignalSchema>;
export const canvasWidgetSchema = z.object({
  id,
  kind: widgetKindSchema,
  x: z.number().finite().min(0).max(8192),
  y: z.number().finite().min(0).max(8192),
  width: z.number().finite().min(16).max(8192),
  height: z.number().finite().min(16).max(8192),
  parentId: id.nullable().default(null),
  label: z.string().max(200),
  text: z.string().max(2000).default('文本'),
  binding: canvasBindingSchema.nullable().default(null),
  signals: z.array(canvasSignalSchema).max(16).default([]),
  color: color.default('#0078D4'),
  background: color.default('#FFFFFF'),
  showLabel: z.boolean().default(false),
  showBackground: z.boolean().default(false),
  showBorder: z.boolean().default(false),
  showStateText: z.boolean().default(false),
  showConfirmed: z.boolean().default(true),
  fontSize: z.number().int().min(10).max(72).default(20),
  min: z.number().finite().default(0),
  max: z.number().finite().default(100),
  onValue: z.string().max(256).default('1'),
  offValue: z.string().max(256).default('0'),
  windowSec: z.number().int().min(5).max(3600).default(60),
  gaugeStyle: gaugeStyleSchema.default('arc'),
  inputMode: inputModeSchema.default('number'),
  step: z.number().finite().positive().default(1),
  limitInput: z.boolean().default(false),
  appearance: z.enum(['auto', 'solid', 'soft', 'outline', 'underline']).default('auto'),
  textSize: z.number().int().min(10).max(72).nullable().default(null),
  textColor: color.nullable().default(null),
  textWeight: z.enum(['normal', 'medium', 'bold']).nullable().default(null),
  textAlign: z.enum(['left', 'center', 'right']).nullable().default(null),
  borderColor: color.nullable().default(null),
  borderWidth: z.number().int().min(1).max(8).default(1),
  borderRadius: z.number().int().min(0).max(32).default(6),
  padding: z.number().int().min(0).max(32).default(0),
  lamp: lampConfigSchema.default({}),
}).superRefine((widget, ctx) => {
  if (widget.binding && 'kind' in widget.binding && widget.binding.kind === 'slave-status' && widget.kind !== 'lamp') {
    ctx.addIssue({ code: 'custom', path: ['binding'], message: '设备通信状态可绑定到指示灯' });
  }
  if (widget.binding && 'kind' in widget.binding && widget.binding.kind !== 'slave-status') {
    const kinds = widget.binding.kind === 'script-event' ? ['button', 'switch', 'input']
      : widget.binding.kind === 'script-variable' ? ['value', 'lamp', 'gauge'] : ['value', 'lamp', 'gauge', 'switch', 'input'];
    if (!kinds.includes(widget.kind)) ctx.addIssue({ code: 'custom', path: ['binding'], message: '此控件不支持所选脚本绑定' });
  }
});
export type CanvasWidget = z.infer<typeof canvasWidgetSchema>;

export function canvasPointBinding(binding: CanvasBinding | null): z.infer<typeof canvasPointBindingSchema> | null {
  return binding && 'pointId' in binding ? binding : null;
}

export function canvasSignals(widget: Pick<CanvasWidget, 'signals' | 'binding'>): CanvasSignal[] {
  const point = canvasPointBinding(widget.binding);
  return widget.signals.length ? widget.signals : point ? [point] : [];
}
export const canvasGridSchema = z.object({
  visible: z.boolean().default(true),
  snap: z.boolean().default(true),
  size: z.number().int().min(2).max(128).default(8),
});
export type CanvasGrid = z.infer<typeof canvasGridSchema>;
export const canvasSchema = z.object({
  id,
  name: z.string().trim().min(1).max(200),
  revision: z.number().int().min(0).default(0),
  width: z.number().int().min(320).max(8192).default(1280),
  height: z.number().int().min(240).max(8192).default(720),
  background: color.default('#F6F7F9'),
  grid: canvasGridSchema.default({}),
  widgets: z.array(canvasWidgetSchema).max(500).default([]),
}).superRefine((canvas, ctx) => {
  const byId = new Map(canvas.widgets.map(w => [w.id, w]));
  if (new Set(canvas.widgets.map(w => w.id)).size !== canvas.widgets.length) ctx.addIssue({ code: 'custom', message: '控件 ID 重复' });
  for (const w of canvas.widgets) {
    const parent = w.parentId ? byId.get(w.parentId) : null;
    if (w.parentId && parent?.kind !== 'container') ctx.addIssue({ code: 'custom', message: `控件“${w.label}”所属容器不存在` });
    const frame = parent ?? canvas;
    if (w.x + w.width > frame.width || w.y + w.height > frame.height) ctx.addIssue({ code: 'custom', message: `控件“${w.label}”超出${parent ? '容器' : '画布'}边界` });
    const ancestors = new Set([w.id]);
    let ancestor = parent;
    while (ancestor) {
      if (ancestors.has(ancestor.id)) { ctx.addIssue({ code: 'custom', message: '容器不能循环嵌套' }); break; }
      ancestors.add(ancestor.id);
      if (ancestors.size > 9) { ctx.addIssue({ code: 'custom', message: '容器最多嵌套 8 层' }); break; }
      ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : null;
    }
    const signalKeys = w.signals.map(s => `${s.slaveId}::${s.pointId}`);
    if (new Set(signalKeys).size !== signalKeys.length) ctx.addIssue({ code: 'custom', message: '曲线信号重复' });
    const numericInput = w.kind === 'input' && ['number', 'stepper', 'slider'].includes(w.inputMode);
    const needsRange = w.kind === 'gauge' || (numericInput && (w.inputMode === 'slider' || w.limitInput));
    if (needsRange && w.max <= w.min) ctx.addIssue({ code: 'custom', message: '控件上限必须大于下限' });
  }
});
export type CanvasDef = z.infer<typeof canvasSchema>;
export const canvasChangesSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  width: z.number().int().min(320).max(8192).optional(),
  height: z.number().int().min(240).max(8192).optional(),
  background: color.optional(),
  grid: canvasGridSchema.optional(),
  upsertWidgets: z.array(canvasWidgetSchema).max(500).default([]),
  removeWidgetIds: z.array(id).max(500).default([]),
  order: z.array(id).max(500).optional(),
});
export type CanvasChanges = z.infer<typeof canvasChangesSchema>;

/** Describes an atomic edit, not a replacement of the workspace or other canvases. */
export function diffCanvas(before: CanvasDef, after: CanvasDef): CanvasChanges {
  return {
    name: after.name, width: after.width, height: after.height, background: after.background, grid: after.grid,
    upsertWidgets: after.widgets.filter(w => JSON.stringify(w) !== JSON.stringify(before.widgets.find(old => old.id === w.id))),
    removeWidgetIds: before.widgets.filter(w => !after.widgets.some(next => next.id === w.id)).map(w => w.id),
    order: after.widgets.map(w => w.id),
  };
}

export function applyCanvasChanges(canvas: CanvasDef, expectedRevision: number, changes: CanvasChanges): CanvasDef {
  if (canvas.revision !== expectedRevision) throw new Error('画布已在其他页面修改。草稿已保留，请重新载入最新版本后再编辑。');
  let widgets = canvas.widgets.filter(w => !changes.removeWidgetIds.includes(w.id));
  if (new Set(changes.upsertWidgets.map(w => w.id)).size !== changes.upsertWidgets.length) throw new Error('控件 ID 重复');
  for (const widget of changes.upsertWidgets) {
    widgets = widgets.some(w => w.id === widget.id) ? widgets.map(w => w.id === widget.id ? widget : w) : [...widgets, widget];
  }
  if (changes.order) {
    const order = changes.order;
    if (order.length !== widgets.length || new Set(order).size !== widgets.length || order.some(key => !widgets.some(w => w.id === key))) throw new Error('控件层次无效');
    widgets = order.map(key => widgets.find(w => w.id === key)!);
  }
  return canvasSchema.parse({ ...canvas, ...Object.fromEntries(Object.entries(changes).filter(([k, v]) => ['name', 'width', 'height', 'background', 'grid'].includes(k) && v !== undefined)), widgets, revision: canvas.revision + 1 });
}
