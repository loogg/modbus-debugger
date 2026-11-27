import { createHash, randomUUID } from 'node:crypto';
import { eventKey, type CanvasEventBinding, type ScriptInputEvent, type SignalValue } from '../../domain/canvas-script';
import { observePoint, type ObserveEquipment } from './script-equipment-events';
import type { CanvasSignals } from './canvas-signals';
import { SCRIPT_SLICE_MS, ScriptHandleFault, ScriptLuaHandle } from './script-lua-handle';
import { clearImmediate, setImmediate } from 'node:timers';
import { checkWorkspaceAssignments, scriptArithmetic, scriptErrors, scriptPointKey, scriptRelations, scriptStates, type FunctionSignature, type MasterScript, type ScriptCondition, type ScriptErrorKind, type ScriptHandlers, type ScriptOperand, type ScriptPointRef, type ScriptStep } from '../../domain/master-script';
import { compileScriptLua } from '../../domain/script-lua-program';
import { pointWriteFields, type PointWriteFields } from '../../domain/point-write-value';
import { displayLuaScalar, lowerLuaExpression, luaNumericLiteral, type LuaScalar, type ScriptLuaKernel } from '../../domain/script-lua-operators';
import type { RawType } from '../../domain/mapping';
import type { ReadRange } from '../../domain/point-access';
import type { PointWriteResult } from '../../shared/contracts';
import type { ScriptApprovalView, ScriptEventSource, ScriptJudgment, ScriptRunEntry, ScriptRunView } from '../../shared/script-run';
import { checkedPeriod, ScriptEventClock } from './script-event-clock';
import type { SlaveCommunicationState } from '../../shared/snapshot';
import { RuntimeNotifications, type RuntimeChange } from './runtime-notifications';

type Value = LuaScalar;
interface Sample { value?: Value; detail: string; sampledAtMs?: number }
class UnavailableInput { constructor(readonly sample: Sample) {} }
interface OperandSource { label: string; fields?: PointWriteFields; read(task: TaskContext): Sample }

export interface ScriptPointBinding {
  ref: ScriptPointRef;
  blockKey: string;
  span: ReadRange;
  label: string;
  type: RawType;
  highRisk: boolean;
  identity: string;
  read(): Omit<Sample, 'value'> & { value?: SignalValue };
  validateWrite(fields: PointWriteFields): void;
}

interface ScriptHost {
  signals?: Pick<CanvasSignals, 'definition' | 'read' | 'write'>;
  checkInput?(binding: CanvasEventBinding): void;
  point(ref: ScriptPointRef, access: 'read' | 'write'): ScriptPointBinding;
  slave(id: string): { label: string; state(): SlaveCommunicationState };
  write(ref: ScriptPointRef, fields: PointWriteFields, signal: AbortSignal): Promise<PointWriteResult>;
}

interface TaskContext {
  session: ActiveRun;
  source: ScriptEventSource;
  input?: ScriptInputEvent;
  variables: Map<string, Sample>;
  failure?: StepFailure;
  failedEntry?: ScriptRunEntry;
}

type Instruction = { step: PlannedStep; loopBoundary?: boolean } | { slice: true };
type Flow = Generator<Instruction, void, Outcome | undefined>;
interface ScriptTask {
  context: TaskContext;
  flow: Flow;
  advance(): void;
  current?: PlannedStep;
  remainingMs: number;
}
interface ActiveRun {
  lua: ScriptLuaHandle;
  groups: PlannedStep[][];
  groupIds: Record<string, number>;
  mainOwner?: ScriptTask;
  controller: AbortController;
  sharedVariables: Map<string, Sample>;
  scopes: Map<string | null, { functionId: string | null; source?: ScriptEventSource; variables: Map<string, Sample>; inCall: boolean }>;
  variablesDirty: boolean;
  judgments: Map<string, ScriptJudgment>;
  judgmentsDirty: boolean;
  clock: ScriptEventClock;
  handlers?: ScriptHandlers<PlannedStep>;
  tasks: Map<ScriptEventSource, ScriptTask>;
  ready: ScriptTask[];
  inputs: Map<string, { blockId: string; steps: PlannedStep[] }>;
  pendingInputs: { event: ScriptInputEvent; blockId: string; steps: PlannedStep[] }[];
  detachEquipment: (() => void)[];
  inFlight: number;
  wake?: NodeJS.Timeout;
  turn?: NodeJS.Immediate;
  terminalError?: string;
  approve?: () => void;
  breakpoints: Set<string>;
  pauseNext?: PauseReason;
  stepOwner?: ScriptTask;
  pauseAtBoundary?: () => void;
  resume?: (mode: 'continue' | 'step') => void;
  finished: Promise<void>;
  resolveFinished(): void;
}

interface Outcome {
  detail: string;
  log?: boolean;
  body?: { steps: PlannedStep[] } & ({ mode: 'sequence'; choice: number } | { mode: 'call'; functionId: string; variables: Map<string, Sample> }
    | { mode: 'loop'; until?: (task: TaskContext) => ConditionReading } | { mode: 'attempt'; handler: PlannedStep[] });
  control?: 'stop';
}
interface PlannedStep {
  blockId: string;
  label: string;
  execute(task: TaskContext): Promise<Outcome> | Outcome;
  prepareWrite?(task: TaskContext): PreparedWrite;
}
type PauseReason = NonNullable<ScriptRunView['pause']>['reason'];
interface PreparedWrite { preview: string; send(): Promise<Outcome> }

export interface ScriptPlan {
  observeEquipment: ObserveEquipment[];
  script: MasterScript;
  lua: ScriptLuaKernel;
  steps: PlannedStep[];
  handlers?: ScriptHandlers<PlannedStep>;
  programHash: string;
  statementIds: string[];
  approval: ScriptApprovalView | null;
}

const LOG_LIMIT = 250;
const messageOf = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason);
export class StepFailure extends Error {
  constructor(message: string, readonly kinds: ScriptErrorKind[]) { super(message); }
}

function enterFunction(task: TaskContext, functionId: string, variables: Map<string, Sample>) {
  const caller = task.variables;
  const scope = { functionId, variables, inCall: true, ...(task.session.handlers ? { source: task.source } : {}) };
  task.variables = variables;
  task.session.scopes.set(task.source + '/' + functionId, scope);
  task.session.variablesDirty = true;
  return () => {
    scope.inCall = false;
    task.variables = caller;
    task.session.variablesDirty = true;
  };
}

function outcomeDetail(result: PointWriteResult): string {
  const code = result.exceptionCode === null ? '' : ` · 0x${result.exceptionCode.toString(16).toUpperCase().padStart(2, '0')}`;
  const label = result.phase === 'not-sent' ? '预读失败，写入未发送' : result.phase === 'rejected' ? '设备拒绝写入' : '写入结果未知';
  const reason = result.result === 'timeout' ? ' · 应答超时' : result.result === 'transport' ? ' · 传输异常' : '';
  return `${label}${code}${reason}`;
}

interface ConditionReading { matched?: boolean; detail: string; samples?: ScriptJudgment['samples'] }
function recordJudgment(task: TaskContext, blockId: string, reading: ConditionReading): void {
  task.session.judgments.set(blockId, { matched: reading.matched ?? null, detail: reading.detail.slice(0, 800),
    evaluatedAtMs: Date.now(), samples: reading.samples ?? [] });
  task.session.judgmentsDirty = true;
}
function sampleTime(label: string, sample: Sample): ScriptJudgment['samples'] {
  return sample.sampledAtMs === undefined ? [] : [{ label, timeMs: sample.sampledAtMs }];
}

const valueType = (type: RawType) => type === 'Bool' ? 'boolean' : type === 'String' ? 'string' : 'number';
const scalarType = (value: Value | undefined) => typeof value === 'bigint' ? 'number' : typeof value;

function sampleSource(point: ScriptPointBinding): RuntimeChange {
  return { kind: 'sample', blockKey: point.blockKey, range: point.span };
}

function waitUntil(notifications: RuntimeNotifications, sources: RuntimeChange[], signal: AbortSignal, timeoutMs: number,
  observe: (change?: RuntimeChange) => ConditionReading, clock?: ScriptEventClock): Promise<Outcome> {
  const deadline = performance.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const unsubscribe = notifications.subscribe(sources, check);
    const timer = setTimeout(() => check(undefined, true), timeoutMs);
    const clockWatch = clock?.watchElapsed(sources, check);
    function cleanup() {
      clearTimeout(timer);
      clockWatch?.close();
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
        if (change) clockWatch?.reset();
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

  prepare(script: MasterScript, artifact = compileScriptLua(script.graph)): ScriptPlan {
    const { program } = artifact;
    checkWorkspaceAssignments(program, id => this.host.signals?.definition(id).type);
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
      return (task: TaskContext) => new Map(fn.parameters.map((name, i) => [name, inputs[i]!.read(task)]));
    };
    const resolveOperand = (source: ScriptOperand, type: RawType | undefined, target: string, sources?: RuntimeChange[], threshold?: number): OperandSource => {
      if (source.kind === 'eventValue' || source.kind === 'previousEventValue') return { label: source.kind === 'eventValue' ? '本次事件值' : '上次事件值', read: task => {
        const value = source.kind === 'eventValue' ? task.input?.value : task.input?.previous;
        if (value === undefined) throw new Error('当前步骤没有对应的事件值');
        if (type && typeof value !== valueType(type)) throw new Error(`${target} 与事件值类型不匹配`);
        return { value, detail: String(value) };
      } };
      if (source.kind === 'workspaceValue') {
        const signals = this.host.signals;
        if (!signals) throw new Error('工作区变量不可用');
        const variable = signals.definition(source.variableId);
        if (type && valueType(type) !== variable.type) throw new Error(`工作区变量「${variable.name}」与${target}类型不匹配`);
        sources?.push({ kind: 'workspace', variableId: variable.id });
        return { label: variable.name, read: () => {
          const value = signals.read(variable.id);
          return { value, detail: String(value) };
        } };
      }
      if (source.kind === 'timerElapsed' || source.kind === 'timerRunning') {
        const elapsed = source.kind === 'timerElapsed';
        if (type && valueType(type) !== (elapsed ? 'number' : 'boolean')) throw new Error(`${target} 与定时器值的类型不一致`);
        const phases = elapsed && threshold !== undefined ? [0, Math.ceil(threshold), Math.floor(threshold) + 1] : undefined;
        sources?.push({ kind: 'timer', channel: source.channel, elapsed, phases });
        return { label: `T${source.channel}`, read: task => {
          const clock = task.session.clock;
          const value = elapsed ? clock.elapsed(source.channel) : clock.isRunning(source.channel);
          return { value, detail: String(value) };
        } };
      }
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
        return { label: `${fn.name}()`, read: task => {
          const locals = frame(task);
          for (const [name, sample] of locals) if (sample.value === undefined) return { detail: `${fn.name} · ${name} · ${sample.detail}` };
          const leave = enterFunction(task, fn.id, locals);
          try {
            const sample = result.read(task);
            if (type && sample.value !== undefined && scalarType(sample.value) !== valueType(type)) throw new Error(`函数「${fn.name}」返回值与${target}的类型不一致`);
            return sample;
          } finally { leave(); }
        } };
      }
      if (source.kind === 'arithmetic') {
        if (type && valueType(type) !== 'number') throw new Error(`${target} 与数值运算的值类型不一致`);
        const inputs: OperandSource[] = [];
        const label = lowerLuaExpression(source, leaf => {
          const binding = resolveOperand(leaf, undefined, '数值运算', sources);
          inputs.push(binding);
          return binding.label;
        }, (op, a, b) => `（${a} ${scriptArithmetic.find(([, key]) => key === op)![0]} ${b}）`);
        return { label, read: task => {
          try {
            const value = task.session.lua.evaluateExpression(source.expression, index => {
              const sample = inputs[index]!.read(task);
              if (sample.value === undefined) throw new UnavailableInput(sample);
              return sample.value;
            });
            return { value, detail: String(value) };
          } catch (reason) {
            if (reason instanceof UnavailableInput) return reason.sample;
            throw reason;
          }
        } };
      }
      if (source.kind === 'condition') {
        if (type && type !== 'Bool') throw new Error(`${target} 需要匹配的值类型`);
        const condition = resolveCondition(source.condition, sources);
        return { label: condition.label, read: task => {
          const result = condition.read(task);
          return { value: result.matched, detail: result.detail };
        } };
      }
      if (source.kind === 'variable') {
        sources?.push({ kind: 'variable', name: source.name });
        const label = `变量「${source.name}」`;
        return { label, read: task => {
          const sample = task.variables.get(source.name);
          if (!sample) throw new Error(`${label}尚未赋值`);
          if (type && scalarType(sample.value) !== valueType(type)) throw new Error(`${label}与点位 ${target} 的值类型不一致`);
          return sample;
        } };
      }
      if (source.kind === 'point') {
        const point = readPoint(source.ref);
        if (type && valueType(point.type) !== valueType(type)) throw new Error(`${point.label} 与 ${target} 的值类型不一致`);
        sources?.push(sampleSource(point), { kind: 'slaveState', slaveId: point.ref.slaveId });
        return { label: point.label, read: () => point.read() };
      }
      const literal = source.kind === 'literal' ? source.text : source.kind === 'number' ? luaNumericLiteral(source.integerText ?? String(source.value)) : source.value;
      const text = String(literal);
      if (!type) return { label: text, read: () => ({ value: literal, detail: text }) };
      if (source.kind === 'number' && valueType(type) !== 'number') throw new Error(`${target} 与数值的值类型不一致`);
      if (source.kind === 'boolean' && type !== 'Bool') throw new Error(`${target} 需要匹配的值类型`);
      const fields = pointWriteFields(type, text);
      const value = source.kind === 'number' ? literal : fields.engineering ?? fields.boolValue ?? fields.stringValue!;
      const label = source.kind === 'boolean' ? (source.value ? '真' : '假') : text || '空字符串';
      return { label, fields, read: () => ({ value, detail: label }) };
    };
    type Predicate = { label: string; read(task: TaskContext): ConditionReading };
    const resolveCondition = (condition: ScriptCondition, sources?: RuntimeChange[]): Predicate => {
      const predicate = buildCondition(condition, sources);
      return { label: predicate.label, read: task => {
        let result: ConditionReading;
        try { result = predicate.read(task); }
        catch (error) {
          recordJudgment(task, condition.blockId, { detail: messageOf(error) });
          throw error;
        }
        recordJudgment(task, condition.blockId, result);
        return result;
      } };
    };
    const buildCondition = (condition: ScriptCondition, sources?: RuntimeChange[]): Predicate => {
      if (condition.kind === 'truth') {
        const source = resolveOperand(condition.operand, undefined, '布尔条件', sources);
        return { label: source.label, read: task => {
          const sample = source.read(task);
          return { matched: sample.value === undefined ? undefined : task.session.lua.truth(sample.value),
            detail: condition.operand.kind === 'boolean' ? `固定条件为${sample.detail}` : `${source.label} · ${sample.detail}`,
            samples: sampleTime(source.label, sample) };
        } };
      }
      if (condition.kind === 'error') {
        const label = scriptErrors.find(([, code]) => code === condition.code)![0];
        return { label, read: task => {
          if (!task.failure) throw new Error('「本次错误」需要放在「出错时」执行');
          const matched = task.failure.kinds.includes(condition.code);
          return { matched, detail: `错误类型「${label}」${matched ? '匹配' : '不匹配'} · ${task.failure.message}` };
        } };
      }
      if (condition.kind === 'not') {
        const operand = resolveCondition(condition.operand, sources);
        return { label: '取反条件', read: task => {
          const result = operand.read(task);
          return { ...result, matched: result.matched === undefined ? undefined : !result.matched, detail: `非（${result.detail}）` };
        } };
      }
      if (condition.kind === 'and' || condition.kind === 'or') {
        const left = resolveCondition(condition.left, sources);
        const right = resolveCondition(condition.right, sources);
        const decisive = condition.kind === 'or';
        const label = decisive ? '或' : '与';
        return { label: `组合条件（${label}）`, read: task => {
          const first = left.read(task);
          if (first.matched === decisive) return first;
          const second = right.read(task);
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
        const left = resolveOperand(condition.left, undefined, '比较左项', sources, condition.right.kind === 'number' ? condition.right.value : undefined);
        const right = resolveOperand(condition.right, undefined, '比较右项', sources, condition.left.kind === 'number' ? condition.left.value : undefined);
        const relation = scriptRelations.find(([, key]) => key === condition.relation)![0];
        return { label: `${left.label} ${relation} ${right.label}`, read: task => {
          const a = left.read(task);
          const b = right.read(task);
          const detail = `${a.detail} ${relation} ${b.detail}`;
          const samples = [...sampleTime(left.label, a), ...sampleTime(right.label, b)];
          if (a.value === undefined || b.value === undefined) return { detail, samples };
          return { matched: task.session.lua.evaluate(condition.relation, a.value, b.value) === true, detail, samples };
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
      return { label: `${point.label} ${expected}`, read: task => {
        const rhs = source.read(task);
        const wanted = rhs.value;
        if (wanted === undefined) return { detail: `${source.label} · ${rhs.detail}` };
        const result = reading(point.read(), source.fields ? expected : `${expected}（${rhs.detail}）`,
          actual => task.session.lua.evaluate(condition.relation, actual, wanted) === true);
        return { ...result, samples: [...(result.samples ?? []), ...sampleTime(source.label, rhs)] };
      } };
    };

    const statementIds: string[] = [];
    const planSteps = (steps: ScriptStep[]): PlannedStep[] => steps.map(step => {
      const blockId = step.blockId;
      statementIds.push(blockId);
      switch (step.kind) {
        case 'runPeriod':
        case 'timerStart': {
          const period = resolveOperand(step.period, 'Float64', '事件周期');
          return { blockId, label: step.kind === 'runPeriod' ? '设置 on_run 周期' : `启动 T${step.channel}`, execute: task => {
            const sample = period.read(task);
            if (sample.value === undefined) throw new Error(sample.detail);
            const ms = checkedPeriod(typeof sample.value === 'bigint' ? Number(sample.value) : sample.value);
            if (step.kind === 'runPeriod') {
              this.dropUndispatched(task.session, 'on_run');
              task.session.clock.setPeriod(ms);
            } else {
              this.dropUndispatched(task.session, `T${step.channel}`);
              task.session.clock.startTimer(step.channel, ms, step.count);
              this.notifications.publish({ kind: 'timer', channel: step.channel });
            }
            this.updateEventStatus(task.session);
            return { detail: `${ms} ms` };
          } };
        }
        case 'setWorkspaceValue': {
          const signals = this.host.signals;
          if (!signals) throw new Error('工作区变量不可用');
          const variable = signals.definition(step.variableId);
          const operand = resolveOperand(step.operand, undefined, variable.name);
          return { blockId, label: `设置工作区变量「${variable.name}」`, execute: task => {
            const { value, detail } = operand.read(task);
            if (value === undefined) throw new Error(detail);
            signals.write(variable.id, value, task.input?.changes);
            return { detail: `${variable.name} = ${detail}` };
          } };
        }
        case 'runControl':
          return { blockId, label: '控制 on_run', execute: task => {
            this.dropUndispatched(task.session, 'on_run');
            task.session.clock.enableCycle(step.enabled);
            this.updateEventStatus(task.session);
            return { detail: task.session.handlers?.onRun ? step.enabled ? '已启用周期回调' : '已暂停周期回调' : 'on_run 没有启用的步骤' };
          } };
        case 'timerStop':
          return { blockId, label: `停止 T${step.channel}`, execute: task => {
            this.dropUndispatched(task.session, `T${step.channel}`);
            task.session.clock.stopTimer(step.channel);
            this.notifications.publish({ kind: 'timer', channel: step.channel });
            this.updateEventStatus(task.session);
            return { detail: `T${step.channel}` };
          } };
        case 'call': {
          const fn = functions.get(step.functionId);
          if (fn?.kind !== 'procedure') throw new Error('找不到流程函数');
          const argumentsAtCall = argumentsFor(fn, step.args);
          let body = procedures.get(fn.id);
          if (!body) { body = planSteps(fn.steps); procedures.set(fn.id, body); }
          const steps = body;
          return { blockId, label: `调用「${fn.name}」`, execute: task => {
            const variables = argumentsAtCall(task);
            for (const [name, sample] of variables) if (sample.value === undefined) throw new Error(`${fn.name} · ${name} · ${sample.detail}`);
            return { detail: fn.name, body: { mode: 'call', functionId: fn.id, variables, steps } };
          } };
        }
        case 'read': {
          const point = readPoint(step.ref);
          return { blockId, label: `等待新采样 ${point.label}`, execute: task =>
            waitUntil(this.notifications, [sampleSource(point)], task.session.controller.signal, step.timeoutMs, change => {
              const sample = point.read();
              if (sample.value === undefined) return { detail: sample.detail };
              return change ? { matched: true, detail: sample.detail } : { detail: '等待点位的新确认值' };
            }) };
        }
        case 'capture': {
          const point = readPoint(step.ref);
          return { blockId, label: `读取 ${point.label} 到变量「${step.variable}」`, execute: task => {
            const sample = point.read();
            const { value, detail } = sample;
            if (value === undefined) throw new Error(`${point.label} · ${detail}`);
            task.variables.set(step.variable, sample);
            task.session.variablesDirty = true;
            this.notifications.publish({ kind: 'variable', name: step.variable });
            return { detail: `变量「${step.variable}」 = ${detail}` };
          } };
        }
        case 'setVariable':
        case 'changeVariable': {
          const increment = step.kind === 'changeVariable';
          const label = `变量「${step.variable}」`;
          const operand = resolveOperand(step.operand, increment ? 'Float64' : undefined, label);
          return { blockId, label: `${increment ? '递增' : '设置'}${label}`, execute: task => {
            let sample = operand.read(task);
            if (sample.value === undefined) throw new Error(`${operand.label} · ${sample.detail}`);
            if (increment) {
              const current = task.variables.get(step.variable);
              if (current?.value === undefined) throw new Error(`${label}尚未赋值`);
              const value = task.session.lua.evaluate('add', current.value, sample.value);
              sample = { value, detail: String(value) };
            }
            task.variables.set(step.variable, sample);
            task.session.variablesDirty = true;
            this.notifications.publish({ kind: 'variable', name: step.variable });
            return { detail: `${label} = ${sample.detail}` };
          } };
        }
        case 'log': {
          const source = step.operand && resolveOperand(step.operand, undefined, '记录日志');
          return { blockId, label: '记录日志', execute: task => {
            const value = source ? task.session.lua.observe(() => {
              const sample = source.read(task);
              return sample.value ?? sample.detail;
            }) : '';
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
          const prepareWrite = (task: TaskContext): PreparedWrite => {
            let fields: PointWriteFields;
            let actual: string;
            try {
              const sample = source.read(task);
              if (sample.value === undefined) throw new Error(`${source.label} · ${sample.detail}`);
              actual = String(sample.value);
              if (typeof sample.value === 'bigint' && BigInt(Number(sample.value)) !== sample.value)
                throw new Error('整数无法由目标点位精确表示');
              fields = source.fields ?? pointWriteFields(point.type, actual);
              point.validateWrite(fields);
            } catch (error) { throw new StepFailure(messageOf(error), ['not-sent', 'evaluation']); }
            const preview = point.type === 'String' ? JSON.stringify(actual) : actual;
            return { preview, send: async () => {
              task.session.controller.signal.throwIfAborted();
              if (point.highRisk && !source.fields) await this.approveValue(task.session, point.label, preview);
              task.session.controller.signal.throwIfAborted();
              let result: PointWriteResult;
              try { result = await this.host.write(step.ref, fields, task.session.controller.signal); }
              catch (error) {
                if (error instanceof StepFailure || task.session.controller.signal.aborted) throw error;
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
          return { blockId, label: `写入 ${point.label}`, prepareWrite, execute: task => prepareWrite(task).send() };
        }
        case 'delay':
          return { blockId, label: '延时', execute: task => task.session.lua.sleep(task.source, step.ms, task.session.controller.signal)
            .then(() => ({ detail: `${step.ms} ms` })) };
        case 'repeat':
        case 'repeatUntil':
        case 'forever': {
          const planned = planSteps(step.steps);
          const count = step.kind === 'repeat' ? step.count : Infinity;
          const until = step.kind === 'repeatUntil' ? resolveCondition(step.condition) : undefined;
          const label = until ? '重复直到' : step.kind === 'forever' ? '主循环' : '循环';
          return { blockId, label, execute: () => ({ detail: until?.label ?? (count === Infinity ? '持续执行' : `执行 ${count} 次`),
            body: { mode: 'loop', steps: planned, until: until?.read } }) };
        }
        case 'stop': return { blockId, label: '停止流程', execute: () => ({ detail: '流程主动停止', control: 'stop' }) };
        case 'break': return { blockId, label: '跳出循环', execute: () => ({ detail: '跳出当前循环' }) };
        case 'attempt': {
          const body = planSteps(step.steps);
          const handler = planSteps(step.handler);
          return { blockId, label: '尝试执行', execute: () => ({ detail: '进入执行区', body: { mode: 'attempt', steps: body, handler } }) };
        }
        case 'wait': {
          const sources: RuntimeChange[] = [];
          const condition = resolveCondition(step.condition, sources);
          return { blockId, label: `等待 ${condition.label}`, execute: task =>
            waitUntil(this.notifications, sources, task.session.controller.signal, step.timeoutMs, () => condition.read(task), task.session.clock) };
        }
        case 'assert': {
          const condition = resolveCondition(step.condition);
          return { blockId, label: `断言 ${condition.label}`, execute: task => {
            const result = condition.read(task);
            if (result.matched === undefined) throw new Error(`条件暂不可判定 · ${result.detail}`);
            if (!result.matched) throw new Error(result.detail);
            return { detail: result.detail };
          } };
        }
        case 'branch': {
          const arms = step.arms.map(arm => ({ condition: resolveCondition(arm.condition), steps: planSteps(arm.steps) }));
          const otherwise = planSteps(step.no);
          return { blockId, label: '判断', execute: task => {
            let detail = '';
            for (const [index, arm] of arms.entries()) {
              const result = arm.condition.read(task);
              const label = index ? `否则如果 ${index}` : '如果';
              detail = `${label} · ${result.detail}`;
              recordJudgment(task, blockId, { ...result, detail });
              if (result.matched === undefined) throw new Error(`条件暂不可判定 · ${detail}`);
              if (result.matched) return { detail, body: { mode: 'sequence', steps: arm.steps, choice: index + 1 } };
            }
            return { detail, body: { mode: 'sequence', steps: otherwise, choice: arms.length + 1 } };
          } };
        }
      }
    });

    const steps = planSteps(program.steps);
    const observeEquipment: ObserveEquipment[] = [];
    const handlers = program.handlers && {
      onRun: program.handlers.onRun && { ...program.handlers.onRun, steps: planSteps(program.handlers.onRun.steps) },
      timers: program.handlers.timers.map(timer => ({ ...timer, steps: planSteps(timer.steps) })),
      inputs: program.handlers.inputs?.map(input => {
        const { binding } = input;
        if (binding.kind === 'point') {
          const point = readPoint(binding);
          observeEquipment.push(observePoint(binding, point, this.host.slave(binding.slaveId).state, this.notifications));
        } else {
          if (!this.host.checkInput) throw new Error('画布事件不可用');
          this.host.checkInput(binding);
        }
        return { ...input, steps: planSteps(input.steps) };
      }),
    };
    const programHash = createHash('sha256').update(artifact.identity).digest('hex');
    const approval = approvals.length ? {
      writes: highRiskWrites.filter((entry, index) => highRiskWrites.findIndex(other => other.target === entry.target && other.value === entry.value) === index),
      key: createHash('sha256').update(JSON.stringify([script.id, script.revision, approvals])).digest('hex'),
    } : null;
    return { script, lua: program.lua, steps, handlers, programHash, statementIds, approval, observeEquipment };
  }

  start(plan: ScriptPlan, approval?: string, debug = false): ScriptRunView {
    if (this.active) throw new Error('这张流程已经在运行');
    if (plan.approval && plan.approval.key !== approval) throw new Error('请核对并确认高风险写入');
    const clock = new ScriptEventClock(plan.handlers?.onRun?.periodMs);
    const lua = new ScriptLuaHandle(plan.lua, plan.script.callbackTimeoutMs, plan.script.id);
    const breakpoints = (plan.script.graph.breakpoints ?? []).filter(id => plan.statementIds.includes(id));
    this.view = {
      id: randomUUID(), scriptId: plan.script.id, scriptName: plan.script.name, state: 'running',
      scriptRevision: plan.script.revision, callbackTimeoutMs: lua.callbackTimeoutMs, programHash: plan.programHash, pendingWrite: null, judgments: {}, variableScopes: [], pause: null,
      statementIds: plan.statementIds, breakpoints, startedAtMs: Date.now(), finishedAtMs: null, current: null, entries: [], completed: 0, detail: null,
      ...(plan.handlers ? { events: { ...clock.snapshot(), inputs: plan.handlers.inputs?.map(i => i.binding) }, eventLog: [] } : {}),
    };
    const sharedVariables = new Map<string, Sample>();
    let resolveFinished!: () => void;
    const finished = new Promise<void>(resolve => { resolveFinished = resolve; });
    const run: ActiveRun = {
      controller: new AbortController(), lua, groups: [], groupIds: plan.lua.control.groups, sharedVariables, scopes: new Map([[null, { functionId: null, variables: sharedVariables, inCall: false }]]),
      variablesDirty: false, judgments: new Map(), judgmentsDirty: false, breakpoints: new Set(breakpoints),
      pauseNext: debug ? 'entry' : undefined, clock, handlers: plan.handlers, tasks: new Map(), ready: [],
      inputs: new Map(plan.handlers?.inputs?.map(input => [eventKey(input.binding), input])), pendingInputs: [], detachEquipment: [],
      inFlight: 0, finished, resolveFinished,
    };
    this.active = run;
    for (const observe of plan.observeEquipment) run.detachEquipment.push(observe(event => this.receive(event)));
    if (plan.steps.length) this.launch(run, 'on_start', plan.steps);
    this.pump(run, 1);
    return this.snapshot!;
  }

  receive(event: ScriptInputEvent): boolean {
    const run = this.active;
    if (!run || run.controller.signal.aborted) return false;
    const input = run.inputs.get(eventKey(event.binding));
    if (!input) return false;
    if (run.pendingInputs.length >= 256) {
      this.cancel(run, '待处理的输入事件超过 256 个');
      return false;
    }
    run.pendingInputs.push({ event, blockId: input.blockId, steps: input.steps });
    if (!run.turn && !run.resume && !run.approve) this.schedule(run, 0);
    return true;
  }

  recheckInputs() {
    const run = this.active;
    if (!run || run.controller.signal.aborted) return;
    try { for (const { binding } of run.handlers?.inputs ?? []) if (binding.kind === 'widget' || binding.kind === 'workspace') this.host.checkInput?.(binding); }
    catch (e) { this.cancel(run, messageOf(e)); }
  }

  stop(id?: string): void {
    if (this.active && (id === undefined || this.view?.id === id)) this.cancel(this.active);
  }

  private cancel(run: ActiveRun, failure?: string) {
    if (run.controller.signal.aborted) return;
    run.terminalError = failure;
    this.view = { ...this.view!, state: 'stopping', pause: null };
    run.resume = undefined;
    run.pauseAtBoundary = undefined;
    run.stepOwner = undefined;
    clearTimeout(run.wake);
    if (run.turn) clearImmediate(run.turn);
    run.controller.abort(new Error('流程已停止'));
    for (const detach of run.detachEquipment.splice(0)) detach();
    run.ready.length = 0;
    for (const task of run.tasks.values()) task.flow.return(undefined);
    run.tasks.clear();
    // A write already on the wire must settle before a new script can start.
    if (!run.inFlight) this.finish(run);
  }

  pause(id: string): boolean {
    const run = this.active;
    if (!run || this.view?.id !== id) return false;
    if (this.view.state === 'waiting') {
      this.suspend(run, 'pause', run.sharedVariables, () => {});
      return true;
    }
    if (this.view.state !== 'running') return false;
    run.pauseNext = 'pause';
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

  private suspend(run: ActiveRun, reason: PauseReason, locals: Map<string, Sample>, release: () => void,
    writePreview?: string, writeError?: string, owner?: ScriptTask) {
    clearTimeout(run.wake);
    run.clock.freeze();
    run.pauseNext = undefined;
    run.stepOwner = undefined;
    const variables = Array.from(locals, ([name, sample]) => ({ name, value: String(sample.value ?? sample.detail) }));
    this.view = { ...this.view!, state: 'paused', pause: { reason, token: randomUUID(), variables, writePreview, writeError } };
    run.resume = mode => {
      run.resume = undefined;
      run.clock.resume();
      run.pauseNext = mode === 'step' ? 'step' : undefined;
      run.stepOwner = mode === 'step' ? owner : undefined;
      this.view = { ...this.view!, state: 'running', pause: null };
      release();
      this.schedule(run, 0);
    };
  }

  async settle(): Promise<void> { await this.active?.finished; }

  private flushObservations(): void {
    const run = this.active;
    if (!run || !this.view || !(run.judgmentsDirty || run.variablesDirty)) return;
    const next = { ...this.view };
    if (run.judgmentsDirty) next.judgments = Object.fromEntries(run.judgments);
    if (run.variablesDirty) next.variableScopes = Array.from(run.scopes.values(), scope => ({
      functionId: scope.functionId, inCall: scope.inCall, ...(scope.source ? { source: scope.source } : {}),
      values: Array.from(scope.variables, ([name, sample]) => {
        const value = displayLuaScalar(sample.value!);
        return { name, value, ...(typeof sample.value === 'bigint' && typeof value === 'string' ? { kind: 'integer64' as const } : {}) };
      }),
    }));
    this.view = next;
    run.judgmentsDirty = run.variablesDirty = false;
  }

  private updateEventStatus(run: ActiveRun) {
    if (run.handlers) this.view = { ...this.view!, events: { ...run.clock.snapshot(), inputs: this.view?.events?.inputs } };
  }

  private approveValue(run: ActiveRun, target: string, value: string): Promise<void> {
    const signal = run.controller.signal;
    signal.throwIfAborted();
    run.clock.freeze();
    this.view = { ...this.view!, pendingWrite: { token: randomUUID(), target, value } };
    return new Promise((resolve, reject) => {
      const clear = () => {
        signal.removeEventListener('abort', abort);
        run.approve = undefined;
        run.clock.resume();
        this.view = { ...this.view!, pendingWrite: null };
      };
      function abort() { clear(); reject(signal.reason); }
      run.approve = () => { clear(); resolve(); this.schedule(run, 0); };
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  confirmWrite(runId: string, token: string): boolean {
    if (this.view?.id !== runId || this.view.pendingWrite?.token !== token || !this.active?.approve) return false;
    this.active.approve();
    return true;
  }

  private finish(run: ActiveRun) {
    for (const detach of run.detachEquipment.splice(0)) detach();
    clearTimeout(run.wake);
    if (run.turn) clearImmediate(run.turn);
    this.flushObservations();
    const state = run.terminalError !== undefined ? 'failed' : run.controller.signal.aborted ? 'stopped' : 'passed';
    run.clock.close();
    this.updateEventStatus(run);
    this.view = { ...this.view!, state, detail: run.terminalError ?? (state === 'stopped' ? '流程已停止' : null),
      current: null, pause: null, pendingWrite: null, finishedAtMs: Date.now() };
    this.active = null;
    run.lua.close();
    run.resolveFinished();
  }

  private record(task: TaskContext, step: PlannedStep, result: ScriptRunEntry['result'], detail: string, log?: boolean) {
    const view = this.view!;
    const row: ScriptRunEntry = { blockId: step.blockId, label: step.label, result, detail: detail.length > 800 ? detail.slice(0, 799) + '…' : detail,
      atMs: Date.now(), ...(task.session.handlers ? { source: task.source, sequence: view.completed + 1 } : {}),
      ...(task.input ? { trigger: { binding: task.input.binding, label: task.input.label,
        ...(task.input.previous !== undefined ? { transition: { previous: task.input.previous, value: task.input.value } } : {}) } } : {}), ...(log ? { log } : {}) };
    // Operator messages have a separate bounded history so a hot loop cannot displace a heartbeat.
    this.view = { ...view, completed: view.completed + 1, entries: [...view.entries, row].slice(-LOG_LIMIT),
      ...(view.eventLog && (log || result === 'failed') ? { eventLog: [...view.eventLog, row].slice(-64) } : {}) };
    if (result === 'failed') task.failedEntry = row;
  }

  private launch(run: ActiveRun, source: ScriptEventSource, steps: PlannedStep[], input?: ScriptInputEvent) {
    const context: TaskContext = { session: run, source, variables: run.sharedVariables, input };
    const task: ScriptTask = { context, remainingMs: run.lua.callbackTimeoutMs, flow: this.walk(context, steps), advance: () => this.advance(task) };
    run.tasks.set(source, task);
    run.ready.push(task);
  }

  private schedule(run: ActiveRun, ms: number) {
    clearTimeout(run.wake);
    if (run.turn) clearImmediate(run.turn);
    run.turn = undefined;
    run.wake = undefined;
    if (this.active !== run || run.resume || run.approve || run.controller.signal.aborted || !Number.isFinite(ms)) return;
    if (ms === 0) run.turn = setImmediate(() => { run.turn = undefined; this.pump(run); });
    else run.wake = setTimeout(() => this.pump(run), ms);
  }

  private dropUndispatched(run: ActiveRun, source: ScriptEventSource) {
    const task = run.tasks.get(source);
    if (!task || task.current) return;
    run.ready = run.ready.filter(item => item !== task);
    run.tasks.delete(source);
    task.flow.return(undefined);
  }

  private pump(run: ActiveRun, maxSteps = 64) {
    if (this.active !== run || run.controller.signal.aborted || run.resume || run.approve) return;
    const sliceEnd = performance.now() + SCRIPT_SLICE_MS;
    for (let n = 0; n < maxSteps; n++) {
      const input = run.pendingInputs[0];
      if (input && !run.tasks.has(`input:${input.blockId}`) && !run.mainOwner) {
        run.pendingInputs.shift();
        this.launch(run, `input:${input.blockId}`, input.steps, input.event);
      }
      if (run.pauseAtBoundary && !run.inFlight) {
        const pause = run.pauseAtBoundary;
        run.pauseAtBoundary = undefined;
        pause();
        return;
      }
      const due = run.clock.takeDue(run.tasks);
      for (const source of due) {
        if (source === 'on_run') this.launch(run, source, run.handlers!.onRun!.steps);
        else {
          const channel = Number(source.slice(1));
          const handler = run.handlers?.timers.find(timer => timer.channel === channel);
          if (handler) this.launch(run, source, handler.steps);
          this.notifications.publish({ kind: 'timer', channel });
        }
      }
      if (due.length) this.updateEventStatus(run);
      if (run.inFlight && (run.pauseAtBoundary || run.pauseNext)) {
        // Keep the clock and external completions alive without dispatching further device steps.
        this.schedule(run, run.clock.nextDelay());
        return;
      }
      const index = run.ready.findIndex(t => (!run.stepOwner || t === run.stepOwner) &&
        (!run.mainOwner || t === run.mainOwner || t.context.source === 'on_start'));
      const task = index < 0 ? undefined : run.ready.splice(index, 1)[0];
      if (!task) break;
      const root = task.context.source !== 'on_start';
      const begin = performance.now();
      if (root) { run.mainOwner = task; run.lua.budget(task.remainingMs); }
      try {
        task.advance();
        if (root && this.active === run && !run.controller.signal.aborted) {
          task.remainingMs -= performance.now() - begin;
          if (task.remainingMs <= 0) run.lua.watchdog();
        }
      } catch (error) {
        if (task.current) this.record(task.context, task.current, 'failed', messageOf(error));
        this.cancel(run, messageOf(error));
      } finally { run.lua.budget(Infinity); }
      if (this.active !== run || run.controller.signal.aborted || run.resume || run.approve) return;
      if (performance.now() >= sliceEnd) break;
    }
    const wait = run.clock.nextDelay();
    if (!run.tasks.size && !run.inputs.size && !Number.isFinite(wait)) { this.finish(run); return; }
    if (!run.tasks.size) {
      this.view = { ...this.view!, state: 'waiting', current: null };
      if (run.pauseNext === 'pause') { this.suspend(run, 'pause', run.sharedVariables, () => {}); return; }
    }
    else if (run.handlers && !run.ready.length) {
      const task = [...run.tasks.values()].find(t => t.current);
      if (task?.current) this.showStep(task, task.current);
    }
    this.schedule(run, run.ready.length || (run.pendingInputs.length && !run.mainOwner) ? 0 : wait);
  }

  private showStep(task: ScriptTask, step: PlannedStep) {
    task.current = step;
    const source = task.context.session.handlers ? task.context.source : undefined;
    this.view = { ...this.view!, state: this.view!.state === 'waiting' ? 'running' : this.view!.state,
      current: { blockId: step.blockId, label: step.label, ...(source ? { source } : {}), ...(task.context.input ? { triggerLabel: task.context.input.label } : {}) } };
  }

  private advance(task: ScriptTask, outcome?: Outcome, error?: { reason: unknown }) {
    const run = task.context.session;
    try {
      const next = error ? task.flow.throw(error.reason) : task.flow.next(outcome);
      if (next.done) {
        if (run.mainOwner === task) run.mainOwner = undefined;
        if (run.stepOwner === task) run.stepOwner = undefined;
        run.tasks.delete(task.context.source); return;
      }
      const instruction = next.value;
      if ('slice' in instruction) { task.advance = () => this.advance(task); run.ready.push(task); return; }
      const { step } = instruction;
      if (!task.current && task.context.source === 'on_run') {
        run.clock.enterCycle();
        this.updateEventStatus(run);
      }
      this.showStep(task, step);
      const reason = run.pauseNext ?? (run.breakpoints.has(step.blockId) ? 'breakpoint' : undefined);
      if (!reason) { this.execute(task, instruction); return; }
      const pause = () => {
        let prepared: PreparedWrite | undefined;
        let writeError: StepFailure | undefined;
        try { prepared = step.prepareWrite?.(task.context); }
        catch (error) { writeError = new StepFailure(messageOf(error), ['not-sent', 'evaluation']); }
        this.suspend(run, reason, task.context.variables, () => {
          task.advance = () => this.execute(task, instruction, prepared, writeError);
          run.ready.unshift(task);
        }, prepared?.preview, writeError?.message, task);
      };
      if (run.inFlight) {
        run.pauseAtBoundary = pause;
        this.view = { ...this.view!, state: 'pausing' };
      } else pause();
    } catch (error) {
      if (error instanceof ScriptHandleFault && task.current) this.record(task.context, task.current, 'failed', error.message);
      this.cancel(run, messageOf(error));
    }
  }

  private execute(task: ScriptTask, instruction: Extract<Instruction, { step: PlannedStep }>, prepared?: PreparedWrite, writeError?: StepFailure) {
    const { session: run } = task.context;
    const { step } = instruction;
    const complete = (outcome?: Outcome, error?: { reason: unknown }) => {
      if (error) this.record(task.context, step, run.controller.signal.aborted ? 'stopped' : 'failed', messageOf(error.reason));
      else if (outcome) this.record(task.context, step, outcome.control === 'stop' ? 'stopped' : 'ok', outcome.detail, outcome.log);
      if (run.controller.signal.aborted) { if (!run.inFlight) this.finish(run); return; }
      if (error?.reason instanceof ScriptHandleFault) { this.cancel(run, error.reason.message); return; }
      if (outcome?.control === 'stop') { this.cancel(run); return; }
      task.advance = () => this.advance(task, outcome, error);
      if (error || run.pauseNext) run.ready.unshift(task);
      else run.ready.push(task);
    };
    try {
      if (writeError) throw writeError;
      if (instruction.loopBoundary) { complete(); return; }
      const result = prepared ? prepared.send() : step.execute(task.context);
      if (!(result instanceof Promise)) { complete(result); return; }
      if (run.mainOwner === task) run.mainOwner = undefined;
      run.inFlight++;
      const settled = (value?: Outcome, error?: { reason: unknown }) => {
        run.inFlight--;
        complete(value, error);
        this.schedule(run, 0);
      };
      void result.then(value => settled(value), reason => settled(undefined, { reason }));
    } catch (reason) { complete(undefined, { reason }); }
  }

  // Lua owns the program counter and control frames. The adapter translates its
  // requests into checked host operations; no device Promise is awaited inside a Lua/C call.
  private *walk(task: TaskContext, steps: PlannedStep[]): Flow {
    const { session: run, source } = task;
    const groupId = (group: PlannedStep[]) => {
      const id = group.length ? run.groupIds[group[0]!.blockId]! : 0;
      run.groups[id] = group;
      return id;
    };
    const calls: (() => void)[] = [];
    const handlers: (StepFailure | undefined)[] = [];
    const tests = new Map<PlannedStep, (context: TaskContext) => ConditionReading>();
    let failure: unknown;
    let reply = 'next';
    let choice: number | undefined;
    run.lua.open(source, groupId(steps));
    try {
      while (true) {
        const action = run.lua.advance(source, reply, choice);
        reply = 'next'; choice = undefined;
        switch (action.kind) {
          case 'done': return;
          case 'slice': yield { slice: true }; continue;
          case 'unhandled': throw failure;
          case 'leave_call': calls.pop()!(); continue;
          case 'leave_handler': task.failure = handlers.pop(); continue;
          case 'enter_handler': {
            handlers.push(task.failure);
            task.failure = failure instanceof StepFailure ? failure : new StepFailure(messageOf(failure), ['evaluation']);
            const failed = task.failedEntry;
            if (failed) {
              const mark = (row: ScriptRunEntry) => row === failed ? { ...row, handled: true } : row;
              this.view = { ...this.view!, entries: this.view!.entries.map(mark), eventLog: this.view!.eventLog?.map(mark) };
            }
            continue;
          }
        }
        const step = run.groups[action.group]?.[action.index - 1];
        if (!step) throw new ScriptHandleFault('Lua 返回了无效的步骤位置');
        if (action.kind === 'test') {
          try {
            const reading = tests.get(step)!(task);
            if (reading.matched === undefined) throw new Error(`条件暂不可判定 · ${reading.detail}`);
            if (reading.matched) reply = 'exit_loop';
          } catch (e) { this.record(task, step, 'failed', messageOf(e)); failure = e; reply = 'error'; }
          continue;
        }
        if (action.kind !== 'step' && action.kind !== 'boundary') throw new ScriptHandleFault('未知 Lua 调度操作');
        let outcome: Outcome | undefined;
        try { outcome = yield { step, loopBoundary: action.kind === 'boundary' }; }
        catch (e) { failure = e; reply = 'error'; continue; }
        const body = outcome?.body;
        if (!body) continue;
        groupId(body.steps);
        if (body.mode === 'sequence') choice = body.choice;
        if (body.mode === 'call') calls.push(enterFunction(task, body.functionId, body.variables));
        else if (body.mode === 'attempt') groupId(body.handler);
        else if (body.mode === 'loop' && body.until) tests.set(step, body.until);
      }
    } finally {
      while (calls.length) calls.pop()!();
      task.failure = undefined;
      run.lua.drop(source);
    }
  }
}
