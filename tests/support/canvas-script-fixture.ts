import { canvasSchema, canvasWidgetSchema, type CanvasWidget } from '../../src/domain/canvas';
import { widgetKey } from '../../src/domain/canvas-script';
import { emptyWorkspace, type Workspace } from '../../src/domain/model';
import { scriptBlocks as b, type MasterScript, type ScriptBlock } from '../../src/domain/master-script';

export function canvasScriptFixture(): Workspace {
  const control = (id: string, kind: CanvasWidget['kind'], label: string, binding: CanvasWidget['binding'], x: number, y: number, width = 180) =>
    canvasWidgetSchema.parse({ id, kind, label, text: label, x, y, width, height: 68, binding, showLabel: kind !== 'button', inputMode: 'text' });
  const canvas = canvasSchema.parse({ id: 'panel', name: '采样面板', width: 700, height: 360, widgets: [
    control('sample', 'button', '采样一次', { kind: 'script-event' }, 24, 24),
    control('enabled', 'switch', '采样使能', { kind: 'workspace-variable', variableId: 'enabled' }, 24, 112),
    control('note', 'input', '操作备注', { kind: 'workspace-variable', variableId: 'note' }, 24, 200, 300),
    control('total', 'value', '采样次数', { kind: 'workspace-variable', variableId: 'count' }, 250, 24),
    control('last', 'value', '流程末值', { kind: 'script-variable', scriptId: 'capture', name: 'last_count' }, 250, 112),
  ] });
  const reporter = (id: string, type: ScriptBlock['type'], fields?: ScriptBlock['fields']) => ({ block: { id, type, fields } });
  const eventLog = (id: string, message: string): ScriptBlock => ({ id, type: b.log, fields: { TEXT: message }, inputs: { OPERAND: reporter(id + '-value', b.eventValue) } });
  const hat = (widget: string, event: string, next: ScriptBlock): ScriptBlock => ({ id: 'on-' + event, type: b.onWidget,
    fields: { WIDGET: widgetKey(canvas.id, widget), EVENT: event }, next: { block: next } });
  const increment: ScriptBlock = { id: 'increment', type: b.setWorkspaceValue, fields: { TAG: 'count' },
    inputs: { OPERAND: { block: { id: 'plus', type: b.arithmetic, fields: { OP: 'add', B: 1 }, inputs: { A: reporter('before', b.workspaceValue, { TAG: 'count' }) } } } },
    next: { block: { id: 'remember', type: b.setVariable, fields: { VARIABLE: 'last_count' }, inputs: { OPERAND: reporter('after', b.workspaceValue, { TAG: 'count' }) },
      next: { block: eventLog('clicked', '点击') } } } };
  const script = (id: string, name: string, blocks: ScriptBlock[], publishedVariables: string[] = []): MasterScript =>
    ({ id, name, revision: 0, publishedVariables, graph: { blocks: { languageVersion: 0, blocks } } });
  return { ...emptyWorkspace('画布脚本联动'), canvases: [canvas], variables: [
    { id: 'count', name: 'sample_count', type: 'number', initial: 0 },
    { id: 'enabled', name: 'enabled', type: 'boolean', initial: false },
    { id: 'note', name: 'operator_note', type: 'string', initial: '' },
  ], masterScripts: [
    script('capture', '采样逻辑', [hat('sample', 'click', increment), hat('sample', 'press', eventLog('held','按下')),
      hat('sample', 'release', eventLog('released','松开')), hat('sample', 'cancel', eventLog('cancelled','取消')),
      hat('enabled', 'change', eventLog('switched','开关')), hat('note', 'submit', eventLog('submitted','备注'))], ['last_count']),
    script('observe', '变更记录', [{ id: 'changed', type: b.onWorkspaceChange, fields: { TAG: 'count' }, next: { block: eventLog('observed','计数') } }]),
  ] };
}

export function heldButtonFixture(): Workspace {
  const ws = canvasScriptFixture();
  ws.variables!.push({ id: 'held', name: 'held', type: 'boolean', initial: false });
  const canvas = ws.canvases![0]!;
  canvas.widgets.push({ ...canvas.widgets.find(w => w.id === 'total')!, id: 'held-value', label: '按住状态', x: 460,
    binding: { kind: 'workspace-variable', variableId: 'held' } });
  for (const hat of ws.masterScripts![0]!.graph.blocks!.blocks) {
    const event = hat.fields?.EVENT;
    if (event !== 'press' && event !== 'release' && event !== 'cancel') continue;
    hat.next = { block: { id: `set-${event}`, type: b.setWorkspaceValue, fields: { TAG:'held' },
      inputs: { OPERAND: { block: { id: `flag-${event}`, type: b.boolean, fields: { BOOL: event === 'press' ? 'TRUE' : 'FALSE' } } } }, next: hat.next } };
  }
  return ws;
}
