import * as Blockly from 'blockly/core';
import * as zhHans from 'blockly/msg/zh-hans';
import { blockColours } from './block-palette';
import { checkCallbackContexts, checkWorkspaceAssignments, DEFAULT_DELAY_MS, DEFAULT_REPEAT_COUNT, DEFAULT_RUN_PERIOD, DEFAULT_WAIT_MS, MAX_EVENT_ITERATIONS, MIN_EVENT_PERIOD, SCRIPT_TIMER_COUNT } from '../../../domain/master-script';
import type { LuaSource } from '../../../domain/script-lua-source';
import { checkScriptPoints, resolveScriptPoint, type ScriptPointTarget } from '../../../domain/script-point-access';
import { compileScriptLua } from '../../../domain/script-lua-program';
import { luaNumericLiteral } from '../../../domain/script-lua-operators';
import { fieldText, isScriptDefinition, MAX_SCRIPT_MS, ScriptBlockError, scriptArithmetic, scriptBlocks, scriptErrors, scriptGraphBlocks, scriptPointKey, scriptRelations, scriptStates, splitParameters, type ScriptGraph } from '../../../domain/master-script';
import type { Workspace } from '../../../domain/model';
import { slaveEventStates, widgetEventLabels, widgetEvents, widgetKey, type WidgetEvent, type WorkspaceVariable } from '../../../domain/canvas-script';
import { canReadPoint, canWritePoint } from '../../../domain/point-access';
import { BooleanSwitch, conditionInput, initBranch, literalShadow, LogValueControl, numberSlot, saveScriptGraph } from './block-controls';
import type { ScriptPreview } from './lua-source';
import { initFunctionCall, parameterField, ParameterListField, ScriptReferenceField } from './function-blocks';


type Option = [string, string];
type List = 'slave' | 'read' | 'write' | 'numeric' | 'widget' | 'tag';
interface FieldOptions {
  points: Map<string, ScriptPointTarget>;
  lists: Record<List, Option[]>;
  available: Record<List, Set<string>>;
  savedPoints: Set<string>;
  savedSlaves: Set<string>;
  savedWidgets: Set<string>;
  savedTags: Set<string>;
  widgetKinds: Map<string, string>;
  tagTypes: Map<string, WorkspaceVariable['type']>;
  shortNames: Map<string, string>;
}

export const bindings = new WeakMap<Blockly.Workspace, FieldOptions>();

export function makeFieldOptions(workspace: Workspace | null, graph: ScriptGraph): FieldOptions {
  const points = new Map<string, ScriptPointTarget>();
  const lists: Record<List, Option[]> = {
    widget: [['选择画布控件', '']], tag: [['选择工作区变量', '']],
    slave: [['选择从站', '']], read: [['选择点位', '']], write: [['选择点位', '']], numeric: [['数值点位', '']],
  };
  const shortNames = new Map<string, string>();
  const fullNames = new Map<string, string>();
  const identifiers = new Map<string, string>();
  for (const slave of workspace?.slaves ?? []) {
    const connection = workspace?.connections.find(item => item.id === slave.connectionId);
    if (!connection || connection.role === 'slave') continue;
    const source = `${connection.name} / ${slave.name} (Unit ${slave.unitId})`;
    const suffix = slave.enabled ? '' : ' · 停用';
    lists.slave.push([source + suffix, slave.id]);
    shortNames.set(slave.id, slave.name + suffix);
    identifiers.set(slave.id, slave.id);
    fullNames.set(slave.id, `${slave.name} · ${connection.name} U${slave.unitId}${suffix}`);
    const template = workspace?.templates.find(item => item.id === slave.templateId);
    for (const point of template?.points ?? []) {
      const option: Option = [`${source} / ${point.name}${suffix}`, scriptPointKey({ slaveId: slave.id, pointId: point.id })];
      points.set(option[1], { connection, slave, point });
      shortNames.set(option[1], `${point.name} · ${slave.name}${suffix}`);
      identifiers.set(option[1], point.id);
      fullNames.set(option[1], `${point.name} · ${connection.name} / ${slave.name} U${slave.unitId}${suffix}`);
      if (canWritePoint(point)) lists.write.push(option);
      if (canReadPoint(point)) {
        lists.read.push(option);
        if (point.mapping.rawType !== 'Bool' && point.mapping.rawType !== 'String') lists.numeric.push(option);
      }
    }
  }
  const savedPoints = new Set<string>();
  const savedWidgets = new Set<string>(), savedTags = new Set<string>(), widgetKinds = new Map<string, string>();
  for (const canvas of workspace?.canvases ?? []) for (const widget of canvas.widgets) {
    if (!widgetEvents[widget.kind] || !widget.binding || !('kind' in widget.binding) || !['script-event', 'workspace-variable'].includes(widget.binding.kind)) continue;
    const key = widgetKey(canvas.id, widget.id);
    lists.widget.push([`${canvas.name} / ${widget.label || widget.text}`, key]);
    widgetKinds.set(key, widget.kind);
  }
  for (const variable of workspace?.variables ?? []) lists.tag.push([variable.name, variable.id]);
  if (!widgetKinds.size) lists.widget[0] = ['先在画布启用控件事件', ''];
  if (!workspace?.variables?.length) lists.tag[0] = ['先新建工作区变量', ''];
  const savedSlaves = new Set<string>();
  const counts = new Map<string, number>();
  for (const name of shortNames.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
  for (const [key, name] of shortNames) if (counts.get(name)! > 1) shortNames.set(key, fullNames.get(key)!);
  counts.clear();
  for (const name of shortNames.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
  const ambiguous = new Set<string>();
  for (const [key, name] of shortNames) if (counts.get(name)! > 1) {
    ambiguous.add(key);
    shortNames.set(key, name + ' · ' + identifiers.get(key));
  }
  for (const option of new Set(Object.values(lists).flat())) if (ambiguous.has(option[1])) option[0] += ' · ' + identifiers.get(option[1]);
  for (const block of scriptGraphBlocks(graph)) {
    if (fieldText(block, 'WIDGET')) savedWidgets.add(fieldText(block, 'WIDGET'));
    if (fieldText(block, 'TAG')) savedTags.add(fieldText(block, 'TAG'));
    const point = fieldText(block, 'POINT');
    const slave = fieldText(block, 'SLAVE');
    if (point) savedPoints.add(point);
    if (slave) savedSlaves.add(slave);
  }
  const keys = (list: List) => new Set(lists[list].map(([, key]) => key));
  return { lists, points, savedPoints, savedSlaves, savedWidgets, savedTags, widgetKinds, shortNames, tagTypes: new Map(workspace?.variables?.map(v => [v.id,v.type])),
    available: { slave: keys('slave'), read: keys('read'), write: keys('write'), numeric: keys('numeric'), widget: keys('widget'), tag: keys('tag') } };
}

function owner(block: Blockly.Block) {
  const own = block.workspace;
  return own instanceof Blockly.WorkspaceSvg ? own.targetWorkspace ?? own : own;
}
class PointDropdown extends Blockly.FieldDropdown {
  access?: List;
  protected override getText_(): string | null {
    const block = this.getSourceBlock();
    const key = this.getValue();
    const options = block && bindings.get(owner(block));
    if (options && key && this.access && !options.available[this.access].has(key)) return '绑定失效 · ' + key;
    if (key && options && (this.access === 'widget' || this.access === 'tag')) {
      return options.lists[this.access].find(([, id]) => id === key)?.[0] ?? '绑定失效';
    }
    return (key && options?.shortNames.get(key)) || super.getText_();
  }
}
function bindingField(block: Blockly.Block, list: List): Blockly.FieldDropdown {
  const menu = new PointDropdown(function(this: Blockly.FieldDropdown) {
    const options = bindings.get(owner(block));
    if (!options) return [[list === 'slave' ? '选择从站' : '选择点位', '']];
    const selected = this.getValue();
    const saved = new Set(list === 'slave' ? options.savedSlaves : list === 'widget' ? options.savedWidgets : list === 'tag' ? options.savedTags : options.savedPoints);
    if (selected) saved.add(selected);
    const available = options.lists[list];
    const keys = options.available[list];
    const missing: Option[] = [...saved].filter(key => !keys.has(key)).map(key => [`绑定失效 · ${key}`, key]);
    return [...available, ...missing];
  });
  menu.access = list;
  menu.setTooltip(() => menu.getOptions(false).find(([, value]) => value === menu.getValue())?.[0]?.toString() ?? '');
  return menu;
}

function variableField(block: Blockly.Block): Blockly.FieldDropdown {
  return new ScriptReferenceField(function(this: Blockly.FieldDropdown) {
    const workspace = owner(block);
    const root = block.getRootBlock();
    const local = isScriptDefinition(root.type);
    const names = new Set(local ? splitParameters(String(root.getFieldValue('PARAMS') ?? '')) : []);
    const declarations = [...workspace.getBlocksByType(scriptBlocks.readVariable, false), ...workspace.getBlocksByType(scriptBlocks.setVariable, false)];
    for (const item of declarations) {
      const declaringRoot = item.getRootBlock();
      if (local ? declaringRoot !== root : isScriptDefinition(declaringRoot.type)) continue;
      const name = String(item.getFieldValue('VARIABLE') ?? '').trim();
      if (name) names.add(name);
    }
    const current = this.getValue();
    if (current) names.add(current);
    return [['选择变量', ''], ...[...names].sort().map((name): Option => [name, name])] as Option[];
  });
}

const { device: actionColor, control: controlColor, condition: conditionColor, variable: variableColor,
  math: mathColor, log: logColor, function: functionColor } = blockColours;
function valueReporter(block: Blockly.Block, colour: string, dynamic = false) {
  block.setOutput(true, dynamic ? ['ScriptValue', 'ScriptNumber', 'ConditionValue'] : ['ScriptValue', 'ScriptNumber']);
  block.setColour(colour);
  if (block.workspace instanceof Blockly.WorkspaceSvg) block.setOutputShape(block.workspace.getRenderer().getConstants().SHAPES.ROUND ?? null);
}
function action(block: Blockly.Block, label: string, color = actionColor) {
  block.setPreviousStatement(true);
  block.setNextStatement(true);
  block.setColour(color);
  return block.appendDummyInput().appendField(label);
}
function timeout(block: Blockly.Block) {
  block.appendDummyInput().appendField('超时').appendField(new Blockly.FieldNumber(DEFAULT_WAIT_MS, 50, MAX_SCRIPT_MS, 1), 'TIMEOUT').appendField('ms');
}
function statementCondition(block: Blockly.Block, label: string) {
  block.setPreviousStatement(true);
  block.setNextStatement(true);
  block.setColour(controlColor);
  block.setInputsInline(true);
  conditionInput(block, 'CONDITION', label);
}
function predicate(block: Blockly.Block) {
  block.setOutput(true, 'Boolean');
  block.setColour(conditionColor);
  block.setInputsInline(true);
}

function installBlocks() {
  const messages = Object.fromEntries(Object.entries(zhHans).flatMap(([key, value]) => typeof value === 'string' ? [[key, value]] : []));
  Blockly.setLocale({ ...messages, DISABLE_BLOCK: '停用此段', ENABLE_BLOCK: '启用此段' });
  Blockly.Blocks[literalShadow] = { init(this: Blockly.Block) {
    this.setOutput(true, 'ScriptValue'); this.setColour(mathColor);
    this.appendDummyInput().appendField(new Blockly.FieldTextInput('0'), 'TEXT');
  } };
  Blockly.Blocks[scriptBlocks.start] = { init(this: Blockly.Block) {
    this.hat = 'cap';
    this.appendDummyInput().appendField('开始').appendField('on_start');
    this.setNextStatement(true);
    this.setColour(blockColours.entry);
  } };
  const channelField = () => new Blockly.FieldDropdown(Array.from({ length: SCRIPT_TIMER_COUNT }, (_, id): Option => [`T${id}`, String(id)]));
  Blockly.Blocks[scriptBlocks.onWidget] = { init(this: Blockly.Block) {
    this.hat = 'cap'; this.setNextStatement(true); this.setColour(blockColours.entry);
    const widget = bindingField(this, 'widget');
    const choices = (key: string) => widgetEvents[bindings.get(owner(this))?.widgetKinds.get(key) ?? ''] ?? Object.keys(widgetEventLabels) as WidgetEvent[];
    const event: Blockly.FieldDropdown = new ScriptReferenceField(() => choices(String(widget.getValue())).map(e => [widgetEventLabels[e], e]));
    this.appendDummyInput().appendField('当').appendField(widget, 'WIDGET').appendField(event, 'EVENT').appendField('时');
    widget.setValidator(key => {
      const allowed = choices(String(key));
      if (!allowed.some(e => e === event.getValue())) event.setValue(allowed[0]!);
      return key;
    });
  } };
  Blockly.Blocks[scriptBlocks.onPointChange] = { init(this: Blockly.Block) {
    this.hat = 'cap'; this.setNextStatement(true); this.setColour(blockColours.entry);
    this.appendDummyInput().appendField('当点位').appendField(bindingField(this, 'read'), 'POINT').appendField('确认值改变时');
    this.setTooltip('首笔有效采样建立基线。后续值改变时，可读取上次和本次事件值。');
  } };
  Blockly.Blocks[scriptBlocks.onSlaveState] = { init(this: Blockly.Block) {
    this.hat = 'cap'; this.setNextStatement(true); this.setColour(blockColours.entry);
    this.appendDummyInput().appendField('当从站').appendField(bindingField(this, 'slave'), 'SLAVE')
      .appendField(new Blockly.FieldDropdown(slaveEventStates.map(([label, key]) => [label, key])), 'STATE').appendField('时');
    this.setTooltip('按这个从站的实际通信状态触发。启动时已有的状态只作为基线。');
  } };
  Blockly.Blocks[scriptBlocks.onWorkspaceChange] = { init(this: Blockly.Block) {
    this.hat = 'cap'; this.setNextStatement(true); this.setColour(blockColours.entry);
    this.appendDummyInput().appendField('当工作区变量').appendField(bindingField(this, 'tag'), 'TAG').appendField('改变时');
  } };
  Blockly.Blocks[scriptBlocks.workspaceValue] = { init(this: Blockly.Block) {
    valueReporter(this, variableColor, true);
    this.appendDummyInput().appendField('工作区变量').appendField(bindingField(this, 'tag'), 'TAG');
  } };
  Blockly.Blocks[scriptBlocks.eventValue] = { init(this: Blockly.Block) {
    valueReporter(this, blockColours.entry, true);
    this.appendDummyInput().appendField('本次事件值');
  } };
  Blockly.Blocks[scriptBlocks.previousEventValue] = { init(this: Blockly.Block) {
    valueReporter(this, blockColours.entry, true);
    this.appendDummyInput().appendField('上次事件值');
  } };
  Blockly.Blocks[scriptBlocks.setWorkspaceValue] = { init(this: Blockly.Block) {
    action(this, '把工作区变量', variableColor).appendField(bindingField(this, 'tag'), 'TAG');
    numberSlot(this, 'OPERAND', false).appendField('设为');
    this.setInputsInline(true);
  } };
  Blockly.Blocks[scriptBlocks.text] = { init(this: Blockly.Block) {
    this.setOutput(true, 'ScriptValue'); this.setColour(variableColor);
    this.appendDummyInput().appendField('文本').appendField(new Blockly.FieldTextInput(''), 'TEXT');
  } };
  Blockly.Blocks[scriptBlocks.onRun] = { init(this: Blockly.Block) {
    this.hat = 'cap';
    this.setNextStatement(true); this.setColour(blockColours.entry);
    this.appendDummyInput().appendField('on_run').appendField('每')
      .appendField(new Blockly.FieldNumber(DEFAULT_RUN_PERIOD, MIN_EVENT_PERIOD, MAX_SCRIPT_MS, 1), 'PERIOD').appendField('ms');
    this.appendDummyInput('EMPTY_HINT').appendField(new Blockly.FieldLabel('接入步骤后启用', 'script-event-hint'));
    this.setInputsInline(false);
    this.setTooltip('Main 按周期调用。接入启用的步骤后生效。');
  } };
  Blockly.Blocks[scriptBlocks.onTimer] = { init(this: Blockly.Block) {
    this.hat = 'cap';
    this.setNextStatement(true); this.setColour(blockColours.timer);
    this.appendDummyInput().appendField('on_timer').appendField(channelField(), 'TIMER').appendField('到期');
    this.setTooltip('在此通道启动并到期时执行一次回调。');
  } };
  Blockly.Blocks[scriptBlocks.runPeriod] = { init(this: Blockly.Block) {
    action(this, '设置 on_run 周期', blockColours.entry);
    numberSlot(this, 'PERIOD', true); this.appendDummyInput().appendField('ms'); this.setInputsInline(true);
  } };
  Blockly.Blocks[scriptBlocks.runControl] = { init(this: Blockly.Block) {
    action(this, 'on_run', blockColours.entry).appendField(new Blockly.FieldDropdown([['启用', 'start'], ['暂停', 'stop']]), 'MODE');
  } };
  Blockly.Blocks[scriptBlocks.timerStart] = { init(this: Blockly.Block) {
    action(this, '启动', blockColours.timer).appendField(channelField(), 'TIMER');
    numberSlot(this, 'PERIOD', true).appendField('周期');
    const count = new Blockly.FieldNumber(3, 1, Number.MAX_SAFE_INTEGER, 1);
    const mode = new Blockly.FieldDropdown([['一次', 'once'], ['指定次数', 'count'], ['循环', 'loop']], value => {
      count.setVisible(value === 'count'); return value;
    });
    this.appendDummyInput().appendField('ms').appendField(mode, 'MODE').appendField(count, 'COUNT');
    count.setVisible(false);
    this.setInputsInline(true);
    this.setTooltip('启动通道。再次启动同一通道会用新的周期和次数重新计时。');
  } };
  Blockly.Blocks[scriptBlocks.timerStop] = { init(this: Blockly.Block) {
    action(this, '停止', blockColours.timer).appendField(channelField(), 'TIMER');
  } };
  Blockly.Blocks[scriptBlocks.timerElapsed] = { init(this: Blockly.Block) {
    valueReporter(this, blockColours.timer);
    this.appendDummyInput().appendField(channelField(), 'TIMER').appendField('本周期已过 ms');
  } };
  Blockly.Blocks[scriptBlocks.timerRunning] = { init(this: Blockly.Block) {
    this.setOutput(true, ['Boolean', 'ScriptValue']); this.setColour(blockColours.timer);
    this.appendDummyInput().appendField(channelField(), 'TIMER').appendField('正在运行');
  } };
  Blockly.Blocks[scriptBlocks.read] = { init(this: Blockly.Block) {
    action(this, '等待新采样').appendField(bindingField(this, 'read'), 'POINT');
    timeout(this);
    this.setTooltip('等待下一次确认采样，并记录该值。');
  } };
  Blockly.Blocks[scriptBlocks.readVariable] = { init(this: Blockly.Block) {
    action(this, '读取到变量').appendField(new Blockly.FieldTextInput('initial_value'), 'VARIABLE');
    this.appendDummyInput().appendField('点位').appendField(bindingField(this, 'read'), 'POINT');
    this.setTooltip('立即将点位最新的有效确认值保存到本次运行的同名变量。');
  } };
  Blockly.Blocks[scriptBlocks.write] = { init(this: Blockly.Block) {
    action(this, '写入点位').appendField(bindingField(this, 'write'), 'POINT');
    this.setInputsInline(false);
    this.appendValueInput('OPERAND').setCheck(['ScriptValue', 'Boolean']).appendField('写为').connection!
      .setShadowState({ type: literalShadow, fields: { TEXT: '0' } });
    this.setTooltip('发送到所选点位并等待写应答。Bool 用 0/1，枚举用原始数值。');
  } };
  Blockly.Blocks[scriptBlocks.wait] = { init(this: Blockly.Block) {
    statementCondition(this, '等待条件');
    timeout(this);
  } };
  Blockly.Blocks[scriptBlocks.log] = { init(this: Blockly.Block) {
    const toggle = new LogValueControl();
    action(this, '记录日志', logColor).appendField(new Blockly.FieldTextInput('调试信息'), 'TEXT').appendField(toggle, 'WITH_VALUE');
    // Keep short values on the message row. A point path or compound expression gets its own row.
    this.getInputsInline = () => {
      const value = this.getInputTargetBlock('OPERAND');
      return !value || value.type === scriptBlocks.variable || value.type === scriptBlocks.number || value.type === scriptBlocks.boolean;
    };
    this.setOnChange(event => {
      if (event.type !== Blockly.Events.BLOCK_MOVE) return;
      const move = event as Blockly.Events.BlockMove;
      if (move.oldParentId === this.id || move.newParentId === this.id) toggle.forceRerender();
    });
    this.setTooltip('将文字和可选的值写入本次运行结果。点位取当前确认值。');
  } };
  Blockly.Blocks[scriptBlocks.assert] = { init(this: Blockly.Block) {
    statementCondition(this, '断言');
    this.setTooltip('立即检查当前条件。不成立或缺少有效数据时显示失败原因。');
  } };
  Blockly.Blocks[scriptBlocks.branch] = { init(this: Blockly.Block) {
    statementCondition(this, '如果');
    this.setTooltip('按当前条件选择分支，缺少判断所需的数据时显示失败原因。');
    initBranch(this);
  } };
  Blockly.Blocks[scriptBlocks.delay] = { init(this: Blockly.Block) {
    action(this, '延时', controlColor).appendField(new Blockly.FieldNumber(DEFAULT_DELAY_MS, 0, MAX_SCRIPT_MS, 1), 'MS').appendField('ms');
    this.setTooltip('挂起 on_start 协程，其他事件继续运行。在周期或定时器回调中调用会使这张流程报错停止。');
  } };
  Blockly.Blocks[scriptBlocks.repeat] = { init(this: Blockly.Block) {
    action(this, '重复', controlColor).appendField(new Blockly.FieldNumber(DEFAULT_REPEAT_COUNT, 1, MAX_EVENT_ITERATIONS, 1), 'COUNT').appendField('次');
    this.appendStatementInput('BODY');
  } };
  Blockly.Blocks[scriptBlocks.forever] = { init(this: Blockly.Block) {
    action(this, '主循环', controlColor);
    this.appendStatementInput('BODY');
    this.setTooltip('重复执行直到停止或跳出。轮次间让出调度，间隔用延时或等待新采样设定。');
  } };
  Blockly.Blocks[scriptBlocks.repeatUntil] = { init(this: Blockly.Block) {
    statementCondition(this, '重复直到');
    this.appendStatementInput('BODY');
    this.setTooltip('每轮开始时判断，条件为真就离开循环。');
  } };
  for (const [type, label] of [[scriptBlocks.stop, '停止流程'], [scriptBlocks.breakLoop, '跳出循环']] as const) {
    Blockly.Blocks[type] = { init(this: Blockly.Block) { action(this, label, controlColor); this.setNextStatement(false); } };
  }
  Blockly.Blocks[scriptBlocks.attempt] = { init(this: Blockly.Block) {
    action(this, '尝试执行', controlColor);
    this.appendStatementInput('BODY').appendField('执行');
    this.appendStatementInput('ERROR').appendField('出错时');
    this.setTooltip('失败时跳到处理区，处理完成后继续容器下方。空处理区将错误交给外层。');
  } };
  Blockly.Blocks[scriptBlocks.error] = { init(this: Blockly.Block) {
    predicate(this);
    this.appendDummyInput().appendField('本次错误是').appendField(new Blockly.FieldDropdown(scriptErrors.map(([name, code]) => [name, code])), 'CODE');
  } };
  Blockly.Blocks[scriptBlocks.variable] = { init(this: Blockly.Block) {
    valueReporter(this, variableColor, true);
    this.appendDummyInput().appendField(variableField(this), 'VARIABLE');
    this.setTooltip('取本次运行中已赋值的变量。');
  } };
  Blockly.Blocks[scriptBlocks.setVariable] = { init(this: Blockly.Block) {
    action(this, '把', variableColor).appendField(new Blockly.FieldTextInput('count'), 'VARIABLE');
    numberSlot(this, 'OPERAND', false).appendField('设为');
    this.setInputsInline(true);
    this.setTooltip('创建或更新本次运行的变量，可接入数值、确认值或表达式。');
  } };
  Blockly.Blocks[scriptBlocks.changeVariable] = { init(this: Blockly.Block) {
    action(this, '给', variableColor).appendField(variableField(this), 'VARIABLE');
    numberSlot(this, 'OPERAND', true).appendField('加');
    this.setInputsInline(true);
    this.setTooltip('给已赋值的数值变量加上指定数值，可使用负数。');
  } };
  Blockly.Blocks[scriptBlocks.number] = { init(this: Blockly.Block) {
    valueReporter(this, mathColor);
    this.appendDummyInput().appendField(new Blockly.FieldTextInput('0', raw => {
      const text = raw.trim();
      if (!text || !Number.isFinite(Number(text))) return null;
      return String(luaNumericLiteral(text));
    }), 'NUM');
  } };
  Blockly.Blocks[scriptBlocks.arithmetic] = { init(this: Blockly.Block) {
    valueReporter(this, mathColor);
    numberSlot(this, 'A', true);
    numberSlot(this, 'B', true).appendField(new Blockly.FieldDropdown(scriptArithmetic.map(([symbol, key]) => [symbol, key])), 'OP');
    this.setInputsInline(true);
    this.setTooltip('对两个数值执行加、减、乘或除，可嵌套其他运算。');
  } };
  for (const type of [scriptBlocks.procedure, scriptBlocks.calculation]) {
    Blockly.Blocks[type] = { init(this: Blockly.Block) {
      const calculation = type === scriptBlocks.calculation;
      this.hat = 'cap'; this.setColour(functionColor);
      this.appendDummyInput().appendField(calculation ? '定义计算函数' : '定义流程函数')
        .appendField(new Blockly.FieldTextInput(calculation ? 'compute_value' : 'run_step'), 'NAME')
        .appendField('参数').appendField(new ParameterListField(), 'PARAMS');
      if (calculation) numberSlot(this, 'RESULT', false).appendField('返回');
      else this.appendStatementInput('BODY').appendField('执行');
      this.setInputsInline(false);
      this.setTooltip('函数名和参数建议使用英文标识符。参数用逗号分隔，调用时按顺序传值。');
    } };
  }
  Blockly.Blocks[scriptBlocks.call] = { init(this: Blockly.Block) {
    initFunctionCall(this, action(this, '调用流程', functionColor));
    this.setTooltip('执行所选函数内的步骤，结束后回到调用处继续。');
  } };
  Blockly.Blocks[scriptBlocks.callValue] = { init(this: Blockly.Block) {
    valueReporter(this, functionColor, true);
    initFunctionCall(this, this.appendDummyInput().appendField('计算'));
    this.setTooltip('按本次传入的参数求值，返回值可接入条件或值槽。');
  } };
  Blockly.Blocks[scriptBlocks.parameter] = { init(this: Blockly.Block) {
    valueReporter(this, functionColor, true);
    this.appendDummyInput().appendField('参数').appendField<string>(parameterField(this), 'PARAM');
    this.setTooltip('接入函数定义内，选择该函数声明的参数。');
  } };
  Blockly.Blocks[scriptBlocks.pointValue] = { init(this: Blockly.Block) {
    valueReporter(this, actionColor, true);
    this.appendDummyInput().appendField('点位值').appendField(bindingField(this, 'read'), 'POINT');
  } };
  Blockly.Blocks[scriptBlocks.boolean] = { init(this: Blockly.Block) {
    this.setOutput(true, ['Boolean', 'ScriptValue']); this.setColour(conditionColor);
    if (this.workspace instanceof Blockly.WorkspaceSvg) this.setOutputShape(this.workspace.getRenderer().getConstants().SHAPES.ROUND ?? null);
    this.appendDummyInput().appendField(new BooleanSwitch('TRUE'), 'BOOL');
  } };
  Blockly.Blocks[scriptBlocks.state] = { init(this: Blockly.Block) {
    predicate(this);
    this.appendDummyInput().appendField('从站').appendField(bindingField(this, 'slave'), 'SLAVE');
    this.appendDummyInput().appendField('状态为')
      .appendField(new Blockly.FieldDropdown(scriptStates.map(([label, value]) => [label, value])), 'STATE');
  } };
  Blockly.Blocks[scriptBlocks.compare] = { init(this: Blockly.Block) {
    predicate(this);
    this.appendDummyInput().appendField('确认值').appendField(bindingField(this, 'read'), 'POINT');
    this.appendValueInput('OPERAND').setCheck(['ScriptValue', 'Boolean']).appendField(new Blockly.FieldDropdown(scriptRelations.map(([label, value]) => [label, value])), 'OP')
      .connection!.setShadowState({ type: literalShadow, fields: { TEXT: '0' } });
  } };
  Blockly.Blocks[scriptBlocks.compareValues] = { init(this: Blockly.Block) {
    predicate(this);
    numberSlot(this, 'A', false);
    numberSlot(this, 'B', false).appendField(new Blockly.FieldDropdown(scriptRelations.map(([label, key]) => [label, key])), 'OP');
    this.setTooltip('比较运行变量、点位值或表达式。大小比较适用于数值。');
  } };
  Blockly.Blocks[scriptBlocks.compareVariable] = { init(this: Blockly.Block) {
    predicate(this);
    this.appendDummyInput().appendField('与变量比较').appendField(bindingField(this, 'read'), 'POINT');
    this.appendDummyInput().appendField(new Blockly.FieldDropdown(scriptRelations.map(([label, value]) => [label, value])), 'OP')
      .appendField('变量').appendField(new Blockly.FieldTextInput('initial_value'), 'VARIABLE');
    this.setTooltip('比较点位的确认值与本次运行中已保存的同名变量。');
  } };
  Blockly.Blocks[scriptBlocks.range] = { init(this: Blockly.Block) {
    predicate(this);
    this.appendDummyInput().appendField('确认值').appendField(bindingField(this, 'numeric'), 'POINT');
    this.appendDummyInput().appendField('在')
      .appendField(new Blockly.FieldNumber(0), 'MIN').appendField('到').appendField(new Blockly.FieldNumber(100), 'MAX').appendField('之间');
  } };
  for (const [type, label, tooltip] of [
    [scriptBlocks.and, '与', '两项都成立时成立。'],
    [scriptBlocks.or, '或', '任一项成立时成立。'],
  ] as const) {
    Blockly.Blocks[type] = { init(this: Blockly.Block) {
      predicate(this);
      conditionInput(this, 'A');
      conditionInput(this, 'B', label);
      this.setTooltip(tooltip);
    } };
  }
  Blockly.Blocks[scriptBlocks.not] = { init(this: Blockly.Block) {
    predicate(this);
    conditionInput(this, 'CONDITION', '非');
    this.setTooltip('条件确定不成立时成立。');
  } };
}

export function generateScriptLuaSource(_workspace: Blockly.Workspace, graph: ScriptGraph): LuaSource {
  return compileScriptLua(graph).source;
}

export function generateScriptLua(workspace: Blockly.Workspace, graph: ScriptGraph): string {
  return generateScriptLuaSource(workspace, graph).text;
}

export function inspectScriptDraft(workspace: Blockly.Workspace, graph: ScriptGraph): ScriptPreview {
  try {
    const { program, source, pointUses } = compileScriptLua(graph);
    try {
      checkCallbackContexts(program);
      const options = bindings.get(workspace);
      if (options) {
        checkWorkspaceAssignments(program, id => options.tagTypes.get(id));
        checkScriptPoints(pointUses, (ref, access) => resolveScriptPoint(options.points.get(scriptPointKey(ref)), ref, access));
      }
    }
    catch (error) {
      if (!(error instanceof ScriptBlockError)) throw error;
      return { source, issue: { blockId: error.blockId, message: error.message } };
    }
    const available = bindings.get(workspace)?.available;
    for (const blockId of source.ranges.keys()) {
      const block = workspace.getBlockById(blockId);
      if (block?.type === scriptBlocks.onWidget) {
        const kind = bindings.get(workspace)?.widgetKinds.get(String(block.getFieldValue('WIDGET')));
        if (kind && !widgetEvents[kind]?.includes(block.getFieldValue('EVENT') as WidgetEvent)) return { source, issue: { blockId, message: '请为这个控件选择适用的事件' } };
      }
      const field = block?.getField('SLAVE') ?? block?.getField('WIDGET') ?? block?.getField('TAG');
      if (!(field instanceof PointDropdown) || !field.access || !available || available[field.access].has(String(field.getValue()))) continue;
      const labels: Record<List, string> = { slave: '从站', read: '可读点位', write: '可写点位', numeric: '数值点位', widget: '已启用事件的画布控件', tag: '工作区变量' };
      return { source, issue: { blockId, message: '工作区中的绑定已失效，请重新选择' + labels[field.access] + '。' } };
    }
    return { source, issue: null };
  } catch (reason) {
    return { source: null, issue: { message: reason instanceof Error ? reason.message : String(reason),
      blockId: reason instanceof ScriptBlockError ? reason.blockId : undefined } };
  }
}

export function graphOf(workspace: Blockly.Workspace): ScriptGraph {
  return saveScriptGraph(workspace);
}

export function updateCycleHints(workspace: Blockly.WorkspaceSvg) {
  for (const root of workspace.getBlocksByType(scriptBlocks.onRun, false)) {
    let next = root.getNextBlock();
    while (next && !next.isEnabled()) next = next.getNextBlock();
    const hint = root.getInput('EMPTY_HINT');
    if (hint && hint.isVisible() !== !next) {
      hint.setVisible(!next);
      if (root instanceof Blockly.BlockSvg) root.queueRender();
    }
  }
}

installBlocks();
