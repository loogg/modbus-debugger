import { canvasPointBinding, canvasSignals, type CanvasWidget, type InputMode } from './canvas';
import { widgetEvents, type EventBinding, type WorkspaceVariable } from './canvas-script';
import type { PointDef, Workspace } from './model';
import { canReadPoint, canWritePoint } from './point-access';

export function canvasPoint(workspace: Workspace, widget: CanvasWidget) {
  const binding = widget.binding;
  const slave = binding && 'slaveId' in binding ? workspace.slaves.find(s => s.id === binding.slaveId) : undefined;
  const template = workspace.templates.find(t => t.id === slave?.templateId);
  const pointId = canvasPointBinding(widget.binding)?.pointId;
  const point = template?.points.find(p => p.id === pointId);
  const connection = workspace.connections.find(c => c.id === slave?.connectionId);
  return { slave, point, connection };
}

export function canvasInputOptions(point: PointDef) {
  if (point.mapping.rawType === 'Bool') return [{ value: '0', label: point.enumMap['0'] ?? 'OFF' }, { value: '1', label: point.enumMap['1'] ?? 'ON' }];
  return Object.entries(point.enumMap).filter(([key]) => key.trim() !== '' && Number.isFinite(Number(key))).map(([value, label]) => ({ value, label }));
}

export function bindingError(kind: CanvasWidget['kind'], point: PointDef, inputMode: InputMode = 'number'): string | null {
  if (['button', 'switch', 'input'].includes(kind) && !canWritePoint(point)) return '此控件需要可写点位';
  if (!['button', 'switch', 'input', 'text', 'container'].includes(kind) && !canReadPoint(point)) return '此控件需要可读点位，只写点位用于命令控件';
  if (kind === 'switch' && point.mapping.rawType !== 'Bool') return '开关需要 Bool 点位';
  if (kind === 'input' && inputMode === 'text') return point.mapping.rawType === 'String' ? null : '文本输入需要 String 点位';
  if (kind === 'input' && inputMode === 'select') {
    if (point.mapping.rawType === 'String') return '下拉选择需要枚举数值或 Bool 点位';
    return canvasInputOptions(point).length ? null : '请先为点位配置枚举映射';
  }
  if (['input', 'gauge', 'trend'].includes(kind) && ['Bool', 'String'].includes(point.mapping.rawType)) return '此控件需要数值点位';
  if (kind === 'lamp' && point.mapping.rawType === 'String') return '指示灯需要 Bool 或数值点位';
  return null;
}

export function variableAcceptsWidget(widget: Pick<CanvasWidget, 'kind' | 'inputMode'>, type: WorkspaceVariable['type']) {
  if (widget.kind === 'switch') return type === 'boolean';
  if (widget.kind === 'input') return type === (widget.inputMode === 'text' ? 'string' : widget.inputMode === 'select' ? 'boolean' : 'number');
  if (widget.kind === 'gauge') return type === 'number';
  if (widget.kind === 'lamp') return type !== 'string';
  return widget.kind === 'value';
}

export function checkInputBinding(workspace: Workspace, binding: EventBinding) {
  if (binding.kind === 'workspace') {
    if (!workspace.variables?.some(v => v.id === binding.variableId)) throw new Error('绑定的工作区变量不存在');
    return;
  }
  const widget = workspace.canvases?.find(c => c.id === binding.canvasId)?.widgets.find(w => w.id === binding.widgetId);
  if (!widget) throw new Error('绑定的画布控件不存在');
  if (!widget.binding || !('kind' in widget.binding) || !['script-event', 'workspace-variable'].includes(widget.binding.kind)
    || !widgetEvents[widget.kind]?.includes(binding.event)) throw new Error('控件没有启用此脚本事件');
  if (widget.binding.kind === 'workspace-variable') {
    const tagId = widget.binding.variableId;
    const tag = workspace.variables?.find(v => v.id === tagId);
    if (!tag || !variableAcceptsWidget(widget, tag.type)) throw new Error('控件绑定的工作区变量无效');
  }
}

export function validateCanvasBindings(workspace: Workspace, widgets: CanvasWidget[]): void {
  for (const widget of widgets) {
    const bindings = widget.kind === 'trend' ? canvasSignals(widget) : widget.binding ? [widget.binding] : [];
    if (['text', 'container'].includes(widget.kind) && bindings.length) throw new Error('文字标签和容器不绑定设备点位');
    for (const binding of bindings) {
      if ('kind' in binding && binding.kind === 'script-event') continue;
      if ('kind' in binding && binding.kind === 'workspace-variable') {
        const variable = workspace.variables?.find(v => v.id === binding.variableId);
        if (!variable || !variableAcceptsWidget(widget, variable.type)) throw new Error('工作区变量不存在或与控件类型不匹配');
        continue;
      }
      if ('kind' in binding && binding.kind === 'script-variable') {
        if (!workspace.masterScripts?.find(s => s.id === binding.scriptId)?.publishedVariables?.includes(binding.name)) throw new Error('请选择已公开的脚本变量');
        continue;
      }
      const { point, slave, connection } = canvasPoint(workspace, { ...widget, binding });
      if ('kind' in binding) {
        if (widget.kind !== 'lamp') throw new Error('设备通信状态可绑定到指示灯');
        if (!slave || !connection) throw new Error(`控件“${widget.label}”绑定的设备不存在`);
        continue;
      }
      if (!point) throw new Error(`控件“${widget.label}”绑定的设备或点位不存在`);
      const error = bindingError(widget.kind, point, widget.inputMode);
      if (error) throw new Error(`${widget.label}：${error}`);
    }
  }
}
