import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as yieldToIO, setTimeout as delay } from 'node:timers/promises';
import { compileScriptProgram, scriptArithmetic, scriptErrors, scriptPointKey, scriptRelations, scriptStates, type FunctionSignature, type MasterScript, type ScriptCondition, type ScriptErrorKind, type ScriptOperand, type ScriptPointRef, type ScriptStep } from '../../domain/master-script';
import { pointWriteFields, type PointWriteFields } from '../../domain/point-write-value';
import type { RawType } from '../../domain/mapping';
import type { ReadRange } from '../../domain/point-access';
import type { PointWriteResult } from '../../shared/contracts';
import type { ScriptApprovalView, ScriptJudgment, ScriptRunEntry, ScriptRunView } from '../../shared/script-run';
import type { SlaveCommunicationState } from '../../shared/snapshot';
import { RuntimeNotifications, type RuntimeChange } from './runtime-notifications';

type Value = string | boolean | number;
interface Sample { value?: Value; detail: string; sampledAtMs?: number }
interface OperandSource { label: string; fields?: PointWriteFields; read(run: ActiveRun): Sample }

export interface ScriptPointBinding {
  ref: ScriptPointRef;
  blockKey: string;
  span: ReadRange;
  label: string;
  type: RawType;
  highRisk: boolean;
  identity: string;
  read(): Sample;
  validateWrite(fields: PointWriteFields): void;
}

interface ScriptHost {
  point(ref: ScriptPointRef, access: 'read' | 'write'): ScriptPointBinding;
  slave(id: string): { label: string; state(): SlaveCommunicationState };
  write(ref: ScriptPointRef, fields: PointWriteFields, signal: AbortSignal): Promise<PointWriteResult>;
}

interface ActiveRun {
  controller: AbortController;
  variables: Map<string, Sample>;
  scopes: Map<string | null, { variables: Map<string, Sample>; inCall: boolean }>;
  variablesDirty: boolean;
  judgments: Map<string, ScriptJudgment>;
  judgmentsDirty: boolean;
  failure?: StepFailure;
  approve?: () => void;
  breakpoints: Set<string>;
  pauseNext?: PauseReason;
  resume?: (mode: 'continue' | 'step') => void;
  finished: Promise<void>;
}

interface Outcome {
  detail: string;
  log?: boolean;
  body?: { steps: PlannedStep[] } & ({ mode: 'sequence' } | { mode: 'call'; functionId: string; variables: Map<string, Sample> }
    | { mode: 'loop'; count: number; until?: (run: ActiveRun) => ConditionReading } | { mode: 'attempt'; handler: PlannedStep[] });
  control?: 'stop' | 'break';
}
interface PlannedStep {
  blockId: string;
  label: string;
  execute(run: ActiveRun): Promise<Outcome> | Outcome;
  prepareWrite?(run: ActiveRun): PreparedWrite;
}
type PauseReason = NonNullable<ScriptRunView['pause']>['reason'];
interface PreparedWrite { preview: string; send(): Promise<Outcome> }

export interface ScriptPlan {
  script: MasterScript;
  steps: PlannedStep[];
  programHash: string;
  statementIds: string[];
  approval: ScriptApprovalView | null;
}

const LOG_LIMIT = 250;
const messageOf = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason);
export class StepFailure extends Error {
  constructor(message: string, readonly kinds: ScriptErrorKind[]) { super(message); }
}
class BreakLoop extends Error {}

function enterFunction(run: ActiveRun, functionId: string, variables: Map<string, Sample>) {
  const caller = run.variables;
  const scope = { variables, inCall: true };
  run.variables = variables;
  run.scopes.set(functionId, scope);
  run.variablesDirty = true;
  return () => {
    scope.inCall = false;
    run.variables = caller;
    run.variablesDirty = true;
  };
}

function relationMatches(actual: Value, relation: Extract<ScriptCondition, { kind: 'compare' }>['relation'], wanted: Value): boolean {
  if (relation === 'eq') return actual === wanted;
  if (relation === 'ne') return actual !== wanted;
  if (typeof actual !== 'number' || typeof wanted !== 'number') return false;
  switch (relation) {
    case 'gt': return actual > wanted;
    case 'ge': return actual >= wanted;
    case 'lt': return actual < wanted;
    case 'le': return actual <= wanted;
  }
}

function outcomeDetail(result: PointWriteResult): string {
  const code = result.exceptionCode === null ? '' : ` · 0x${result.exceptionCode.toString(16).toUpperCase().padStart(2, '0')}`;
  const label = result.phase === 'not-sent' ? '预读失败，写入未发送' : result.phase === 'rejected' ? '设备拒绝写入' : '写入结果未知';
  const reason = result.result === 'timeout' ? ' · 应答超时' : result.result === 'transport' ? ' · 传输异常' : '';
  return `${label}${code}${reason}`;
}

interface ConditionReading { matched?: boolean; detail: string; samples?: ScriptJudgment['samples'] }
function recordJudgment(run: ActiveRun, blockId: string, reading: ConditionReading): void {
  run.judgments.set(blockId, { matched: reading.matched ?? null, detail: reading.detail.slice(0, 800),
    evaluatedAtMs: Date.now(), samples: reading.samples ?? [] });
  run.judgmentsDirty = true;
}
function sampleTime(label: string, sample: Sample): ScriptJudgment['samples'] {
  return sample.sampledAtMs === undefined ? [] : [{ label, timeMs: sample.sampledAtMs }];
}

const valueType = (type: RawType) => type === 'Bool' ? 'boolean' : type === 'String' ? 'string' : 'number';

function calculate(operator: Extract<ScriptOperand, { kind: 'arithmetic' }>['operator'], left: Value, right: Value): Sample {
  if (typeof left !== 'number' || typeof right !== 'number' || !Number.isFinite(left) || !Number.isFinite(right)) throw new Error('运算需要两个有限数值');
  let value: number;
  switch (operator) {
    case 'add': value = left + right; break;
    case 'subtract': value = left - right; break;
    case 'multiply': value = left * right; break;
    case 'divide':
      if (right === 0) throw new Error('除数不能为零');
      value = left / right;
      break;
  }
  if (!Number.isFinite(value)) throw new Error('运算结果超出有限数值范围');
  return { value, detail: String(value) };
}

function sampleSource(point: ScriptPointBinding): RuntimeChange {
  return { kind: 'sample', blockKey: point.blockKey, range: point.span };
}

function waitUntil(notifications: RuntimeNotifications, sources: RuntimeChange[], signal: AbortSignal, timeoutMs: number,
  observe: (change?: RuntimeChange) => ConditionReading): Promise<Outcome> {
  const deadline = performance.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const unsubscribe = notifications.subscribe(sources, check);
    const timer = setTimeout(() => check(undefined, true), timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener('abort', abort);
    }
    function abort() {
      cleanup();
      reject(signal.reason);
    }
    function check(change?: RuntimeChange, expired = false) {
      try {
        signal.throwIfAborted();
        const timedOut = expired || performance.now() >= deadline;
        const reading = observe(timedOut ? undefined : change);
        if (timedOut) throw new StepFailure(`等待超时 · ${reading.detail}`, ['timeout']);
        if (!reading.matched) return;
        cleanup();
        resolve({ detail: reading.detail });
      } catch (error) {
        cleanup();
        reject(error);
      }
    }
    signal.addEventListener('abort', abort, { once: true });
    check();
  });
}

export class MasterScriptRunner {
  private active: ActiveRun | null = null;
  private view: ScriptRunView | null = null;
  get snapshot(): ScriptRunView | null {
    this.flushObservations();
    return this.view;
  }

  constructor(private readonly host: ScriptHost, private readonly notifications: RuntimeNotifications) {}

  prepare(script: MasterScript): ScriptPlan {
    const program = compileScriptProgram(script.graph);
    const functions = new Map(program.functions.map(fn => [fn.id, fn]));
    const calculations = new Map<string, { result: OperandSource; sources: RuntimeChange[] }>();
    const procedures = new Map<string, PlannedStep[]>();
    const reads = new Map<string, ScriptPointBinding>();
    const highRiskWrites: ScriptApprovalView['writes'] = [];
    const approvals: string[] = [];

    const readPoint = (ref: ScriptPointRef) => {
      const key = scriptPointKey(ref);
      const existing = reads.get(key);
      if (existing) return existing;
      const point = this.host.point(ref, 'read');
      reads.set(key, point);
      return point;
    };
    const argumentsFor = (fn: FunctionSignature, args: ScriptOperand[], sources?: RuntimeChange[]) => {
      const inputs = args.map((arg, index) => resolveOperand(arg, undefined, fn.parameters[index]!, sources));
      return (run: ActiveRun) => new Map(fn.parameters.map((name, i) => [name, inputs[i]!.read(run)]));
    };
    const resolveOperand = (source: ScriptOperand, type: RawType | undefined, target: string, sources?: RuntimeChange[]): OperandSource => {
      if (source.kind === 'callValue') {
        const fn = functions.get(source.functionId);
        if (fn?.kind !== 'calculation') throw new Error('找不到计算函数');
        const frame = argumentsFor(fn, source.args, sources);
        let plan = calculations.get(fn.id);
        if (!plan) {
          const dependencies: RuntimeChange[] = [];
          plan = { result: resolveOperand(fn.result, undefined, fn.name, dependencies), sources: dependencies };
          calculations.set(fn.id, plan);
        }
        sources?.push(...plan.sources);
        const result = plan.result;
        return { label: `${fn.name}()`, read: run => {
          const locals = frame(run);
          for (const [name, sample] of locals) if (sample.value === undefined) return { detail: `${fn.name} · ${name} · ${sample.detail}` };
          const leave = enterFunction(run, fn.id, locals);
          try {
            const sample = result.read(run);
            if (type && sample.value !== undefined && typeof sample.value !== valueType(type)) throw new Error(`函数「${fn.name}」返回值与${target}的类型不一致`);
            return sample;
          } finally { leave(); }
        } };
      }
      if (source.kind === 'arithmetic') {
        if (type && valueType(type) !== 'number') throw new Error(`${target} 与数值运算的值类型不一致`);
        const left = resolveOperand(source.left, 'Float64', '运算左项', sources);
        const right = resolveOperand(source.right, 'Float64', '运算右项', sources);
        const symbol = scriptArithmetic.find(([, key]) => key === source.operator)![0];
        return { label: `（${left.label} ${symbol} ${right.label}）`, read: run => {
          const a = left.read(run);
          if (a.value === undefined) return a;
          const b = right.read(run);
          return b.value === undefined ? b : calculate(source.operator, a.value, b.value);
        } };
      }
      if (source.kind === 'condition') {
        if (type && type !== 'Bool') throw new Error(`${target} 需要匹配的值类型`);
        const condition = resolveCondition(source.condition, sources);
        return { label: condition.label, read: run => {
          const result = condition.read(run);
          return { value: result.matched, detail: result.detail };
        } };
      }
      if (source.kind === 'variable') {
        const label = `变量「${source.name}」`;
        return { label, read: run => {
          const sample = run.variables.get(source.name);
          if (!sample) throw new Error(`${label}尚未赋值`);
          if (type && typeof sample.value !== valueType(type)) throw new Error(`${label}与点位 ${target} 的值类型不一致`);
          return sample;
        } };
      }
      if (source.kind === 'point') {
        const point = readPoint(source.ref);
        if (type && valueType(point.type) !== valueType(type)) throw new Error(`${point.label} 与 ${target} 的值类型不一致`);
        sources?.push(sampleSource(point), { kind: 'slaveState', slaveId: point.ref.slaveId });
        return { label: point.label, read: () => point.read() };
      }
      const literal = source.kind === 'literal' ? source.text : source.value;
      const text = String(literal);
      if (!type) return { label: text, read: () => ({ value: literal, detail: text }) };
      if (source.kind === 'number' && valueType(type) !== 'number') throw new Error(`${target} 与数值的值类型不一致`);
      if (source.kind === 'boolean' && type !== 'Bool') throw new Error(`${target} 需要匹配的值类型`);
      const fields = pointWriteFields(type, text);
      const value = fields.engineering ?? fields.boolValue ?? fields.stringValue!;
      const label = source.kind === 'boolean' ? (source.value ? '真' : '假') : text || '空字符串';
      return { label, fields, read: () => ({ value, detail: label }) };
    };
    type Predicate = { label: string; read(run: ActiveRun): ConditionReading };
    const resolveCondition = (condition: ScriptCondition, sources?: RuntimeChange[]): Predicate => {
      const predicate = buildCondition(condition, sources);
      return { label: predicate.label, read: run => {
        let result: ConditionReading;
        try { result = predicate.read(run); }
        catch (error) {
          recordJudgment(run, condition.blockId, { detail: messageOf(error) });
          throw error;
        }
        recordJudgment(run, condition.blockId, result);
        return result;
      } };
    };
    const buildCondition = (condition: ScriptCondition, sources?: RuntimeChange[]): Predicate => {
      if (condition.kind === 'truth') {
        const source = resolveOperand(condition.operand, 'Bool', '布尔条件', sources);
        return { label: source.label, read: run => {
          const sample = source.read(run);
          return { matched: typeof sample.value === 'boolean' ? sample.value : undefined,
            detail: condition.operand.kind === 'boolean' ? `固定条件为${sample.detail}` : `${source.label} · ${sample.detail}`,
            samples: sampleTime(source.label, sample) };
        } };
      }
      if (condition.kind === 'error') {
        const label = scriptErrors.find(([, code]) => code === condition.code)![0];
        return { label, read: run => {
          if (!run.failure) throw new Error('「本次错误」需要放在「出错时」执行');
          const matched = run.failure.kinds.includes(condition.code);
          return { matched, detail: `错误类型「${label}」${matched ? '匹配' : '不匹配'} · ${run.failure.message}` };
        } };
      }
      if (condition.kind === 'not') {
        const operand = resolveCondition(condition.operand, sources);
        return { label: '取反条件', read: run => {
          const result = operand.read(run);
          return { ...result, matched: result.matched === undefined ? undefined : !result.matched, detail: `非（${result.detail}）` };
        } };
      }
      if (condition.kind === 'and' || condition.kind === 'or') {
        const left = resolveCondition(condition.left, sources);
        const right = resolveCondition(condition.right, sources);
        const decisive = condition.kind === 'or';
        const label = decisive ? '或' : '与';
        return { label: `组合条件（${label}）`, read: run => {
          const first = left.read(run);
          if (first.matched === decisive) return first;
          const second = right.read(run);
          const matched = second.matched === decisive ? decisive
            : first.matched === undefined || second.matched === undefined ? undefined : !decisive;
          return { matched, detail: `（${first.detail}）${label}（${second.detail}）`, samples: [...(first.samples ?? []), ...(second.samples ?? [])] };
        } };
      }
      if (condition.kind === 'state') {
        const device = this.host.slave(condition.slaveId);
        sources?.push({ kind: 'slaveState', slaveId: condition.slaveId });
        const stateLabel = (state: SlaveCommunicationState) => scriptStates.find(([, code]) => code === state)?.[0] ?? state;
        const label = `${device.label} ${stateLabel(condition.state)}`;
        return { label, read: () => {
          const state = device.state();
          return { matched: state === condition.state, detail: `${device.label} 当前${stateLabel(state)}，预期${stateLabel(condition.state)}` };
        } };
      }
      if (condition.kind === 'compareValues') {
        const left = resolveOperand(condition.left, undefined, '比较左项', sources);
        const right = resolveOperand(condition.right, undefined, '比较右项', sources);
        const relation = scriptRelations.find(([, key]) => key === condition.relation)![0];
        return { label: `${left.label} ${relation} ${right.label}`, read: run => {
          const a = left.read(run);
          const b = right.read(run);
          const detail = `${a.detail} ${relation} ${b.detail}`;
          const samples = [...sampleTime(left.label, a), ...sampleTime(right.label, b)];
          if (a.value === undefined || b.value === undefined) return { detail, samples };
          if (typeof a.value !== typeof b.value) throw new Error('比较两侧的值类型不一致');
          if (condition.relation !== 'eq' && condition.relation !== 'ne' && typeof a.value !== 'number') throw new Error('大小比较需要两个数值');
          return { matched: relationMatches(a.value, condition.relation, b.value), detail, samples };
        } };
      }
      const point = readPoint(condition.ref);
      sources?.push(sampleSource(point), { kind: 'slaveState', slaveId: point.ref.slaveId });
      const numeric = point.type !== 'Bool' && point.type !== 'String';
      const reading = (sample: Sample, expected: string, test: (actual: Value) => boolean) => {
        if (sample.value === undefined) return { detail: `${point.label} · ${sample.detail}` };
        return { matched: test(sample.value), detail: `${point.label} 当前值 ${sample.detail}，预期${expected}`, samples: sampleTime(point.label, sample) };
      };
      if (condition.kind === 'range') {
        if (!numeric) throw new Error(`${point.label} 需要使用数值点位`);
        const expected = `在 ${condition.min}–${condition.max} 范围`;
        return { label: `${point.label} ${expected}`, read: () =>
          reading(point.read(), expected, actual => typeof actual === 'number' && actual >= condition.min && actual <= condition.max) };
      }
      if (!numeric && condition.relation !== 'eq' && condition.relation !== 'ne') throw new Error(`${point.label} 支持等于和不等于比较`);
      const relationLabel = scriptRelations.find(([, relation]) => relation === condition.relation)![0];
      const source = resolveOperand(condition.operand, point.type, point.label, sources);
      const expected = `${relationLabel}${source.fields ? ' ' : ''}${source.label}`;
      return { label: `${point.label} ${expected}`, read: run => {
        const rhs = source.read(run);
        const wanted = rhs.value;
        if (wanted === undefined) return { detail: `${source.label} · ${rhs.detail}` };
        const result = reading(point.read(), source.fields ? expected : `${expected}（${rhs.detail}）`,
          actual => relationMatches(actual, condition.relation, wanted));
        return { ...result, samples: [...(result.samples ?? []), ...sampleTime(source.label, rhs)] };
      } };
    };

    const statementIds: string[] = [];
    const planSteps = (steps: ScriptStep[]): PlannedStep[] => steps.map(step => {
      const blockId = step.blockId;
      statementIds.push(blockId);
      switch (step.kind) {
        case 'call': {
          const fn = functions.get(step.functionId);
          if (fn?.kind !== 'procedure') throw new Error('找不到流程函数');
          const argumentsAtCall = argumentsFor(fn, step.args);
          let body = procedures.get(fn.id);
          if (!body) { body = planSteps(fn.steps); procedures.set(fn.id, body); }
          const steps = body;
          return { blockId, label: `调用「${fn.name}」`, execute: run => {
            const variables = argumentsAtCall(run);
            for (const [name, sample] of variables) if (sample.value === undefined) throw new Error(`${fn.name} · ${name} · ${sample.detail}`);
            return { detail: fn.name, body: { mode: 'call', functionId: fn.id, variables, steps } };
          } };
        }
        case 'read': {
          const point = readPoint(step.ref);
          return { blockId, label: `等待新采样 ${point.label}`, execute: run =>
            waitUntil(this.notifications, [sampleSource(point)], run.controller.signal, step.timeoutMs, change => {
              const sample = point.read();
              if (sample.value === undefined) return { detail: sample.detail };
              return change ? { matched: true, detail: sample.detail } : { detail: '等待点位的新确认值' };
            }) };
        }
        case 'capture': {
          const point = readPoint(step.ref);
          return { blockId, label: `读取 ${point.label} 到变量「${step.variable}」`, execute: run => {
            const sample = point.read();
            const { value, detail } = sample;
            if (value === undefined) throw new Error(`${point.label} · ${detail}`);
            run.variables.set(step.variable, sample);
            run.variablesDirty = true;
            return { detail: `变量「${step.variable}」 = ${detail}` };
          } };
        }
        case 'setVariable':
        case 'changeVariable': {
          const increment = step.kind === 'changeVariable';
          const label = `变量「${step.variable}」`;
          const operand = resolveOperand(step.operand, increment ? 'Float64' : undefined, label);
          return { blockId, label: `${increment ? '递增' : '设置'}${label}`, execute: run => {
            let sample = operand.read(run);
            if (sample.value === undefined) throw new Error(`${operand.label} · ${sample.detail}`);
            if (increment) {
              const current = run.variables.get(step.variable);
              if (current?.value === undefined) throw new Error(`${label}尚未赋值`);
              sample = calculate('add', current.value, sample.value);
            }
            run.variables.set(step.variable, sample);
            run.variablesDirty = true;
            return { detail: `${label} = ${sample.detail}` };
          } };
        }
        case 'log': {
          const source = step.operand && resolveOperand(step.operand, undefined, '记录日志');
          return { blockId, label: '记录日志', execute: run => {
            let value = '';
            if (source) {
              try {
                const sample = source.read(run);
                value = sample.value === '' ? '""' : String(sample.value ?? sample.detail);
              }
              catch (error) { value = messageOf(error); }
            }
            return { detail: [step.message, value].filter(Boolean).join(' '), log: true };
          } };
        }
        case 'write': {
          const point = this.host.point(step.ref, 'write');
          const source = resolveOperand(step.operand, point.type, point.label);
          if (source.fields) point.validateWrite(source.fields);
          if (point.highRisk) {
            highRiskWrites.push({ target: point.label, value: source.fields ? source.label : `${source.label}（运行时确认实际值）` });
            approvals.push(JSON.stringify([step.blockId, point.identity, step.operand]));
          }
          const prepareWrite = (run: ActiveRun): PreparedWrite => {
            let fields: PointWriteFields;
            let actual: string;
            try {
              const sample = source.read(run);
              if (sample.value === undefined) throw new Error(`${source.label} · ${sample.detail}`);
              actual = String(sample.value);
              fields = source.fields ?? pointWriteFields(point.type, actual);
              point.validateWrite(fields);
            } catch (error) { throw new StepFailure(messageOf(error), ['not-sent', 'evaluation']); }
            const preview = point.type === 'String' ? JSON.stringify(actual) : actual;
            return { preview, send: async () => {
              run.controller.signal.throwIfAborted();
              if (point.highRisk && !source.fields) await this.approveValue(run, point.label, preview);
              run.controller.signal.throwIfAborted();
              let result: PointWriteResult;
              try { result = await this.host.write(step.ref, fields, run.controller.signal); }
              catch (error) {
                if (error instanceof StepFailure || run.controller.signal.aborted) throw error;
                throw new StepFailure(messageOf(error), ['unknown']);
              }
              if (result.phase !== 'confirmed') {
                const kinds: ScriptErrorKind[] = [result.phase];
                if (result.result === 'timeout') kinds.push('timeout');
                throw new StepFailure(outcomeDetail(result), kinds);
              }
              return { detail: `写入应答成功 · ${source.fields ? source.label : actual}` };
            } };
          };
          return { blockId, label: `写入 ${point.label}`, prepareWrite, execute: run => prepareWrite(run).send() };
        }
        case 'delay':
          return { blockId, label: '延时', execute: async run => {
            await delay(step.ms, undefined, { signal: run.controller.signal });
            return { detail: `${step.ms} ms` };
          } };
        case 'repeat':
        case 'repeatUntil':
        case 'forever': {
          const planned = planSteps(step.steps);
          const count = step.kind === 'repeat' ? step.count : Infinity;
          const until = step.kind === 'repeatUntil' ? resolveCondition(step.condition) : undefined;
          const label = until ? '重复直到' : step.kind === 'forever' ? '主循环' : '循环';
          return { blockId, label, execute: () => ({ detail: until?.label ?? (count === Infinity ? '持续执行' : `执行 ${count} 次`),
            body: { mode: 'loop', steps: planned, count, until: until?.read } }) };
        }
        case 'stop': return { blockId, label: '停止流程', execute: () => ({ detail: '流程主动停止', control: 'stop' }) };
        case 'break': return { blockId, label: '跳出循环', execute: () => ({ detail: '跳出当前循环', control: 'break' }) };
        case 'attempt': {
          const body = planSteps(step.steps);
          const handler = planSteps(step.handler);
          return { blockId, label: '尝试执行', execute: () => ({ detail: '进入执行区', body: { mode: 'attempt', steps: body, handler } }) };
        }
        case 'wait': {
          const sources: RuntimeChange[] = [];
          const condition = resolveCondition(step.condition, sources);
          return { blockId, label: `等待 ${condition.label}`, execute: run =>
            waitUntil(this.notifications, sources, run.controller.signal, step.timeoutMs, () => condition.read(run)) };
        }
        case 'assert': {
          const condition = resolveCondition(step.condition);
          return { blockId, label: `断言 ${condition.label}`, execute: run => {
            const result = condition.read(run);
            if (result.matched === undefined) throw new Error(`条件暂不可判定 · ${result.detail}`);
            if (!result.matched) throw new Error(result.detail);
            return { detail: result.detail };
          } };
        }
        case 'branch': {
          const arms = step.arms.map(arm => ({ condition: resolveCondition(arm.condition), steps: planSteps(arm.steps) }));
          const otherwise = planSteps(step.no);
          return { blockId, label: '判断', execute: run => {
            let detail = '';
            for (const [index, arm] of arms.entries()) {
              const result = arm.condition.read(run);
              const label = index ? `否则如果 ${index}` : '如果';
              detail = `${label} · ${result.detail}`;
              recordJudgment(run, blockId, { ...result, detail });
              if (result.matched === undefined) throw new Error(`条件暂不可判定 · ${detail}`);
              if (result.matched) return { detail, body: { mode: 'sequence', steps: arm.steps } };
            }
            return { detail, body: { mode: 'sequence', steps: otherwise } };
          } };
        }
      }
    });

    const steps = planSteps(program.steps);
    const programHash = createHash('sha256').update(JSON.stringify(program)).digest('hex');
    const approval = approvals.length ? {
      writes: highRiskWrites.filter((entry, index) => highRiskWrites.findIndex(other => other.target === entry.target && other.value === entry.value) === index),
      key: createHash('sha256').update(JSON.stringify([script.id, script.revision, approvals])).digest('hex'),
    } : null;
    return { script, steps, programHash, statementIds, approval };
  }

  start(plan: ScriptPlan, approval?: string, debug = false): ScriptRunView {
    if (this.active) throw new Error('已有主站脚本正在运行');
    if (plan.approval && plan.approval.key !== approval) throw new Error('请核对并确认高风险写入');
    const view: ScriptRunView = {
      id: randomUUID(), scriptId: plan.script.id, scriptName: plan.script.name, state: 'running',
      scriptRevision: plan.script.revision, programHash: plan.programHash, pendingWrite: null, judgments: {}, variableScopes: [], pause: null,
      statementIds: plan.statementIds, breakpoints: (plan.script.graph.breakpoints ?? []).filter(id => plan.statementIds.includes(id)),
      startedAtMs: Date.now(), finishedAtMs: null, current: null, entries: [], completed: 0, detail: null,
    };
    this.view = view;
    const variables = new Map<string, Sample>();
    const run: ActiveRun = {
      controller: new AbortController(), variables, scopes: new Map([[null, { variables, inCall: false }]]), variablesDirty: false,
      judgments: new Map(), judgmentsDirty: false,
      breakpoints: new Set(view.breakpoints), pauseNext: debug ? 'entry' : undefined,
      finished: Promise.resolve(),
    };
    this.active = run;
    run.finished = this.executeSteps(run, plan.steps)
      .then(() => this.finish(run.controller.signal.aborted ? 'stopped' : 'passed'))
      .catch(error => this.finish(run.controller.signal.aborted ? 'stopped' : 'failed', messageOf(error)));
    return this.snapshot!;
  }

  stop(id?: string): void {
    if (!this.active || !this.view || (id !== undefined && this.view.id !== id)) return;
    this.view = { ...this.view, state: 'stopping' };
    this.active.controller.abort(new Error('流程已停止'));
  }

  pause(id: string): boolean {
    if (!this.active || this.view?.id !== id || this.view.state !== 'running') return false;
    this.active.pauseNext = 'pause';
    this.view = { ...this.view, state: 'pausing' };
    return true;
  }

  resume(id: string, token: string, mode: 'continue' | 'step'): boolean {
    if (this.view?.id !== id || this.view.pause?.token !== token || !this.active?.resume) return false;
    this.active.resume(mode);
    return true;
  }

  setBreakpoint(id: string, blockId: string, enabled: boolean): boolean {
    const run = this.active;
    if (!run || this.view?.id !== id || run.controller.signal.aborted || !this.view.statementIds.includes(blockId)) return false;
    if (enabled) run.breakpoints.add(blockId);
    else run.breakpoints.delete(blockId);
    this.view = { ...this.view, breakpoints: [...run.breakpoints] };
    return true;
  }

  private waitForDebugger(run: ActiveRun, step: PlannedStep, reason: PauseReason, writePreview?: string, writeError?: string): Promise<void> {
    const signal = run.controller.signal;
    signal.throwIfAborted();
    run.pauseNext = undefined;
    const variables = Array.from(run.variables, ([name, sample]) => ({ name, value: String(sample.value ?? sample.detail) }));
    this.view = { ...this.view!, state: 'paused', current: { blockId: step.blockId, label: step.label },
      pause: { reason, token: randomUUID(), writePreview, writeError, variables } };
    return new Promise((resolve, reject) => {
      const clear = () => {
        signal.removeEventListener('abort', abort);
        delete run.resume;
      };
      function abort() { clear(); reject(signal.reason); }
      run.resume = mode => {
        clear();
        if (mode === 'step') run.pauseNext = 'step';
        this.view = { ...this.view!, state: 'running', pause: null };
        resolve();
      };
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  async settle(): Promise<void> {
    await this.active?.finished;
  }

  private flushObservations(): void {
    const run = this.active;
    if (!run || !this.view || !(run.judgmentsDirty || run.variablesDirty)) return;
    const next = { ...this.view };
    if (run.judgmentsDirty) next.judgments = Object.fromEntries(run.judgments);
    if (run.variablesDirty) next.variableScopes = Array.from(run.scopes, ([functionId, scope]) => ({
      functionId, inCall: scope.inCall,
      values: Array.from(scope.variables, ([name, sample]) => ({ name, value: sample.value! })),
    }));
    this.view = next;
    run.judgmentsDirty = run.variablesDirty = false;
  }

  private approveValue(run: ActiveRun, target: string, value: string): Promise<void> {
    const signal = run.controller.signal;
    signal.throwIfAborted();
    this.view = { ...this.view!, pendingWrite: { token: randomUUID(), target, value } };
    return new Promise((resolve, reject) => {
      const clear = () => {
        signal.removeEventListener('abort', abort);
        delete run.approve;
        this.view = { ...this.view!, pendingWrite: null };
      };
      function abort() { clear(); reject(signal.reason); }
      run.approve = () => { clear(); resolve(); };
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  confirmWrite(runId: string, token: string): boolean {
    if (this.view?.id !== runId || this.view.pendingWrite?.token !== token || !this.active?.approve) return false;
    this.active.approve();
    return true;
  }

  private finish(state: 'passed' | 'failed' | 'stopped', detail?: string): void {
    this.flushObservations();
    this.view = { ...this.view!, state, detail: state === 'stopped' ? '流程已停止' : detail ?? null, current: null, pause: null, finishedAtMs: Date.now() };
    this.active = null;
  }

  private record(step: PlannedStep, result: ScriptRunEntry['result'], detail: string, log?: boolean): void {
    const view = this.view!;
    const row = { blockId: step.blockId, label: step.label, result, detail: detail.length > 800 ? detail.slice(0, 799) + '…' : detail,
      atMs: Date.now(), ...(log ? { log } : {}) };
    this.view = { ...view, completed: view.completed + 1, entries: [...view.entries, row].slice(-LOG_LIMIT) };
  }

  private async executeSteps(run: ActiveRun, steps: PlannedStep[]): Promise<void> {
    for (const step of steps) {
      run.controller.signal.throwIfAborted();
      this.view = { ...this.view!, current: { blockId: step.blockId, label: step.label } };
      let outcome: Outcome;
      try {
        let prepared: PreparedWrite | undefined;
        const reason = run.pauseNext ?? (run.breakpoints.has(step.blockId) ? 'breakpoint' : undefined);
        if (reason) {
          let preparationError: StepFailure | undefined;
          try { prepared = step.prepareWrite?.(run); }
          catch (error) { preparationError = new StepFailure(messageOf(error), ['not-sent', 'evaluation']); }
          await this.waitForDebugger(run, step, reason, prepared?.preview, preparationError?.message);
          run.controller.signal.throwIfAborted();
          if (preparationError) throw preparationError;
        }
        outcome = await (prepared ? prepared.send() : step.execute(run));
      } catch (error) {
        this.record(step, run.controller.signal.aborted ? 'stopped' : 'failed', messageOf(error));
        throw error;
      }
      this.record(step, outcome.control === 'stop' ? 'stopped' : 'ok', outcome.detail, outcome.log);
      if (outcome.control === 'stop') { this.stop(); run.controller.signal.throwIfAborted(); }
      if (outcome.control === 'break') throw new BreakLoop();
      if (outcome.body) await this.executeBody(run, outcome.body, step);
    }
  }

  private async executeBody(run: ActiveRun, body: NonNullable<Outcome['body']>, owner: PlannedStep): Promise<void> {
    if (body.mode === 'sequence') return this.executeSteps(run, body.steps);
    if (body.mode === 'call') {
      const leave = enterFunction(run, body.functionId, body.variables);
      try { await this.executeSteps(run, body.steps); } finally { leave(); }
      return;
    }
    if (body.mode === 'loop') {
      try {
        for (let i = 0; i < body.count; i++) {
          if (i > 0) {
            const reason = run.pauseNext ?? (run.breakpoints.has(owner.blockId) ? 'breakpoint' : undefined);
            if (reason) await this.waitForDebugger(run, owner, reason);
            run.controller.signal.throwIfAborted();
          }
          if (body.until) {
            try {
              const result = body.until(run);
              recordJudgment(run, owner.blockId, result);
              if (result.matched === undefined) throw new Error(`条件暂不可判定 · ${result.detail}`);
              if (result.matched) break;
            } catch (error) { this.record(owner, 'failed', messageOf(error)); throw error; }
          }
          await this.executeSteps(run, body.steps);
          if (body.count === Infinity) await yieldToIO(undefined, { signal: run.controller.signal });
        }
      } catch (error) { if (!(error instanceof BreakLoop)) throw error; }
      return;
    }
    try {
      await this.executeSteps(run, body.steps);
    } catch (error) {
      if (run.controller.signal.aborted || error instanceof BreakLoop || !body.handler?.length) throw error;
      const previous = run.failure;
      run.failure = error instanceof StepFailure ? error : new StepFailure(messageOf(error), ['evaluation']);
      const entries = this.view!.entries.slice();
      const index = entries.length - 1;
      if (entries[index]?.result === 'failed') entries[index] = { ...entries[index]!, handled: true };
      this.view = { ...this.view!, entries };
      try { await this.executeSteps(run, body.handler); } finally { run.failure = previous; }
    }
  }
}
