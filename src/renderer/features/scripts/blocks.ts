import * as Blockly from 'blockly/core';
import * as zhHans from 'blockly/msg/zh-hans';
import { luaGenerator, Order } from 'blockly/lua';
import { compileMasterScript, fieldText, MAX_SCRIPT_MS, scriptBlocks, scriptErrors, scriptGraphBlocks, scriptPointKey, scriptRelations, scriptStates, type ScriptGraph } from '../../../domain/master-script';
import type { Workspace } from '../../../domain/model';
import { canReadPoint, canWritePoint } from '../../../domain/point-access';
import { BooleanSwitch, conditionInput, initBranch, literalShadow, saveScriptGraph } from './block-controls';

type Option = [string, string];
type List = 'slave' | 'read' | 'write' | 'numeric';
interface FieldOptions {
  lists: Record<List, Option[]>;
  available: Record<List, Set<string>>;
  savedPoints: Set<string>;
  savedSlaves: Set<string>;
  shortNames: Map<string, string>;
  variables: Set<string>;
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
  const variables = new Set<string>();
  for (const block of scriptGraphBlocks(graph)) {
    const point = fieldText(block, 'POINT');
    const slave = fieldText(block, 'SLAVE');
    if (point) savedPoints.add(point);
    if (slave) savedSlaves.add(slave);
    const variable = fieldText(block, 'VARIABLE').trim();
    if (variable) variables.add(variable);
  }
  const keys = (list: List) => new Set(lists[list].map(([, key]) => key));
  return { lists, savedPoints, savedSlaves, variables, shortNames, available: { slave: keys('slave'), read: keys('read'), write: keys('write'), numeric: keys('numeric') } };
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
  return new Blockly.FieldDropdown(function(this: Blockly.FieldDropdown) {
    const workspace = owner(block);
    const names = new Set(bindings.get(workspace)?.variables);
    for (const item of workspace.getBlocksByType(scriptBlocks.readVariable, false)) {
      const name = String(item.getFieldValue('VARIABLE') ?? '').trim();
      if (name) names.add(name);
    }
    const current = this.getValue();
    if (current) names.add(current);
    return [['选择变量', ''], ...[...names].sort().map((name): Option => [name, name])] as Option[];
  });
}

const actionColor = '#2868a6';
const controlColor = '#99601c';
const conditionColor = '#16755b';
const valueColor = '#6b55a0';
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
  block.setInputsInline(false);
  conditionInput(block, 'CONDITION', label);
}
function predicate(block: Blockly.Block) {
  block.setOutput(true, 'Boolean');
  block.setColour(conditionColor);
  block.setInputsInline(false);
}

function installBlocks() {
  const messages = Object.fromEntries(Object.entries(zhHans).flatMap(([key, value]) => typeof value === 'string' ? [[key, value]] : []));
  Blockly.setLocale({ ...messages, DISABLE_BLOCK: '停用此段', ENABLE_BLOCK: '启用此段' });
  Blockly.Blocks[literalShadow] = { init(this: Blockly.Block) {
    this.setOutput(true, 'ScriptValue'); this.setColour(valueColor);
    this.appendDummyInput().appendField(new Blockly.FieldTextInput('0'), 'TEXT');
  } };
  Blockly.Blocks[scriptBlocks.start] = { init(this: Blockly.Block) {
    this.hat = 'cap';
    this.appendDummyInput().appendField('开始');
    this.setNextStatement(true);
    this.setColour(controlColor);
  } };
  Blockly.Blocks[scriptBlocks.read] = { init(this: Blockly.Block) {
    action(this, '等待新采样').appendField(bindingField(this, 'read'), 'POINT');
    timeout(this);
    this.setTooltip('等待下一次确认采样，并记录该值。');
  } };
  Blockly.Blocks[scriptBlocks.readVariable] = { init(this: Blockly.Block) {
    action(this, '读取到变量').appendField(new Blockly.FieldTextInput('初值'), 'VARIABLE');
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
    action(this, '记录日志', controlColor).appendField(new Blockly.FieldTextInput('调试信息'), 'TEXT');
    this.appendValueInput('OPERAND').setCheck(['ScriptValue', 'Boolean']).appendField('附加值');
    this.setInputsInline(false);
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
    this.appendStatementInput('BODY').appendField('执行');
  } };
  Blockly.Blocks[scriptBlocks.forever] = { init(this: Blockly.Block) {
    action(this, '主循环', controlColor);
    this.appendStatementInput('BODY').appendField('执行');
    this.setTooltip('重复执行直到停止或跳出。轮次间让出调度，间隔用延时或等待新采样设定。');
  } };
  Blockly.Blocks[scriptBlocks.repeatUntil] = { init(this: Blockly.Block) {
    statementCondition(this, '重复直到');
    this.appendStatementInput('BODY').appendField('执行');
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
    this.setOutput(true, 'ScriptValue'); this.setColour(valueColor);
    this.appendDummyInput().appendField('变量').appendField(variableField(this), 'VARIABLE');
  } };
  Blockly.Blocks[scriptBlocks.pointValue] = { init(this: Blockly.Block) {
    this.setOutput(true, 'ScriptValue'); this.setColour(valueColor);
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
  Blockly.Blocks[scriptBlocks.compareVariable] = { init(this: Blockly.Block) {
    predicate(this);
    this.appendDummyInput().appendField('与变量比较').appendField(bindingField(this, 'read'), 'POINT');
    this.appendDummyInput().appendField(new Blockly.FieldDropdown(scriptRelations.map(([label, value]) => [label, value])), 'OP')
      .appendField('变量').appendField(new Blockly.FieldTextInput('初值'), 'VARIABLE');
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
      conditionInput(this, 'A', label);
      conditionInput(this, 'B');
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
function conditionLua(block: Blockly.Block, input = 'CONDITION'): string {
  const code = luaGenerator.valueToCode(block, input, Order.NONE) || (field(block, 'BOOL_' + input) === 'TRUE' ? 'true' : 'false');
  const result = `return ${code}`;
  return result.includes('\n')
    ? `function()\n${luaGenerator.prefixLines(result, luaGenerator.INDENT)}\nend`
    : `function() ${result} end`;
}
function combinationLua(block: Blockly.Block, operator: 'all' | 'any'): [string, Order] {
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
  luaGenerator.forBlock[scriptBlocks.readVariable] = block => `modbus.read_into(${quoteLua(field(block, 'VARIABLE').trim())}, ${pointArgs(block)})\n`;
  const valueCode = (block: Blockly.Block) => luaGenerator.valueToCode(block, 'OPERAND', Order.NONE) || quoteLua(field(block, 'VALUE'));
  luaGenerator.forBlock[scriptBlocks.write] = block => `modbus.write(${pointArgs(block)}, ${valueCode(block)})\n`;
  luaGenerator.forBlock[scriptBlocks.log] = block => {
    const message = field(block, 'TEXT');
    const value = luaGenerator.valueToCode(block, 'OPERAND', Order.NONE);
    return `print(${[message && quoteLua(message), value].filter(Boolean).join(', ')})\n`;
  };
  luaGenerator.forBlock[scriptBlocks.wait] = block => `modbus.wait(${conditionLua(block)}, ${field(block, 'TIMEOUT')})\n`;
  luaGenerator.forBlock[scriptBlocks.assert] = block => `modbus.assert(${conditionLua(block)})\n`;
  luaGenerator.forBlock[scriptBlocks.branch] = block => {
    let code = `if modbus.check(${conditionLua(block)}) then\n${luaGenerator.statementToCode(block, 'YES')}`;
    for (let i = 1; block.getInput('COND' + i); i++) {
      code += `elseif modbus.check(${conditionLua(block, 'COND' + i)}) then\n${luaGenerator.statementToCode(block, 'YES' + i)}`;
    }
    if (block.getInput('NO')) code += 'else\n' + luaGenerator.statementToCode(block, 'NO');
    return code + 'end\n';
  };
  luaGenerator.forBlock[scriptBlocks.delay] = block => `modbus.delay(${field(block, 'MS')})\n`;
  luaGenerator.forBlock[scriptBlocks.repeat] = block => `for _step = 1, ${field(block, 'COUNT')} do\n${loopLuaBody(block)}end\n`;
  luaGenerator.forBlock[scriptBlocks.forever] = block => `while true do\n${loopLuaBody(block)}  modbus.yield_io()\nend\n`;
  luaGenerator.forBlock[scriptBlocks.repeatUntil] = block => `while not modbus.check(${conditionLua(block)}) do\n${loopLuaBody(block)}  modbus.yield_io()\nend\n`;
  luaGenerator.forBlock[scriptBlocks.stop] = () => 'modbus.stop()\n';
  luaGenerator.forBlock[scriptBlocks.breakLoop] = () => 'modbus.break_loop()\n';
  luaGenerator.forBlock[scriptBlocks.attempt] = block => {
    const body = luaGenerator.statementToCode(block, 'BODY');
    const handler = luaGenerator.statementToCode(block, 'ERROR');
    return `modbus.attempt(function()\n${body}end${handler ? ', function()\n' + handler + 'end' : ''})\n`;
  };
  luaGenerator.forBlock[scriptBlocks.variable] = block => [`modbus.variable(${quoteLua(field(block, 'VARIABLE').trim())})`, Order.ATOMIC];
  luaGenerator.forBlock[scriptBlocks.pointValue] = block => [`modbus.value(${pointArgs(block)})`, Order.ATOMIC];
  luaGenerator.forBlock[scriptBlocks.boolean] = block => [field(block, 'BOOL') === 'TRUE' ? 'true' : 'false', Order.ATOMIC];
  luaGenerator.forBlock[scriptBlocks.error] = block => [`modbus.error_is(${quoteLua(field(block, 'CODE'))})`, Order.ATOMIC];
  luaGenerator.forBlock[scriptBlocks.state] = block => [`modbus.state(${quoteLua(field(block, 'SLAVE'))}, ${quoteLua(field(block, 'STATE'))})`, Order.ATOMIC];
  luaGenerator.forBlock[scriptBlocks.compare] = block => [`modbus.compare(${pointArgs(block)}, ${quoteLua(field(block, 'OP'))}, ${valueCode(block)})`, Order.ATOMIC];
  luaGenerator.forBlock[scriptBlocks.compareVariable] = block => [`modbus.compare_variable(${pointArgs(block)}, ${quoteLua(field(block, 'OP'))}, ${quoteLua(field(block, 'VARIABLE').trim())})`, Order.ATOMIC];
  luaGenerator.forBlock[scriptBlocks.range] = block => [`modbus.in_range(${pointArgs(block)}, ${field(block, 'MIN')}, ${field(block, 'MAX')})`, Order.ATOMIC];
  luaGenerator.forBlock[scriptBlocks.and] = block => combinationLua(block, 'all');
  luaGenerator.forBlock[scriptBlocks.or] = block => combinationLua(block, 'any');
  luaGenerator.forBlock[scriptBlocks.not] = block => [`modbus.negate(${conditionLua(block)})`, Order.ATOMIC];
}

export function generateScriptLua(workspace: Blockly.Workspace, graph: ScriptGraph): string {
  compileMasterScript(graph);
  return luaGenerator.workspaceToCode(workspace).trim();
}

const paletteBlocks = (types: string[]) => types.map(type => ({ kind: 'block', type, gap: 14 }));
export const scriptToolbox = {
  kind: 'categoryToolbox' as const,
  contents: [
    { kind: 'category', name: '设备操作', colour: actionColor, contents: paletteBlocks([scriptBlocks.read, scriptBlocks.write, scriptBlocks.readVariable]) },
    { kind: 'category', name: '流程', colour: controlColor, contents: paletteBlocks([scriptBlocks.start, scriptBlocks.log, scriptBlocks.branch, scriptBlocks.repeat, scriptBlocks.repeatUntil, scriptBlocks.forever, scriptBlocks.delay, scriptBlocks.wait, scriptBlocks.assert, scriptBlocks.attempt, scriptBlocks.breakLoop, scriptBlocks.stop]) },
    { kind: 'category', name: '条件', colour: conditionColor, contents: paletteBlocks([scriptBlocks.state, scriptBlocks.compare, scriptBlocks.range, scriptBlocks.and, scriptBlocks.or, scriptBlocks.not, scriptBlocks.error]) },
    { kind: 'category', name: '取值', colour: valueColor, contents: paletteBlocks([scriptBlocks.variable, scriptBlocks.pointValue, scriptBlocks.boolean]) },
  ],
};

export function graphOf(workspace: Blockly.Workspace): ScriptGraph {
  return saveScriptGraph(workspace);
}

installBlocks();
installLua();
