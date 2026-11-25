import { z } from 'zod';
import type { SlaveCommunicationState } from '../shared/snapshot';

export const scriptBlocks = {
  start: 'mb_start',
  onRun: 'mb_on_run',
  onTimer: 'mb_on_timer',
  runPeriod: 'mb_run_period',
  runControl: 'mb_run_control',
  timerStart: 'mb_timer_start',
  timerStop: 'mb_timer_stop',
  timerElapsed: 'mb_timer_elapsed',
  timerRunning: 'mb_timer_running',
  read: 'mb_read',
  readVariable: 'mb_read_var',
  setVariable: 'mb_set_var',
  changeVariable: 'mb_change_var',
  number: 'mb_number',
  arithmetic: 'mb_arithmetic',
  compareValues: 'mb_compare_values',
  procedure: 'mb_procedure',
  calculation: 'mb_function',
  call: 'mb_call',
  callValue: 'mb_call_value',
  parameter: 'mb_parameter',
  write: 'mb_write',
  log: 'mb_log',
  wait: 'mb_wait',
  assert: 'mb_assert',
  delay: 'mb_delay',
  repeat: 'mb_repeat',
  forever: 'mb_forever',
  repeatUntil: 'mb_repeat_until',
  stop: 'mb_stop',
  breakLoop: 'mb_break',
  attempt: 'mb_try',
  error: 'mb_error_is',
  branch: 'mb_if',
  compare: 'mb_compare',
  compareVariable: 'mb_compare_var',
  range: 'mb_range',
  state: 'mb_state',
  and: 'mb_and',
  or: 'mb_or',
  not: 'mb_not',
  boolean: 'mb_boolean',
  variable: 'mb_variable',
  pointValue: 'mb_point_value',
} as const;

export const scriptRelations = [['等于', 'eq'], ['不等于', 'ne'], ['大于', 'gt'], ['大于或等于', 'ge'], ['小于', 'lt'], ['小于或等于', 'le']] as const;
export const scriptArithmetic = [['+', 'add', '+'], ['−', 'subtract', '-'], ['×', 'multiply', '*'], ['÷', 'divide', '/']] as const;
export const scriptStates = [['在线', 'online'], ['离线', 'offline'], ['待确认', 'pending'], ['连接中', 'connecting'], ['停用', 'disabled']] as const;
export const scriptErrors = [['等待超时', 'timeout'], ['写入未发送', 'not-sent'], ['设备拒绝写入', 'rejected'], ['写入结果未知', 'unknown'], ['判断或数据错误', 'evaluation']] as const;
export type ScriptErrorKind = typeof scriptErrors[number][1];
export const MAX_SCRIPT_BLOCKS = 200;
export const MAX_SCRIPT_STEPS = 1000;
export const MAX_SCRIPT_MS = 120000;
export const DEFAULT_RUN_PERIOD = 100;
export const MIN_EVENT_PERIOD = 10;
export const SCRIPT_TIMER_COUNT = 8;
export const MAX_EVENT_ITERATIONS = 1_000_000;

type ScriptBlockKind = typeof scriptBlocks[keyof typeof scriptBlocks];
export const scriptNumberSlots: Partial<Record<ScriptBlockKind, Record<string, number>>> = {
  [scriptBlocks.runPeriod]: { PERIOD: DEFAULT_RUN_PERIOD },
  [scriptBlocks.timerStart]: { PERIOD: 1000 },
  [scriptBlocks.calculation]: { RESULT: 0 },
  [scriptBlocks.setVariable]: { OPERAND: 0 },
  [scriptBlocks.changeVariable]: { OPERAND: 1 },
  [scriptBlocks.arithmetic]: { A: 0, B: 1 },
  [scriptBlocks.compareValues]: { A: 0, B: 0 },
};
type FieldValue = string | number | boolean;
type Relation = typeof scriptRelations[number][1];
const id = z.string().min(1).max(250);
const field = z.union([z.string().max(4000), z.number().finite(), z.boolean()]);
const blockHeaderSchema = z.object({
  type: z.custom<ScriptBlockKind>(value => typeof value === 'string' && Object.values(scriptBlocks).some(kind => kind === value)),
  id,
  fields: z.record(field).optional(),
  extraState: z.object({ elseIfCount: z.number().int().min(0).max(MAX_SCRIPT_BLOCKS).optional(), hasElse: z.boolean().optional(),
    parameters: z.array(z.string().max(120)).max(MAX_SCRIPT_BLOCKS).optional() }).strict().optional(),
  disabledReasons: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  inputs: z.record(z.object({ block: z.unknown().optional() }).strict()).optional(),
  next: z.object({ block: z.unknown() }).strict().optional(),
});

export interface ScriptBlock {
  id: string;
  type: ScriptBlockKind;
  x?: number;
  y?: number;
  fields?: Record<string, FieldValue>;
  extraState?: { elseIfCount?: number; hasElse?: boolean; parameters?: string[] };
  enabled?: boolean;
  disabledReasons?: string[];
  inputs?: Record<string, { block?: ScriptBlock }>;
  next?: { block: ScriptBlock };
}

export interface ScriptGraph {
  blocks?: { languageVersion: 0; blocks: ScriptBlock[] };
  breakpoints?: string[];
  [key: string]: unknown;
}

function isBoundedJson(root: unknown): boolean {
  const pending = [{ value: root, depth: 0 }];
  let nodes = 0;
  let characters = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++nodes > 8000 || depth > MAX_SCRIPT_BLOCKS * 3 + 10) return false;
    if (value === null || typeof value === 'boolean') continue;
    if (typeof value === 'string') {
      characters += value.length;
      if (characters > 240000) return false;
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) continue;
    if (typeof value !== 'object') return false;
    const children = Object.entries(value);
    if (nodes + pending.length + children.length > 8000) return false;
    for (const [key, child] of children) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) return false;
      pending.push({ value: child, depth: depth + 1 });
    }
  }
  return true;
}

const graphHeaderSchema = z.object({
  blocks: z.object({ languageVersion: z.literal(0), blocks: z.array(z.unknown()).max(MAX_SCRIPT_BLOCKS) }).optional(),
  breakpoints: z.array(id).max(MAX_SCRIPT_BLOCKS).optional(),
});

function validGraph(value: unknown): boolean {
  const graph = graphHeaderSchema.safeParse(value);
  if (!graph.success || !isBoundedJson(value)) return false;
  const pending = [...(graph.data.blocks?.blocks ?? [])];
  const ids = new Set<string>();
  let branchInputs = 0;
  while (pending.length) {
    const block = blockHeaderSchema.safeParse(pending.pop());
    if (!block.success || ids.has(block.data.id) || ids.size >= MAX_SCRIPT_BLOCKS) return false;
    ids.add(block.data.id);
    if (block.data.extraState) {
      const shape = block.data.extraState;
      if (isScriptCall(block.data.type)) {
        if (!shape.parameters || shape.elseIfCount !== undefined || shape.hasElse !== undefined) return false;
      } else if (block.data.type === scriptBlocks.branch && shape.elseIfCount !== undefined && typeof shape.hasElse === 'boolean' && !shape.parameters) {
        branchInputs += shape.elseIfCount;
      } else return false;
      if (branchInputs > MAX_SCRIPT_BLOCKS) return false;
    }
    if (block.data.type === scriptBlocks.branch) {
      const shape = block.data.extraState;
      if (shape && !shape.hasElse && block.data.inputs?.NO?.block) return false;
      for (const name of Object.keys(block.data.inputs ?? {})) {
        const numbered = /^(?:COND|YES)(\d+)$/.exec(name);
        if (numbered && (+numbered[1]! < 1 || +numbered[1]! > (shape?.elseIfCount ?? 0))) return false;
      }
    }
    if ((block.data.type === scriptBlocks.stop || block.data.type === scriptBlocks.breakLoop || isScriptDefinition(block.data.type)) && block.data.next) return false;
    if ([scriptBlocks.start, scriptBlocks.onRun, scriptBlocks.onTimer].some(type => type === block.data.type)
      && Object.keys(block.data.inputs ?? {}).length) return false;
    if (block.data.next) pending.push(block.data.next.block);
    for (const input of Object.values(block.data.inputs ?? {})) {
      if (input.block !== undefined) pending.push(input.block);
    }
  }
  return true;
}

const scriptGraphSchema = z.custom<ScriptGraph>(validGraph, '积木数据无效、包含未知类型或超出容量').transform(graph => {
  // Older editors saved TIMEOUT on blocks that now read the current state immediately.
  const current = structuredClone(graph);
  for (const block of scriptGraphBlocks(current)) {
    if (block.type === scriptBlocks.branch && block.inputs?.NO && !block.extraState) {
      block.extraState = { elseIfCount: 0, hasElse: true };
    }
    if (block.type === scriptBlocks.readVariable || block.type === scriptBlocks.assert || block.type === scriptBlocks.branch) {
      delete block.fields?.TIMEOUT;
    }
  }
  return withScriptBreakpoints(current, current.breakpoints ?? []);
});
export const masterScriptSchema = z.object({
  id,
  name: z.string().trim().min(1).max(120),
  revision: z.number().int().nonnegative(),
  graph: scriptGraphSchema,
});
export type MasterScript = z.infer<typeof masterScriptSchema>;
export const scriptFileSchema = z.object({
  format: z.literal('modbus-master-script'),
  version: z.literal(1),
  name: masterScriptSchema.shape.name,
  graph: scriptGraphSchema,
});

export interface ScriptPointRef { slaveId: string; pointId: string }
export interface FunctionSignature { id: string; name: string; parameters: string[]; returnsValue: boolean }
export type ScriptFunction = FunctionSignature & ({ kind: 'procedure'; steps: ScriptStep[] } | { kind: 'calculation'; result: ScriptOperand });
export interface ScriptHandlers<T> {
  onRun?: { blockId: string; periodMs: number; steps: T[] };
  timers: { blockId: string; channel: number; steps: T[] }[];
}
export interface ScriptProgram { steps: ScriptStep[]; functions: ScriptFunction[]; handlers?: ScriptHandlers<ScriptStep> }
type FunctionTable = ReadonlyMap<string, FunctionSignature>;
export function isScriptDefinition(type: string) { return type === scriptBlocks.procedure || type === scriptBlocks.calculation; }
const clockBlocks = new Set<string>([scriptBlocks.runPeriod, scriptBlocks.runControl, scriptBlocks.timerStart,
  scriptBlocks.timerStop, scriptBlocks.timerElapsed, scriptBlocks.timerRunning]);
export function isScriptCall(type: string) { return type === scriptBlocks.call || type === scriptBlocks.callValue; }
export function splitParameters(text: string): string[] { return text.trim() ? text.split(/[,，]/).map(name => name.trim()) : []; }

export type ScriptOperand =
  | { kind: 'literal'; text: string }
  | { kind: 'number'; value: number }
  | { kind: 'timerElapsed'; channel: number }
  | { kind: 'timerRunning'; channel: number }
  | { kind: 'callValue'; functionId: string; args: ScriptOperand[] }
  | { kind: 'arithmetic'; operator: typeof scriptArithmetic[number][1]; left: ScriptOperand; right: ScriptOperand }
  | { kind: 'variable'; name: string }
  | { kind: 'point'; ref: ScriptPointRef }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'condition'; condition: ScriptCondition };
export type ScriptCondition = { blockId: string } & (
  | { kind: 'truth'; operand: ScriptOperand }
  | { kind: 'error'; code: ScriptErrorKind }
  | { kind: 'state'; slaveId: string; state: SlaveCommunicationState }
  | { kind: 'compare'; ref: ScriptPointRef; relation: Relation; operand: ScriptOperand }
  | { kind: 'compareValues'; relation: Relation; left: ScriptOperand; right: ScriptOperand }
  | { kind: 'and'; left: ScriptCondition; right: ScriptCondition }
  | { kind: 'or'; left: ScriptCondition; right: ScriptCondition }
  | { kind: 'not'; operand: ScriptCondition }
  | { kind: 'range'; ref: ScriptPointRef; min: number; max: number });
export type ScriptStep = { blockId: string } & (
  | { kind: 'read'; ref: ScriptPointRef; timeoutMs: number }
  | { kind: 'capture'; ref: ScriptPointRef; variable: string }
  | { kind: 'setVariable' | 'changeVariable'; variable: string; operand: ScriptOperand }
  | { kind: 'call'; functionId: string; args: ScriptOperand[] }
  | { kind: 'write'; ref: ScriptPointRef; operand: ScriptOperand }
  | { kind: 'log'; message: string; operand?: ScriptOperand }
  | { kind: 'wait'; condition: ScriptCondition; timeoutMs: number }
  | { kind: 'assert'; condition: ScriptCondition }
  | { kind: 'delay'; ms: number }
  | { kind: 'runPeriod'; period: ScriptOperand }
  | { kind: 'runControl'; enabled: boolean }
  | { kind: 'timerStart'; channel: number; period: ScriptOperand; count: number }
  | { kind: 'timerStop'; channel: number }
  | { kind: 'repeat'; count: number; steps: ScriptStep[] }
  | { kind: 'forever'; steps: ScriptStep[] }
  | { kind: 'repeatUntil'; condition: ScriptCondition; steps: ScriptStep[] }
  | { kind: 'stop' | 'break' }
  | { kind: 'attempt'; steps: ScriptStep[]; handler: ScriptStep[] }
  | { kind: 'branch'; arms: { condition: ScriptCondition; steps: ScriptStep[] }[]; no: ScriptStep[] }
);

export class ScriptBlockError extends Error {
  constructor(message: string, readonly blockId?: string) { super(message); }
}

const refSchema = z.tuple([id, id]);
export function scriptPointKey(ref: ScriptPointRef): string {
  return JSON.stringify([ref.slaveId, ref.pointId]);
}

export function fieldText(block: ScriptBlock, name: string): string {
  const value = block.fields?.[name];
  return typeof value === 'string' ? value : String(value ?? '');
}

function pointRef(block: ScriptBlock): ScriptPointRef {
  let ref: unknown;
  try { ref = JSON.parse(fieldText(block, 'POINT')); } catch { /* Rebinding is handled by the editor. */ }
  const parsed = refSchema.safeParse(ref);
  if (!parsed.success) throw new ScriptBlockError('请选择点位', block.id);
  return { slaveId: parsed.data[0], pointId: parsed.data[1] };
}

function fieldNumber(block: ScriptBlock, name: string): number {
  const text = fieldText(block, name);
  const value = Number(text);
  if (!text.trim() || !Number.isFinite(value)) throw new ScriptBlockError('请输入有效的数值', block.id);
  return value;
}

function integer(block: ScriptBlock, name: string, min: number, max: number): number {
  const value = fieldNumber(block, name);
  if (!Number.isInteger(value) || value < min || value > max) throw new ScriptBlockError(`请输入 ${min}–${max} 之间的整数`, block.id);
  return value;
}

function enabled(block: ScriptBlock): boolean {
  return block.enabled !== false && !block.disabledReasons?.length;
}

function timerChannel(block: ScriptBlock) { return block.fields?.TIMER === undefined ? 0 : integer(block, 'TIMER', 0, SCRIPT_TIMER_COUNT - 1); }

function eventPeriod(block: ScriptBlock, scope: CompileScope) {
  const value = slotOperand(block, 'PERIOD', scope);
  if (value.kind === 'number' && (!Number.isInteger(value.value) || value.value < MIN_EVENT_PERIOD || value.value > MAX_SCRIPT_MS))
    throw new ScriptBlockError(`周期须为 ${MIN_EVENT_PERIOD}–${MAX_SCRIPT_MS} ms 的整数`, block.id);
  return value;
}

function variableName(block: ScriptBlock): string {
  const name = fieldText(block, 'VARIABLE').trim();
  if (!name && (block.type === scriptBlocks.variable || block.type === scriptBlocks.changeVariable)) throw new ScriptBlockError('请选择运行变量', block.id);
  if (!name || name.length > 120) throw new ScriptBlockError('请输入 1–120 个字符的变量名', block.id);
  return name;
}

interface CompileScope { functions: FunctionTable; include(id: string, caller: string): number; callCost: number; parameters: string[]; cooperative: boolean }

function callOperands(block: ScriptBlock, scope: CompileScope) {
  const functionId = fieldText(block, 'FUNCTION');
  const fn = scope.functions.get(functionId);
  if (!fn || fn.returnsValue !== (block.type === scriptBlocks.callValue)) throw new ScriptBlockError('请选择存在且类型匹配的函数', block.id);
  scope.callCost += scope.include(functionId, block.id);
  const extra = [...Object.keys(block.inputs ?? {}), ...Object.keys(block.fields ?? {})]
    .some(key => /^ARG\d+$/.test(key) && Number(key.slice(3)) >= fn.parameters.length);
  if (extra || (block.extraState?.parameters?.length ?? 0) > fn.parameters.length)
    throw new ScriptBlockError('函数已减少参数，请移出多余的实参或将其数值清零', block.id);
  return { functionId, args: fn.parameters.map((_, i) => slotOperand(block, 'ARG' + i, scope)) };
}

function reporter(block: ScriptBlock, scope: CompileScope): ScriptOperand {
  if (!enabled(block)) throw new ScriptBlockError('请启用或移除停用的值积木', block.id);
  if (block.type === scriptBlocks.callValue) return { kind: 'callValue', ...callOperands(block, scope) };
  if (block.type === scriptBlocks.parameter) {
    const index = fieldText(block, 'PARAM');
    const name = /^\d+$/.test(index) ? scope.parameters[Number(index)] : undefined;
    if (!name) throw new ScriptBlockError('请选择当前函数的参数', block.id);
    return { kind: 'variable', name };
  }
  if (block.type === scriptBlocks.number) return { kind: 'number', value: fieldNumber(block, 'NUM') };
  if (block.type === scriptBlocks.timerElapsed || block.type === scriptBlocks.timerRunning)
    return { kind: block.type === scriptBlocks.timerElapsed ? 'timerElapsed' : 'timerRunning', channel: timerChannel(block) };
  if (block.type === scriptBlocks.arithmetic) {
    const operator = scriptArithmetic.find(([, key]) => key === fieldText(block, 'OP'))?.[1];
    if (!operator) throw new ScriptBlockError('请选择四则运算符', block.id);
    return { kind: 'arithmetic', operator, left: slotOperand(block, 'A', scope), right: slotOperand(block, 'B', scope) };
  }
  if (block.type === scriptBlocks.variable) return { kind: 'variable', name: variableName(block) };
  if (block.type === scriptBlocks.pointValue) return { kind: 'point', ref: pointRef(block) };
  if (block.type === scriptBlocks.boolean) {
    const value = fieldText(block, 'BOOL');
    if (value === 'TRUE' || value === 'FALSE') return { kind: 'boolean', value: value === 'TRUE' };
    throw new ScriptBlockError('请选择真或假', block.id);
  }
  if ([scriptBlocks.compare, scriptBlocks.compareVariable, scriptBlocks.compareValues, scriptBlocks.range, scriptBlocks.state, scriptBlocks.error,
    scriptBlocks.and, scriptBlocks.or, scriptBlocks.not].some(type => type === block.type)) {
    return { kind: 'condition', condition: conditionBlock(block, scope) };
  }
  throw new ScriptBlockError('请选择点位值、运行变量或布尔值', block.id);
}

function operand(block: ScriptBlock, scope: CompileScope): ScriptOperand {
  const connected = block.inputs?.OPERAND?.block;
  return connected ? reporter(connected, scope) : { kind: 'literal', text: fieldText(block, 'VALUE') };
}

function slotOperand(block: ScriptBlock, name: string, scope: CompileScope): ScriptOperand {
  const child = block.inputs?.[name]?.block;
  if (child) {
    const value = reporter(child, scope);
    if ((block.type === scriptBlocks.arithmetic || block.type === scriptBlocks.changeVariable || name === 'PERIOD')
      && (value.kind === 'boolean' || value.kind === 'condition' || value.kind === 'timerRunning')) throw new ScriptBlockError('此处需要数值', child.id);
    return value;
  }
  const value = block.fields?.[name] === undefined ? scriptNumberSlots[block.type]?.[name] ?? 0 : fieldNumber(block, name);
  return { kind: 'number', value };
}

function condition(parent: ScriptBlock, scope: CompileScope, input = 'CONDITION'): ScriptCondition {
  const block = parent.inputs?.[input]?.block;
  if (!block) {
    const flag = fieldText(parent, 'BOOL_' + input);
    if (flag === 'TRUE' || flag === 'FALSE') return { blockId: parent.id + '/' + input, kind: 'truth', operand: { kind: 'boolean', value: flag === 'TRUE' } };
  }
  if (!block || !enabled(block)) throw new ScriptBlockError('请连接一个启用的条件积木', parent.id);
  return conditionBlock(block, scope);
}

function conditionBlock(block: ScriptBlock, scope: CompileScope): ScriptCondition {
  const blockId = block.id;
  switch (block.type) {
    case scriptBlocks.and:
    case scriptBlocks.or:
      return { blockId, kind: block.type === scriptBlocks.and ? 'and' : 'or', left: condition(block, scope, 'A'), right: condition(block, scope, 'B') };
    case scriptBlocks.not:
      return { blockId, kind: 'not', operand: condition(block, scope) };
    case scriptBlocks.boolean:
    case scriptBlocks.timerRunning:
    case scriptBlocks.pointValue:
    case scriptBlocks.parameter:
    case scriptBlocks.callValue:
    case scriptBlocks.variable:
      return { blockId, kind: 'truth', operand: reporter(block, scope) };
    case scriptBlocks.error: {
      const code = scriptErrors.find(([, key]) => key === fieldText(block, 'CODE'))?.[1];
      if (!code) throw new ScriptBlockError('请选择错误类型', blockId);
      return { blockId, kind: 'error', code };
    }
    case scriptBlocks.state: {
      const slaveId = fieldText(block, 'SLAVE');
      const state = scriptStates.find(([, value]) => value === fieldText(block, 'STATE'))?.[1];
      if (!slaveId || !state) throw new ScriptBlockError('请选择从站和通信状态', block.id);
      return { blockId, kind: 'state', slaveId, state };
    }
    case scriptBlocks.compare:
    case scriptBlocks.compareValues:
    case scriptBlocks.compareVariable: {
      const relation = scriptRelations.find(([, value]) => value === fieldText(block, 'OP'))?.[1];
      if (!relation) throw new ScriptBlockError('请选择比较方式', block.id);
      if (block.type === scriptBlocks.compareValues) return { blockId, kind: 'compareValues', relation, left: slotOperand(block, 'A', scope), right: slotOperand(block, 'B', scope) };
      const ref = pointRef(block);
      return { blockId, kind: 'compare', ref, relation, operand: block.type === scriptBlocks.compare
        ? operand(block, scope) : { kind: 'variable', name: variableName(block) } };
    }
    case scriptBlocks.range: {
      const min = fieldNumber(block, 'MIN');
      const max = fieldNumber(block, 'MAX');
      if (min > max) throw new ScriptBlockError('区间下限应小于或等于上限', block.id);
      return { blockId, kind: 'range', ref: pointRef(block), min, max };
    }
    default: throw new ScriptBlockError('此积木不能用作条件', block.id);
  }
}

function stack(first: ScriptBlock | undefined, scope: CompileScope, depth = 0, inLoop = false): { steps: ScriptStep[]; count: number } {
  const steps: ScriptStep[] = [];
  let count = 0;
  for (let block = first; block; block = block.next?.block) {
    if (!enabled(block)) continue;
    if (depth > 8) throw new ScriptBlockError('循环和分支最多嵌套 8 层', block.id);
    const blockId = block.id;
    const outerCallCost = scope.callCost;
    scope.callCost = 0;
    const timeout = () => integer(block!, 'TIMEOUT', 50, MAX_SCRIPT_MS);
    count++;
    switch (block.type) {
      case scriptBlocks.runPeriod: steps.push({ blockId, kind: 'runPeriod', period: eventPeriod(block, scope) }); break;
      case scriptBlocks.runControl: {
        const mode = block.fields?.MODE === undefined ? 'start' : fieldText(block, 'MODE');
        if (mode !== 'start' && mode !== 'stop') throw new ScriptBlockError('请选择周期回调的启停状态', blockId);
        steps.push({ blockId, kind: 'runControl', enabled: mode === 'start' }); break;
      }
      case scriptBlocks.timerStart: {
        const mode = block.fields?.MODE === undefined ? 'once' : fieldText(block, 'MODE');
        if (!['once', 'count', 'loop'].includes(mode)) throw new ScriptBlockError('请选择定时器次数', blockId);
        const count = mode === 'loop' ? 0 : mode === 'once' ? 1 : block.fields?.COUNT === undefined ? 3 : integer(block, 'COUNT', 1, Number.MAX_SAFE_INTEGER);
        steps.push({ blockId, kind: 'timerStart', channel: timerChannel(block), period: eventPeriod(block, scope), count }); break;
      }
      case scriptBlocks.timerStop: steps.push({ blockId, kind: 'timerStop', channel: timerChannel(block) }); break;
      case scriptBlocks.call: steps.push({ blockId, kind: 'call', ...callOperands(block, scope) }); break;
      case scriptBlocks.read: steps.push({ blockId, kind: 'read', ref: pointRef(block), timeoutMs: timeout() }); break;
      case scriptBlocks.readVariable:
        steps.push({ blockId, kind: 'capture', ref: pointRef(block), variable: variableName(block) });
        break;
      case scriptBlocks.setVariable:
      case scriptBlocks.changeVariable:
        steps.push({ blockId, kind: block.type === scriptBlocks.setVariable ? 'setVariable' : 'changeVariable',
          variable: variableName(block), operand: slotOperand(block, 'OPERAND', scope) });
        break;
      case scriptBlocks.write: steps.push({ blockId, kind: 'write', ref: pointRef(block), operand: operand(block, scope) }); break;
      case scriptBlocks.log: {
        const message = fieldText(block, 'TEXT');
        const value = block.inputs?.OPERAND?.block;
        if (!message.trim() && !value) throw new ScriptBlockError('请输入日志文字或接入一个值', blockId);
        steps.push({ blockId, kind: 'log', message, ...(value ? { operand: reporter(value, scope) } : {}) });
        break;
      }
      case scriptBlocks.wait: steps.push({ blockId, kind: 'wait', condition: condition(block, scope), timeoutMs: timeout() }); break;
      case scriptBlocks.assert: steps.push({ blockId, kind: 'assert', condition: condition(block, scope) }); break;
      case scriptBlocks.delay: steps.push({ blockId, kind: 'delay', ms: integer(block, 'MS', 0, MAX_SCRIPT_MS) }); break;
      case scriptBlocks.stop: steps.push({ blockId, kind: 'stop' }); break;
      case scriptBlocks.breakLoop:
        if (!inLoop) throw new ScriptBlockError('请将「跳出循环」放在循环内', blockId);
        steps.push({ blockId, kind: 'break' });
        break;
      case scriptBlocks.forever:
      case scriptBlocks.repeatUntil:
      case scriptBlocks.repeat: {
        const times = block.type === scriptBlocks.repeat ? integer(block, 'COUNT', 1, scope.cooperative ? MAX_EVENT_ITERATIONS : 100) : 1;
        const body = stack(block.inputs?.BODY?.block, scope, depth + 1, true);
        if (!body.steps.length) throw new ScriptBlockError('循环内至少需要一个步骤', blockId);
        count += (scope.cooperative ? 1 : times) * body.count;
        if (block.type === scriptBlocks.repeatUntil) steps.push({blockId, kind:'repeatUntil', condition:condition(block, scope), steps:body.steps});
        else if (block.type === scriptBlocks.forever) steps.push({ blockId, kind: 'forever', steps: body.steps });
        else steps.push({ blockId, kind: 'repeat', count: times, steps: body.steps });
        break;
      }
      case scriptBlocks.attempt: {
        const body = stack(block.inputs?.BODY?.block, scope, depth + 1, inLoop);
        const handler = stack(block.inputs?.ERROR?.block, scope, depth + 1, inLoop);
        if (!body.steps.length) throw new ScriptBlockError('请连接要尝试执行的步骤', blockId);
        count += body.count + handler.count;
        steps.push({ blockId, kind: 'attempt', steps: body.steps, handler: handler.steps });
        break;
      }
      case scriptBlocks.branch: {
        const extra = block.extraState?.elseIfCount ?? 0;
        if (!Number.isInteger(extra) || extra < 0 || extra > MAX_SCRIPT_BLOCKS) throw new ScriptBlockError('分支数量无效', blockId);
        const no = stack(block.inputs?.NO?.block, scope, depth + 1, inLoop);
        let longest = no.count;
        const arms = [];
        for (let i = 0; i <= extra; i++) {
          const body = stack(block.inputs?.[i ? 'YES' + i : 'YES']?.block, scope, depth + 1, inLoop);
          longest = Math.max(longest, body.count);
          arms.push({ condition: condition(block, scope, i ? 'COND' + i : 'CONDITION'), steps: body.steps });
        }
        if (!longest) throw new ScriptBlockError('分支内至少需要一个步骤', blockId);
        count += longest;
        steps.push({ blockId, kind: 'branch', arms, no: no.steps });
        break;
      }
      default: throw new ScriptBlockError('此积木不能作为执行步骤', blockId);
    }
    count += scope.callCost;
    scope.callCost = outerCallCost;
    if (count > MAX_SCRIPT_STEPS) throw new ScriptBlockError(`展开后最多执行 ${MAX_SCRIPT_STEPS} 个步骤`, blockId);
  }
  return { steps, count };
}

export function compileScriptProgram(graph: ScriptGraph): ScriptProgram {
  const roots = (graph.blocks?.blocks ?? []).filter(enabled);
  const stacks = roots.filter(block => !isScriptDefinition(block.type));
  const start = stacks.find(block => block.type === scriptBlocks.start);
  const events = stacks.filter(block => block.type === scriptBlocks.onRun || block.type === scriptBlocks.onTimer);
  if (!start && !events.length) throw new ScriptBlockError('请添加一个「开始」积木或事件入口');
  const stray = stacks.find(block => block !== start && !events.includes(block));
  if (stray) throw new ScriptBlockError('请将步骤接到同一个「开始」积木或对应事件入口下，函数定义可单独放置', stray.id);
  const headers = new Map<string, FunctionSignature>();
  const definitions = new Map<string, ScriptBlock>();
  const names = new Set<string>();
  for (const block of roots.filter(root => isScriptDefinition(root.type))) {
    const name = fieldText(block, 'NAME').trim();
    if (!name || name.length > 120) throw new ScriptBlockError('请输入 1–120 个字符的函数名', block.id);
    if (names.has(name)) throw new ScriptBlockError(`函数名「${name}」重复`, block.id);
    names.add(name);
    const parameters = splitParameters(fieldText(block, 'PARAMS'));
    if (parameters.length > MAX_SCRIPT_BLOCKS || parameters.some(p => !p || p.length > 120) || new Set(parameters).size !== parameters.length)
      throw new ScriptBlockError('参数名须非空、互不重复，并用逗号分隔', block.id);
    const returnsValue = block.type === scriptBlocks.calculation;
    if (Object.keys(block.inputs ?? {}).some(key => key !== (returnsValue ? 'RESULT' : 'BODY')))
      throw new ScriptBlockError('函数的输入与定义类型不匹配', block.id);
    headers.set(block.id, { id: block.id, name, parameters, returnsValue });
    definitions.set(block.id, block);
  }
  const compiled = new Map<string, { fn: ScriptFunction; cost: number }>();
  const visiting = new Set<string>();
  const cooperative = events.length > 0;
  const scopeFor = (parameters: string[]): CompileScope => ({ functions: headers, parameters, callCost: 0, include, cooperative });
  function include(id: string, caller: string): number {
    const cached = compiled.get(id);
    if (cached) return cached.cost;
    const block = definitions.get(id)!;
    const header = headers.get(id)!;
    if (visiting.has(id)) throw new ScriptBlockError(`函数「${header.name}」存在递归调用`, caller);
    visiting.add(id);
    const scope = scopeFor(header.parameters);
    let fn: ScriptFunction;
    let cost: number;
    if (header.returnsValue) {
      fn = { ...header, kind: 'calculation', result: slotOperand(block, 'RESULT', scope) };
      cost = 1 + scope.callCost;
    } else {
      const body = stack(block.inputs?.BODY?.block, scope);
      if (!body.steps.length) throw new ScriptBlockError('请在流程函数内连接执行步骤', block.id);
      fn = { ...header, kind: 'procedure', steps: body.steps };
      cost = body.count;
    }
    if (cost > MAX_SCRIPT_STEPS) throw new ScriptBlockError(`展开后最多执行 ${MAX_SCRIPT_STEPS} 个步骤`, caller);
    visiting.delete(id);
    compiled.set(id, { fn, cost });
    return cost;
  }
  const { steps } = stack(start?.next?.block, scopeFor([]));
  const handlers: ScriptHandlers<ScriptStep> = { timers: [] };
  const seen = new Set<string>();
  for (const root of events) {
    const cycle = root.type === scriptBlocks.onRun;
    const channel = cycle ? -1 : timerChannel(root);
    const key = cycle ? 'on_run' : `T${channel}`;
    if (seen.has(key)) throw new ScriptBlockError(`${key} 只能有一个启用的入口`, root.id);
    seen.add(key);
    const body = stack(root.next?.block, scopeFor([])).steps;
    if (cycle) {
      const periodMs = root.fields?.PERIOD === undefined ? DEFAULT_RUN_PERIOD : integer(root, 'PERIOD', MIN_EVENT_PERIOD, MAX_SCRIPT_MS);
      if (body.length) handlers.onRun = { blockId: root.id, periodMs, steps: body };
    } else if (body.length) handlers.timers.push({ blockId: root.id, channel, steps: body });
  }
  if (!steps.length && !handlers.onRun && !handlers.timers.length)
    throw new ScriptBlockError('请在「开始」积木或事件入口下连接至少一个步骤', start?.id ?? events[0]?.id);
  handlers.timers.sort((a, b) => a.channel - b.channel);
  const functions = [...definitions.keys()].sort().map(id => { include(id, id); return compiled.get(id)!.fn; });
  const usesClock = handlers.onRun || handlers.timers.length || [...scriptGraphBlocks(graph)].some(block => enabled(block) && clockBlocks.has(block.type));
  return { steps, functions, ...(usesClock ? { handlers } : {}) };
}

export function compileMasterScript(graph: ScriptGraph): ScriptStep[] {
  return compileScriptProgram(graph).steps;
}

export function newScriptGraph(id: string): ScriptGraph {
  return { blocks: { languageVersion: 0, blocks: [
    { type: scriptBlocks.start, id, x: 30, y: 30 },
    { type: scriptBlocks.onRun, id: id.slice(0, 230) + '-on-run', fields: { PERIOD: DEFAULT_RUN_PERIOD }, x: 420, y: 30 },
  ] } };
}

export function* scriptGraphBlocks(graph: ScriptGraph): Generator<ScriptBlock> {
  const stack = [...(graph.blocks?.blocks ?? [])].reverse();
  while (stack.length) {
    const block = stack.pop()!;
    yield block;
    if (block.next) stack.push(block.next.block);
    for (const input of Object.values(block.inputs ?? {}).reverse()) if (input.block) stack.push(input.block);
  }
}

export interface ScriptVariableGroup {
  functionId: string | null;
  label: string;
  names: Map<string, string>;
}

const variableBlockTypes = new Set<string>([scriptBlocks.variable, scriptBlocks.setVariable, scriptBlocks.changeVariable,
  scriptBlocks.readVariable, scriptBlocks.compareVariable]);
export function usesScriptVariable(type: string): boolean { return variableBlockTypes.has(type); }

export function scriptVariableGroups(graph: ScriptGraph): ScriptVariableGroup[] {
  const main: ScriptVariableGroup = { functionId: null, label: '主流程', names: new Map() };
  const groups = [main];
  const collect = (first: ScriptBlock, group: ScriptVariableGroup) => {
    for (let block: ScriptBlock | undefined = first; block; block = block.next?.block) {
      if (!enabled(block)) continue;
      const name = usesScriptVariable(block.type) ? fieldText(block, 'VARIABLE').trim() : '';
      if (name && !group.names.has(name)) group.names.set(name, block.id);
      for (const input of Object.values(block.inputs ?? {})) if (input.block) collect(input.block, group);
    }
  };
  for (const root of graph.blocks?.blocks ?? []) {
    if (!enabled(root)) continue;
    if (root.type === scriptBlocks.onRun || root.type === scriptBlocks.onTimer) main.label = '脚本共享';
    if (isScriptDefinition(root.type)) {
      const group: ScriptVariableGroup = { functionId: root.id, label: fieldText(root, 'NAME').trim() || '未命名函数', names: new Map() };
      for (const name of splitParameters(fieldText(root, 'PARAMS'))) if (name) group.names.set(name, root.id);
      collect(root, group);
      groups.push(group);
    } else collect(root, main);
  }
  return groups.filter(group => group.names.size);
}

const statementTypes = new Set<string>([scriptBlocks.read, scriptBlocks.readVariable, scriptBlocks.write, scriptBlocks.log,
  scriptBlocks.runPeriod, scriptBlocks.runControl, scriptBlocks.timerStart, scriptBlocks.timerStop,
  scriptBlocks.setVariable, scriptBlocks.changeVariable,
  scriptBlocks.call,
  scriptBlocks.wait, scriptBlocks.assert, scriptBlocks.delay, scriptBlocks.repeat, scriptBlocks.forever,
  scriptBlocks.repeatUntil, scriptBlocks.stop, scriptBlocks.breakLoop, scriptBlocks.attempt, scriptBlocks.branch]);

export function isScriptStatement(type: string): boolean { return statementTypes.has(type); }

export function withScriptBreakpoints(graph: ScriptGraph, ids: readonly string[]): ScriptGraph {
  const { breakpoints: _old, ...rest } = graph;
  if (!ids.length) return rest;
  const requested = new Set(ids);
  const breakpoints = [...scriptGraphBlocks(graph)].filter(block => requested.has(block.id) && isScriptStatement(block.type)).map(block => block.id);
  return breakpoints.length ? { ...rest, breakpoints } : rest;
}
