import * as Blockly from 'blockly/core';
import * as zhHans from 'blockly/msg/zh-hans';
import { blockColours } from './block-palette';
import { Order } from 'blockly/lua';
import { compileScriptProgram, fieldText, isScriptDefinition, MAX_SCRIPT_MS, ScriptBlockError, scriptArithmetic, scriptBlocks, scriptErrors, scriptGraphBlocks, scriptPointKey, scriptRelations, scriptStates, splitParameters, type ScriptGraph } from '../../../domain/master-script';
import type { Workspace } from '../../../domain/model';
import { canReadPoint, canWritePoint } from '../../../domain/point-access';
import { BooleanSwitch, conditionInput, initBranch, literalShadow, LogValueControl, numberSlot, saveScriptGraph } from './block-controls';
import { ScriptLuaGenerator, type LuaSource, type ScriptPreview } from './lua-source';
import { initFunctionCall, parameterField, ParameterListField, ScriptReferenceField } from './function-blocks';

const luaGenerator = new ScriptLuaGenerator();

type Option = [string, string];
type List = 'slave' | 'read' | 'write' | 'numeric';
interface FieldOptions {
  lists: Record<List, Option[]>;
  available: Record<List, Set<string>>;
  savedPoints: Set<string>;
  savedSlaves: Set<string>;
  shortNames: Map<string, string>;
}

export const bindings = new WeakMap<Blockly.Workspace, FieldOptions>();

export function makeFieldOptions(workspace: Workspace | null, graph: ScriptGraph): FieldOptions {
  const lists: Record<List, Option[]> = {
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
    const point = fieldText(block, 'POINT');
    const slave = fieldText(block, 'SLAVE');
    if (point) savedPoints.add(point);
    if (slave) savedSlaves.add(slave);
  }
  const keys = (list: List) => new Set(lists[list].map(([, key]) => key));
  return { lists, savedPoints, savedSlaves, shortNames, available: { slave: keys('slave'), read: keys('read'), write: keys('write'), numeric: keys('numeric') } };
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
    return (key && options?.shortNames.get(key)) || super.getText_();
  }
}
function bindingField(block: Blockly.Block, list: List): Blockly.FieldDropdown {
  const menu = new PointDropdown(function(this: Blockly.FieldDropdown) {
    const options = bindings.get(owner(block));
    if (!options) return [[list === 'slave' ? '选择从站' : '选择点位', '']];
    const selected = this.getValue();
    const saved = new Set(list === 'slave' ? options.savedSlaves : options.savedPoints);
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
  block.appendDummyInput().appendField('超时').appendField(new Blockly.FieldNumber(5000, 50, MAX_SCRIPT_MS, 1), 'TIMEOUT').appendField('ms');
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
    this.appendDummyInput().appendField('开始');
    this.setNextStatement(true);
    this.setColour(blockColours.entry);
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
    action(this, '延时', controlColor).appendField(new Blockly.FieldNumber(500, 0, MAX_SCRIPT_MS, 1), 'MS').appendField('ms');
  } };
  Blockly.Blocks[scriptBlocks.repeat] = { init(this: Blockly.Block) {
    action(this, '重复', controlColor).appendField(new Blockly.FieldNumber(3, 1, 100, 1), 'COUNT').appendField('次');
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
    this.appendDummyInput().appendField(new Blockly.FieldNumber(0), 'NUM');
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

const field = (block: Blockly.Block, name: string) => String(block.getFieldValue(name) ?? '');
function quoteLua(value: string): string {
  const escaped = Array.from(value, char => {
    if (char === '"' || char === '\\') return `\\${char}`;
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 ? `\\${String(code).padStart(3, '0')}` : char;
  });
  return `"${escaped.join('')}"`;
}
function pointArgs(block: Blockly.Block): string {
  const ref = JSON.parse(field(block, 'POINT') || '["",""]') as string[];
  return ref.map(quoteLua).join(', ');
}
function conditionCode(block: Blockly.Block, input = 'CONDITION', order = Order.NONE): string {
  return luaGenerator.valueToCode(block, input, order) || (field(block, 'BOOL_' + input) === 'TRUE' ? 'true' : 'false');
}
function conditionLua(block: Blockly.Block, input = 'CONDITION'): string {
  const code = conditionCode(block, input);
  const result = `return ${code}`;
  return result.includes('\n')
    ? `function()\n${luaGenerator.prefixLines(result, luaGenerator.INDENT)}\nend`
    : `function() ${result} end`;
}
const deviceExpressions = new Set<string>([scriptBlocks.pointValue, scriptBlocks.state, scriptBlocks.range, scriptBlocks.compare, scriptBlocks.compareVariable, scriptBlocks.error]);
function includesDeviceOperand(block: Blockly.Block | null): boolean {
  if (!block) return false;
  if (deviceExpressions.has(block.type)) return true;
  if (block.type === scriptBlocks.callValue) {
    const definition = block.workspace.getBlockById(field(block, 'FUNCTION'))!;
    if (includesDeviceOperand(definition.getInputTargetBlock('RESULT'))) return true;
  }
  return block.inputList.some(input => includesDeviceOperand(input.connection?.targetBlock() ?? null));
}

// A device predicate can be indeterminate until a confirmed sample arrives.
function nativePredicate(block: Blockly.Block | null): boolean {
  if (!block || block.type === scriptBlocks.boolean) return true;
  if (block.type === scriptBlocks.compareValues) return !luaGenerator.names.needsHostCheck(block) && !includesDeviceOperand(block);
  if (block.type === scriptBlocks.callValue && !includesDeviceOperand(block)) {
    const fn = block.workspace.getBlockById(field(block, 'FUNCTION'))!;
    return nativePredicate(fn.getInputTargetBlock('RESULT'));
  }
  if (block.type === scriptBlocks.not) return nativePredicate(block.getInputTargetBlock('CONDITION'));
  if (block.type === scriptBlocks.and || block.type === scriptBlocks.or)
    return nativePredicate(block.getInputTargetBlock('A')) && nativePredicate(block.getInputTargetBlock('B'));
  return false;
}
function branchTest(block: Blockly.Block, input = 'CONDITION', order = Order.NONE): string {
  return nativePredicate(block.getInputTargetBlock(input)) ? conditionCode(block, input, order) : `modbus.check(${conditionLua(block, input)})`;
}
function combinationLua(block: Blockly.Block, operator: 'all' | 'any'): [string, Order] {
  if (nativePredicate(block)) {
    const order = operator === 'all' ? Order.AND : Order.OR;
    return [`${conditionCode(block, 'A', order)} ${operator === 'all' ? 'and' : 'or'} ${conditionCode(block, 'B', order)}`, order];
  }
  const operands = `${conditionLua(block, 'A')},\n${conditionLua(block, 'B')}`;
  return [`modbus.${operator}(\n${luaGenerator.prefixLines(operands, luaGenerator.INDENT)}\n)`, Order.ATOMIC];
}

function loopLuaBody(block: Blockly.Block): string {
  const body = luaGenerator.statementToCode(block, 'BODY');
  const first = block.getInputTargetBlock('BODY');
  if (!first?.getDescendants(false).some(item => item.type === scriptBlocks.breakLoop)) return body;
  // A break inside an error handler crosses a Lua function boundary. The loop
  // captures that control signal at the nearest iteration, just as Main does.
  return '  if not modbus.loop_step(function()\n' + luaGenerator.prefixLines(body, '  ') + '  end) then break end\n';
}

function installLua() {
  luaGenerator.forBlock[scriptBlocks.start] = () => '';
  luaGenerator.forBlock[literalShadow] = block => [quoteLua(field(block, 'TEXT')), Order.ATOMIC];
  luaGenerator.forBlock[scriptBlocks.read] = block => `modbus.read(${pointArgs(block)}, ${field(block, 'TIMEOUT')})\n`;
  luaGenerator.forBlock[scriptBlocks.readVariable] = block => `${luaGenerator.names.assignment(block)} = modbus.value(${pointArgs(block)})\n`;
  const valueCode = (block: Blockly.Block) => luaGenerator.valueToCode(block, 'OPERAND', Order.NONE) || quoteLua(field(block, 'VALUE'));
  luaGenerator.forBlock[scriptBlocks.write] = block => `modbus.write(${pointArgs(block)}, ${valueCode(block)})\n`;
  const slot = (block: Blockly.Block, name: string, order = Order.NONE) => luaGenerator.valueToCode(block, name, order);
  luaGenerator.forBlock[scriptBlocks.number] = block => [field(block, 'NUM'), Number(field(block, 'NUM')) < 0 ? Order.UNARY : Order.ATOMIC];
  luaGenerator.forBlock[scriptBlocks.arithmetic] = block => {
    const symbol = scriptArithmetic.find(([, key]) => key === field(block, 'OP'))![2];
    if (luaGenerator.names.needsHostCheck(block) || includesDeviceOperand(block))
      return [`modbus.arithmetic(${slot(block, 'A')}, ${quoteLua(symbol)}, ${slot(block, 'B')})`, Order.HIGH];
    const order = symbol === '+' || symbol === '-' ? Order.ADDITIVE : Order.MULTIPLICATIVE;
    return [`${slot(block, 'A', order)} ${symbol} ${slot(block, 'B', order)}`, order];
  };
  const relations: Record<string, string> = { eq: '==', ne: '~=', gt: '>', ge: '>=', lt: '<', le: '<=' };
  luaGenerator.forBlock[scriptBlocks.compareValues] = block => {
    const op = field(block, 'OP');
    if (luaGenerator.names.needsHostCheck(block) || includesDeviceOperand(block))
      return [`modbus.compare_values(${slot(block, 'A')}, ${quoteLua(op)}, ${slot(block, 'B')})`, Order.HIGH];
    return [`${slot(block, 'A', Order.RELATIONAL)} ${relations[op]} ${slot(block, 'B', Order.RELATIONAL)}`, Order.RELATIONAL];
  };
  const variable = (block: Blockly.Block) => luaGenerator.names.variable(block, field(block, 'VARIABLE').trim());
  luaGenerator.forBlock[scriptBlocks.setVariable] = block => `${luaGenerator.names.assignment(block)} = ${slot(block, 'OPERAND')}\n`;
  luaGenerator.forBlock[scriptBlocks.changeVariable] = block => {
    const name = variable(block);
    if (luaGenerator.names.needsHostCheck(block)) return `${name} = modbus.arithmetic(${name}, "+", ${slot(block, 'OPERAND')})\n`;
    return `${name} = ${name} + ${slot(block, 'OPERAND', Order.ADDITIVE)}\n`;
  };
  const call = (block: Blockly.Block) => {
    const args = block.inputList.filter(input => /^ARG\d+$/.test(input.name)).map(input => slot(block, input.name));
    const values = args.join(', ');
    // A single wide call would otherwise need one VM register per argument.
    const argumentsLua = args.length > 50 ? `table.unpack({${values}}, 1, ${args.length})` : values;
    return `${luaGenerator.names.functionName(field(block, 'FUNCTION'))}(${argumentsLua})`;
  };
  const definition = (block: Blockly.Block) => {
    const args = luaGenerator.names.parameters(block);
    return `local function ${luaGenerator.names.functionName(block.id)}(${args})\n` + luaGenerator.names.preamble(block, '  ');
  };
  luaGenerator.forBlock[scriptBlocks.procedure] = block => definition(block) + luaGenerator.statementToCode(block, 'BODY') + 'end\n';
  luaGenerator.forBlock[scriptBlocks.calculation] = block => definition(block) + `  return ${slot(block, 'RESULT')}\nend\n`;
  luaGenerator.forBlock[scriptBlocks.call] = block => call(block) + '\n';
  luaGenerator.forBlock[scriptBlocks.callValue] = block => [call(block), Order.HIGH];
  luaGenerator.forBlock[scriptBlocks.parameter] = block => {
    const name = splitParameters(field(block.getRootBlock(), 'PARAMS'))[Number(field(block, 'PARAM'))]!;
    return [luaGenerator.names.variable(block, name), Order.ATOMIC];
  };
  luaGenerator.forBlock[scriptBlocks.log] = block => {
    const message = field(block, 'TEXT');
    const value = block.getInput('OPERAND') ? slot(block, 'OPERAND') : '';
    return `print(${[message && quoteLua(message), value].filter(Boolean).join(', ')})\n`;
  };
  luaGenerator.forBlock[scriptBlocks.wait] = block => `modbus.wait(${conditionLua(block)}, ${field(block, 'TIMEOUT')})\n`;
  luaGenerator.forBlock[scriptBlocks.assert] = block => `modbus.assert(${conditionLua(block)})\n`;
  luaGenerator.forBlock[scriptBlocks.branch] = block => {
    let code = `if ${branchTest(block)} then\n${luaGenerator.statementToCode(block, 'YES')}`;
    for (let i = 1; block.getInput('COND' + i); i++) {
      code += `elseif ${branchTest(block, 'COND' + i)} then\n${luaGenerator.statementToCode(block, 'YES' + i)}`;
    }
    if (block.getInput('NO')) code += 'else\n' + luaGenerator.statementToCode(block, 'NO');
    return code + 'end\n';
  };
  luaGenerator.forBlock[scriptBlocks.delay] = block => `modbus.delay(${field(block, 'MS')})\n`;
  luaGenerator.forBlock[scriptBlocks.repeat] = block => `for _step = 1, ${field(block, 'COUNT')} do\n${loopLuaBody(block)}end\n`;
  luaGenerator.forBlock[scriptBlocks.forever] = block => `while true do\n${loopLuaBody(block)}  modbus.yield_io()\nend\n`;
  luaGenerator.forBlock[scriptBlocks.repeatUntil] = block => `while not ${branchTest(block, 'CONDITION', Order.UNARY)} do\n${loopLuaBody(block)}  modbus.yield_io()\nend\n`;
  luaGenerator.forBlock[scriptBlocks.stop] = () => 'modbus.stop()\n';
  luaGenerator.forBlock[scriptBlocks.breakLoop] = () => 'modbus.break_loop()\n';
  luaGenerator.forBlock[scriptBlocks.attempt] = block => {
    const body = luaGenerator.statementToCode(block, 'BODY');
    const handler = luaGenerator.statementToCode(block, 'ERROR');
    return `modbus.attempt(function()\n${body}end${handler ? ', function()\n' + handler + 'end' : ''})\n`;
  };
  luaGenerator.forBlock[scriptBlocks.variable] = block => [variable(block), Order.ATOMIC];
  luaGenerator.forBlock[scriptBlocks.pointValue] = block => [`modbus.value(${pointArgs(block)})`, Order.ATOMIC];
  luaGenerator.forBlock[scriptBlocks.boolean] = block => [field(block, 'BOOL') === 'TRUE' ? 'true' : 'false', Order.ATOMIC];
  luaGenerator.forBlock[scriptBlocks.error] = block => [`modbus.error_is(${quoteLua(field(block, 'CODE'))})`, Order.ATOMIC];
  luaGenerator.forBlock[scriptBlocks.state] = block => [`modbus.state(${quoteLua(field(block, 'SLAVE'))}, ${quoteLua(field(block, 'STATE'))})`, Order.ATOMIC];
  luaGenerator.forBlock[scriptBlocks.compare] = block => [`modbus.compare(${pointArgs(block)}, ${quoteLua(field(block, 'OP'))}, ${valueCode(block)})`, Order.ATOMIC];
  luaGenerator.forBlock[scriptBlocks.compareVariable] = block => [`modbus.compare(${pointArgs(block)}, ${quoteLua(field(block, 'OP'))}, ${variable(block)})`, Order.HIGH];
  luaGenerator.forBlock[scriptBlocks.range] = block => [`modbus.in_range(${pointArgs(block)}, ${field(block, 'MIN')}, ${field(block, 'MAX')})`, Order.ATOMIC];
  luaGenerator.forBlock[scriptBlocks.and] = block => combinationLua(block, 'all');
  luaGenerator.forBlock[scriptBlocks.or] = block => combinationLua(block, 'any');
  luaGenerator.forBlock[scriptBlocks.not] = block => nativePredicate(block)
    ? [`not ${conditionCode(block, 'CONDITION', Order.UNARY)}`, Order.UNARY]
    : [`modbus.negate(${conditionLua(block)})`, Order.HIGH];
}

export function generateScriptLuaSource(workspace: Blockly.Workspace, graph: ScriptGraph): LuaSource {
  const program = compileScriptProgram(graph);
  const start = workspace.getBlocksByType(scriptBlocks.start, false).find(block => block.isEnabled())!;
  return luaGenerator.preview(start, program.functions.map(fn => workspace.getBlockById(fn.id)!));
}

export function generateScriptLua(workspace: Blockly.Workspace, graph: ScriptGraph): string {
  return generateScriptLuaSource(workspace, graph).text;
}

export function inspectScriptDraft(workspace: Blockly.Workspace, graph: ScriptGraph): ScriptPreview {
  try {
    const source = generateScriptLuaSource(workspace, graph);
    const available = bindings.get(workspace)?.available;
    for (const blockId of source.ranges.keys()) {
      const block = workspace.getBlockById(blockId);
      const field = block?.getField('POINT') ?? block?.getField('SLAVE');
      if (!(field instanceof PointDropdown) || !field.access || !available || available[field.access].has(String(field.getValue()))) continue;
      const labels: Record<List, string> = { slave: '从站', read: '可读点位', write: '可写点位', numeric: '数值点位' };
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

installBlocks();
installLua();
