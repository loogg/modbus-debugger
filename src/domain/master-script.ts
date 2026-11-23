import { z } from 'zod';
import type { SlaveCommunicationState } from '../shared/snapshot';

export const scriptBlocks = {
  start: 'mb_start',
  read: 'mb_read',
  readVariable: 'mb_read_var',
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
export const scriptStates = [['在线', 'online'], ['离线', 'offline'], ['待确认', 'pending'], ['连接中', 'connecting'], ['停用', 'disabled']] as const;
export const scriptErrors = [['等待超时', 'timeout'], ['写入未发送', 'not-sent'], ['设备拒绝写入', 'rejected'], ['写入结果未知', 'unknown'], ['判断或数据错误', 'evaluation']] as const;
export type ScriptErrorKind = typeof scriptErrors[number][1];
export const MAX_SCRIPT_BLOCKS = 200;
export const MAX_SCRIPT_STEPS = 1000;
export const MAX_SCRIPT_MS = 120000;

type ScriptBlockKind = typeof scriptBlocks[keyof typeof scriptBlocks];
type FieldValue = string | number | boolean;
type Relation = typeof scriptRelations[number][1];
const id = z.string().min(1).max(250);
const field = z.union([z.string().max(4000), z.number().finite(), z.boolean()]);
const blockHeaderSchema = z.object({
  type: z.custom<ScriptBlockKind>(value => typeof value === 'string' && Object.values(scriptBlocks).some(kind => kind === value)),
  id,
  fields: z.record(field).optional(),
  extraState: z.object({ elseIfCount: z.number().int().min(0).max(MAX_SCRIPT_BLOCKS), hasElse: z.boolean() }).strict().optional(),
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
  extraState?: { elseIfCount: number; hasElse: boolean };
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
      if (block.data.type !== scriptBlocks.branch) return false;
      branchInputs += block.data.extraState.elseIfCount;
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
    if ((block.data.type === scriptBlocks.stop || block.data.type === scriptBlocks.breakLoop) && block.data.next) return false;
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
export type ScriptOperand =
  | { kind: 'literal'; text: string }
  | { kind: 'variable'; name: string }
  | { kind: 'point'; ref: ScriptPointRef }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'condition'; condition: ScriptCondition };
export type ScriptCondition = { blockId: string } & (
  | { kind: 'truth'; operand: ScriptOperand }
  | { kind: 'error'; code: ScriptErrorKind }
  | { kind: 'state'; slaveId: string; state: SlaveCommunicationState }
  | { kind: 'compare'; ref: ScriptPointRef; relation: Relation; operand: ScriptOperand }
  | { kind: 'and'; left: ScriptCondition; right: ScriptCondition }
  | { kind: 'or'; left: ScriptCondition; right: ScriptCondition }
  | { kind: 'not'; operand: ScriptCondition }
  | { kind: 'range'; ref: ScriptPointRef; min: number; max: number });
export type ScriptStep = { blockId: string } & (
  | { kind: 'read'; ref: ScriptPointRef; timeoutMs: number }
  | { kind: 'capture'; ref: ScriptPointRef; variable: string }
  | { kind: 'write'; ref: ScriptPointRef; operand: ScriptOperand }
  | { kind: 'log'; message: string; operand?: ScriptOperand }
  | { kind: 'wait'; condition: ScriptCondition; timeoutMs: number }
  | { kind: 'assert'; condition: ScriptCondition }
  | { kind: 'delay'; ms: number }
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

function variableName(block: ScriptBlock): string {
  const name = fieldText(block, 'VARIABLE').trim();
  if (!name || name.length > 120) throw new ScriptBlockError('请输入 1–120 个字符的变量名', block.id);
  return name;
}

function reporter(block: ScriptBlock): ScriptOperand {
  if (!enabled(block)) throw new ScriptBlockError('请启用或移除停用的值积木', block.id);
  if (block.type === scriptBlocks.variable) return { kind: 'variable', name: variableName(block) };
  if (block.type === scriptBlocks.pointValue) return { kind: 'point', ref: pointRef(block) };
  if (block.type === scriptBlocks.boolean) {
    const value = fieldText(block, 'BOOL');
    if (value === 'TRUE' || value === 'FALSE') return { kind: 'boolean', value: value === 'TRUE' };
    throw new ScriptBlockError('请选择真或假', block.id);
  }
  if ([scriptBlocks.compare, scriptBlocks.compareVariable, scriptBlocks.range, scriptBlocks.state, scriptBlocks.error,
    scriptBlocks.and, scriptBlocks.or, scriptBlocks.not].some(type => type === block.type)) {
    return { kind: 'condition', condition: conditionBlock(block) };
  }
  throw new ScriptBlockError('请选择点位值、运行变量或布尔值', block.id);
}

function operand(block: ScriptBlock): ScriptOperand {
  const connected = block.inputs?.OPERAND?.block;
  return connected ? reporter(connected) : { kind: 'literal', text: fieldText(block, 'VALUE') };
}

function condition(parent: ScriptBlock, input = 'CONDITION'): ScriptCondition {
  const block = parent.inputs?.[input]?.block;
  if (!block) {
    const flag = fieldText(parent, 'BOOL_' + input);
    if (flag === 'TRUE' || flag === 'FALSE') return { blockId: parent.id + '/' + input, kind: 'truth', operand: { kind: 'boolean', value: flag === 'TRUE' } };
  }
  if (!block || !enabled(block)) throw new ScriptBlockError('请连接一个启用的条件积木', parent.id);
  return conditionBlock(block);
}

function conditionBlock(block: ScriptBlock): ScriptCondition {
  const blockId = block.id;
  switch (block.type) {
    case scriptBlocks.and:
    case scriptBlocks.or:
      return { blockId, kind: block.type === scriptBlocks.and ? 'and' : 'or', left: condition(block, 'A'), right: condition(block, 'B') };
    case scriptBlocks.not:
      return { blockId, kind: 'not', operand: condition(block) };
    case scriptBlocks.boolean:
    case scriptBlocks.pointValue:
    case scriptBlocks.variable:
      return { blockId, kind: 'truth', operand: reporter(block) };
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
    case scriptBlocks.compareVariable: {
      const relation = scriptRelations.find(([, value]) => value === fieldText(block, 'OP'))?.[1];
      if (!relation) throw new ScriptBlockError('请选择比较方式', block.id);
      const ref = pointRef(block);
      return { blockId, kind: 'compare', ref, relation, operand: block.type === scriptBlocks.compare
        ? operand(block) : { kind: 'variable', name: variableName(block) } };
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

function stack(first: ScriptBlock | undefined, depth: number, inLoop = false): { steps: ScriptStep[]; count: number } {
  const steps: ScriptStep[] = [];
  let count = 0;
  for (let block = first; block; block = block.next?.block) {
    if (!enabled(block)) continue;
    if (depth > 8) throw new ScriptBlockError('循环和分支最多嵌套 8 层', block.id);
    const blockId = block.id;
    const timeout = () => integer(block!, 'TIMEOUT', 50, MAX_SCRIPT_MS);
    count++;
    switch (block.type) {
      case scriptBlocks.read: steps.push({ blockId, kind: 'read', ref: pointRef(block), timeoutMs: timeout() }); break;
      case scriptBlocks.readVariable:
        steps.push({ blockId, kind: 'capture', ref: pointRef(block), variable: variableName(block) });
        break;
      case scriptBlocks.write: steps.push({ blockId, kind: 'write', ref: pointRef(block), operand: operand(block) }); break;
      case scriptBlocks.log: {
        const message = fieldText(block, 'TEXT');
        const value = block.inputs?.OPERAND?.block;
        if (!message.trim() && !value) throw new ScriptBlockError('请输入日志文字或接入一个值', blockId);
        steps.push({ blockId, kind: 'log', message, ...(value ? { operand: reporter(value) } : {}) });
        break;
      }
      case scriptBlocks.wait: steps.push({ blockId, kind: 'wait', condition: condition(block), timeoutMs: timeout() }); break;
      case scriptBlocks.assert: steps.push({ blockId, kind: 'assert', condition: condition(block) }); break;
      case scriptBlocks.delay: steps.push({ blockId, kind: 'delay', ms: integer(block, 'MS', 0, MAX_SCRIPT_MS) }); break;
      case scriptBlocks.stop: steps.push({ blockId, kind: 'stop' }); break;
      case scriptBlocks.breakLoop:
        if (!inLoop) throw new ScriptBlockError('请将「跳出循环」放在循环内', blockId);
        steps.push({ blockId, kind: 'break' });
        break;
      case scriptBlocks.forever:
      case scriptBlocks.repeatUntil:
      case scriptBlocks.repeat: {
        const times = block.type === scriptBlocks.repeat ? integer(block, 'COUNT', 1, 100) : 1;
        const body = stack(block.inputs?.BODY?.block, depth + 1, true);
        if (!body.steps.length) throw new ScriptBlockError('循环内至少需要一个步骤', blockId);
        count += times * body.count;
        if (block.type === scriptBlocks.repeatUntil) steps.push({blockId, kind:'repeatUntil', condition:condition(block), steps:body.steps});
        else if (block.type === scriptBlocks.forever) steps.push({ blockId, kind: 'forever', steps: body.steps });
        else steps.push({ blockId, kind: 'repeat', count: times, steps: body.steps });
        break;
      }
      case scriptBlocks.attempt: {
        const body = stack(block.inputs?.BODY?.block, depth + 1, inLoop);
        const handler = stack(block.inputs?.ERROR?.block, depth + 1, inLoop);
        if (!body.steps.length) throw new ScriptBlockError('请连接要尝试执行的步骤', blockId);
        count += body.count + handler.count;
        steps.push({ blockId, kind: 'attempt', steps: body.steps, handler: handler.steps });
        break;
      }
      case scriptBlocks.branch: {
        const extra = block.extraState?.elseIfCount ?? 0;
        if (!Number.isInteger(extra) || extra < 0 || extra > MAX_SCRIPT_BLOCKS) throw new ScriptBlockError('分支数量无效', blockId);
        const no = stack(block.inputs?.NO?.block, depth + 1, inLoop);
        let longest = no.count;
        const arms = [];
        for (let i = 0; i <= extra; i++) {
          const body = stack(block.inputs?.[i ? 'YES' + i : 'YES']?.block, depth + 1, inLoop);
          longest = Math.max(longest, body.count);
          arms.push({ condition: condition(block, i ? 'COND' + i : 'CONDITION'), steps: body.steps });
        }
        if (!longest) throw new ScriptBlockError('分支内至少需要一个步骤', blockId);
        count += longest;
        steps.push({ blockId, kind: 'branch', arms, no: no.steps });
        break;
      }
      default: throw new ScriptBlockError('此积木不能作为执行步骤', blockId);
    }
    if (count > MAX_SCRIPT_STEPS) throw new ScriptBlockError(`展开后最多执行 ${MAX_SCRIPT_STEPS} 个步骤`, blockId);
  }
  return { steps, count };
}

export function compileMasterScript(graph: ScriptGraph): ScriptStep[] {
  const roots = (graph.blocks?.blocks ?? []).filter(enabled);
  const start = roots.find(block => block.type === scriptBlocks.start);
  if (!start) throw new ScriptBlockError('请添加一个「开始」积木');
  if (roots.length !== 1) throw new ScriptBlockError('请将步骤接到同一个「开始」积木下', roots.find(block => block !== start)?.id);
  const { steps } = stack(start.next?.block, 0);
  if (!steps.length) throw new ScriptBlockError('请在「开始」积木下连接至少一个步骤', start.id);
  return steps;
}

export function newScriptGraph(id: string): ScriptGraph {
  return { blocks: { languageVersion: 0, blocks: [{ type: scriptBlocks.start, id, x: 30, y: 30 }] } };
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

const statementTypes = new Set<string>([scriptBlocks.read, scriptBlocks.readVariable, scriptBlocks.write, scriptBlocks.log,
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
