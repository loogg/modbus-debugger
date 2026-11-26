import { setTimeout as delay } from 'node:timers/promises';
import { beforeAll, expect, it, vi } from 'vitest';
import { loadScriptLua } from '../../src/main/runtime/script-lua-handle';
import { compileScriptProgram, newScriptGraph, type ScriptBlock, type ScriptGraph } from '../../src/domain/master-script';
import { MasterScriptRunner } from '../../src/main/runtime/master-script-runner';
import { RuntimeNotifications, type RuntimeChange } from '../../src/main/runtime/runtime-notifications';
import { ScriptEventClock } from '../../src/main/runtime/script-event-clock';
import type { PointWriteResult } from '../../src/shared/contracts';

function chain(...blocks: ScriptBlock[]): ScriptBlock {
  return blocks.reduceRight<ScriptBlock | undefined>((next, block) => next ? { ...block, next: { block: next } } : block, undefined)!;
}
const graph = (...blocks: ScriptBlock[]): ScriptGraph => ({ blocks: { languageVersion: 0, blocks } });
const log = (id: string): ScriptBlock => ({ id, type: 'mb_log', fields: { TEXT: id } });
const start: ScriptBlock = { id: 'start', type: 'mb_start' };
const cycle: ScriptBlock = { id: 'cycle', type: 'mb_on_run', fields: { PERIOD: 100 } };
const startTimer = (period: number, count: number): ScriptBlock => ({ id: 'arm', type: 'mb_timer_start', fields: { TIMER: 0, PERIOD: period, MODE: 'count', COUNT: count } });
const timer: ScriptBlock = { id: 'timer', type: 'mb_on_timer', fields: { TIMER: 0 } };
const init = (name: string): ScriptBlock => ({ id: 'init-' + name, type: 'mb_set_var', fields: { VARIABLE: name, OPERAND: 0 } });
const add = (name: string): ScriptBlock => ({ id: 'inc-' + name, type: 'mb_change_var', fields: { VARIABLE: name, OPERAND: 1 } });
const stop: ScriptBlock = { id: 'stop', type: 'mb_stop' };
const pause = (id: string, ms: number): ScriptBlock => ({ id, type: 'mb_delay', fields: { MS: ms } });
beforeAll(loadScriptLua);

const asyncWrite = (id: string): ScriptBlock => ({ id, type: 'mb_write', fields: { POINT: '["s","p"]', VALUE: '1' } });
function local(writeLatencyMs?: number) {
  const unused = (): never => { throw new Error('unexpected device access'); };
  const runner = new MasterScriptRunner({ point: writeLatencyMs === undefined ? unused : ref => ({
    ref, blockKey: 'device', span: { offset: 0, length: 1 }, label: 'output', type: 'UInt16', highRisk: false,
    identity: 'output', read: unused, validateWrite() {},
  }), slave: unused, write: writeLatencyMs === undefined ? unused : async () => {
    await delay(writeLatencyMs); return { phase: 'confirmed', result: 'ok', exceptionCode: null };
  } }, new RuntimeNotifications());
  const run = (g: ScriptGraph, callbackTimeoutMs?: number) =>
    runner.start(runner.prepare({ id: 'test', name: 'events', revision: 0, graph: g, callbackTimeoutMs }));
  return { runner, run };
}

it.each(['mb_forever', 'mb_repeat'] as const)('dispatches on_run from Main during a hot %s in on_start with zero timer channels armed', async type => {
  const { runner, run } = local();
  const loop: ScriptBlock = { type, id: 'loop', fields: { COUNT: 1_000_000 }, inputs: { BODY: { block: add('iterations') } } };
  run(graph(chain(start, init('iterations'), init('ticks'), { id: 'period', type: 'mb_run_period', fields: { PERIOD: 20 } }, loop, log('start-returned')),
    chain(cycle, add('ticks'), { id: 'third', type: 'mb_if', inputs: {
      CONDITION: { block: { id: 'test-ticks', type: 'mb_compare_values', fields: { OP: 'eq', B: 3 },
        inputs: { A: { block: { id: 'ticks', type: 'mb_variable', fields: { VARIABLE: 'ticks' } } } } } }, YES: { block: stop },
    } })));
  try {
    await expect.poll(() => runner.snapshot?.state).toBe('stopped');
    const result = runner.snapshot!;
    expect(result.events).toEqual({ onRun: { enabled: false, periodMs: 20, calls: 3 }, timers: [] });
    const values = new Map(result.variableScopes[0]!.values.map(v => [v.name, v.value]));
    expect(values.get('iterations')).toBeGreaterThan(0); expect(values.get('iterations')).toBeLessThan(1_000_000);
    expect(values.get('ticks')).toBe(3);
    expect(result.entries.at(-1)).toMatchObject({ blockId: 'stop', source: 'on_run' });
    expect(result.entries.some(e => e.blockId === 'start-returned')).toBe(false);
  } finally { runner.stop(); await runner.settle(); }
});

it('executes exactly three slow timer callbacks without reentry, and joins the final task before finishing', async () => {
  const { runner, run } = local(135);
  run(graph(chain(start, startTimer(10, 3)), chain(timer, log('open'), asyncWrite('slow'), log('close'))), 50);
  await runner.settle();
  expect(runner.snapshot?.state).toBe('passed');
  expect(runner.snapshot!.entries.filter(e => e.log).map(e => [e.source, e.detail]))
    .toEqual(Array.from({ length: 3 }).flatMap(() => [['T0', 'open'], ['T0', 'close']]));
});

it('sleeps only the startup coroutine while a timer completes on the same handle', async () => {
  const { runner, run } = local();
  run(graph(chain(start, startTimer(15, 1), pause('sleep', 120), log('awake')), chain(timer, log('tick'))));
  await runner.settle();
  expect(runner.snapshot?.state).toBe('passed');
  expect(runner.snapshot?.entries.filter(e => e.log).map(e => [e.source, e.detail]))
    .toEqual([['T0', 'tick'], ['on_start', 'awake']]);
});

it('wakes both handles for confirmed device samples and only the owning handle for variable and timer changes', () => {
  const equipment = new RuntimeNotifications();
  const a = new RuntimeNotifications(equipment), b = new RuntimeNotifications(equipment);
  const variable: RuntimeChange = { kind: 'variable', name: 'ticks' };
  const timer: RuntimeChange = { kind: 'timer', channel: 0 };
  const sample: RuntimeChange = { kind: 'sample', blockKey: 'input', range: { offset: 1, length: 1 } };
  const receivedA: RuntimeChange[] = [], receivedB: RuntimeChange[] = [];
  const detachA = a.subscribe([variable, timer, sample], event => receivedA.push(event));
  const detachB = b.subscribe([variable, timer, sample], event => receivedB.push(event));
  a.publish(variable); b.publish(timer); equipment.publish(sample);
  expect(receivedA).toEqual([variable, sample]); expect(receivedB).toEqual([timer, sample]);
  detachA(); equipment.publish(sample); a.publish(variable);
  expect(receivedA).toHaveLength(2); expect(receivedB).toHaveLength(3);
  detachB();
});

it.each(['on_run', 'T0'] as const)('stops the handle on illegal sleep through a function and error handler in %s', async source => {
  const { runner, run } = local();
  const caller = source === 'on_run' ? { ...cycle, fields: { PERIOD: 10 } } : timer;
  const fn: ScriptBlock = { id: 'fn', type: 'mb_procedure', fields: { NAME: 'nap' }, inputs: { BODY: { block: pause('illegal', 1) } } };
  const attempt: ScriptBlock = { id: 'try', type: 'mb_try', inputs: { BODY: { block: { id: 'call', type: 'mb_call', fields: { FUNCTION: 'fn' } } },
    ERROR: { block: log('recovered') } } };
  run(graph(chain(start, startTimer(10, 1), pause('sleeping', 3000), log('awake')), chain(caller, attempt, log('continued')), fn));
  await runner.settle();
  expect(runner.snapshot).toMatchObject({ state: 'failed', detail: expect.stringContaining('sleep_ms'), events: { timers: [] } });
  expect(runner.snapshot!.eventLog).toContainEqual(expect.objectContaining({ blockId: 'illegal', source, result: 'failed' }));
  expect(runner.snapshot!.entries.filter(entry => entry.log)).toHaveLength(0);
});

it('raises a fatal Lua watchdog error for CPU-bound main callbacks while another handle keeps its own timer', async () => {
  const busy = local(), healthy = local();
  const loop: ScriptBlock = { id: 'spin', type: 'mb_forever', inputs: { BODY: { block: add('n') } } };
  healthy.run(graph(chain(start, { id: 'arm', type: 'mb_timer_start', fields: { TIMER: 0, PERIOD: 15, MODE: 'loop' } }), chain(timer, log('healthy'))));
  try {
    busy.run(graph(chain(start, init('n')), chain({ ...cycle, fields: { PERIOD: 10 } },
      { id: 'try', type: 'mb_try', inputs: { BODY: { block: loop }, ERROR: { block: log('recovered') } } })), 75);
    await busy.runner.settle();
    expect(busy.runner.snapshot).toMatchObject({ state: 'failed', callbackTimeoutMs: 75, detail: expect.stringContaining('75 ms') });
    expect(busy.runner.snapshot?.entries.some(e => e.blockId === 'recovered')).toBe(false);
    const before = healthy.runner.snapshot!.completed;
    await expect.poll(() => healthy.runner.snapshot!.completed).toBeGreaterThan(before);
  } finally { busy.runner.stop(); healthy.runner.stop(); await Promise.all([busy.runner.settle(), healthy.runner.settle()]); }
});

it('charges the same workload against each handle’s configured limit and resets the budget for every timer call', async () => {
  const now = performance.now.bind(performance);
  let workMs = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now() + workMs);
  const runner = () => new MasterScriptRunner({
    point: ref => ({ ref, identity: 'input', blockKey: 'device', span: { offset: 0, length: 1 }, label: 'input', type: 'UInt16', highRisk: false,
      read: () => { workMs += 65; return { value: 1, detail: '1' }; }, validateWrite() {} }),
    slave: () => { throw new Error('unexpected slave access'); }, write: () => { throw new Error('unexpected write'); },
  }, new RuntimeNotifications());
  const short = runner(), long = runner();
  const read = (id: string): ScriptBlock => ({ ...log(id), inputs: { OPERAND: {
    block: { type: 'mb_point_value', id: 'value-' + id, fields: { POINT: '["s","p"]' } },
  } } });
  try {
    const onRun = graph(chain({ ...cycle, fields: { PERIOD: 10 } }, read('first'), read('second'), log('done')));
    const onTimer = graph(chain(start, startTimer(10, 2)), chain(timer, read('first'), read('second'), log('done')));
    short.start(short.prepare({ id: 'a', name: 'A', revision: 0, graph: onRun, callbackTimeoutMs: 110 }));
    long.start(long.prepare({ id: 'b', name: 'B', revision: 0, graph: onTimer, callbackTimeoutMs: 220 }));
    await Promise.all([short.settle(), long.settle()]);
    expect(short.snapshot).toMatchObject({ state: 'failed', detail: expect.stringContaining('110 ms') });
    expect(short.snapshot?.entries.at(-1)).toMatchObject({ blockId: 'second', result: 'failed', source: 'on_run' });
    expect(long.snapshot).toMatchObject({ state: 'passed', callbackTimeoutMs: 220 });
    expect(long.snapshot?.entries.filter(e => e.blockId === 'done' && e.source === 'T0')).toHaveLength(2);
  } finally { short.stop(); long.stop(); await Promise.all([short.settle(), long.settle()]); clock.mockRestore(); }
});

it('shares root variables across callbacks and isolates simultaneous invocations of the same procedure', async () => {
  const { runner, run } = local(85);
  const call = (id: string, value: number): ScriptBlock => ({ type: 'mb_call', id, fields: { FUNCTION: 'fn', ARG0: value } });
  const fn: ScriptBlock = { id: 'fn', type: 'mb_procedure', fields: { NAME: 'sample', PARAMS: 'value' }, inputs: {
    BODY: { block: chain(asyncWrite('wait'), { ...log('reading'), inputs: { OPERAND: { block: { type: 'mb_parameter', id: 'arg', fields: { PARAM: '0' } } } } }, add('value')) },
  } };
  run(graph(chain(start, init('shared'), startTimer(15, 1), call('from-start', 11)), chain(timer, add('shared'), call('from-timer', 77)), fn));
  await runner.settle();
  const snapshot = runner.snapshot!;
  expect(snapshot.state).toBe('passed');
  expect(snapshot.entries.filter(e => e.log).map(e => [e.source, e.detail])).toEqual([['on_start', 'reading 11'], ['T0', 'reading 77']]);
  expect(snapshot.variableScopes).toEqual(expect.arrayContaining([
    { functionId: null, inCall: false, values: [{ name: 'shared', value: 1 }] },
    { functionId: 'fn', source: 'on_start', inCall: false, values: [{ name: 'value', value: 12 }] },
    { functionId: 'fn', source: 'T0', inCall: false, values: [{ name: 'value', value: 78 }] },
  ]));
});

it('suspends the whole event clock at a breakpoint and discards callbacks on stop', async () => {
  const { runner, run } = local();
  const g = graph(chain(start, startTimer(20, 10)), chain(timer, log('tick')), chain(cycle, log('heartbeat')));
  g.breakpoints = ['tick'];
  run(g, 50);
  await expect.poll(() => runner.snapshot?.state).toBe('paused');
  const before = runner.snapshot!;
  expect(before.current).toMatchObject({ blockId: 'tick', source: 'T0' });
  await delay(125);
  expect(runner.snapshot?.completed).toBe(before.completed);
  expect(runner.snapshot?.events).toEqual(before.events);
  runner.resume(before.id, before.pause!.token, 'continue');
  await expect.poll(() => runner.snapshot!.entries.filter(e => e.log).length).toBe(1);
  runner.stop(); await runner.settle();
  const count = runner.snapshot!.completed;
  await delay(35);
  expect(runner.snapshot).toMatchObject({ state: 'stopped', completed: count, events: { timers: [] } });
});

it('completes one-shot graphs with an empty on_run or an unarmed timer, and locates invalid events', async () => {
  const { runner, run } = local();
  const blank = newScriptGraph('start');
  expect(blank.blocks?.blocks.map(b => b.type)).toEqual(['mb_start', 'mb_on_run']);
  run(graph(chain(start, log('once')), cycle, chain(timer, log('unarmed'))));
  await runner.settle();
  expect(runner.snapshot?.state).toBe('passed');
  expect(runner.snapshot!.entries.map(row => row.detail)).toEqual(['once']);
  expect(() => compileScriptProgram(graph(cycle, { ...cycle, id: 'duplicate' }))).toThrow('on_run');
  expect(() => compileScriptProgram(graph(timer, { ...timer, id: 'duplicate' }))).toThrow('T0');
  expect(() => compileScriptProgram(graph({ ...timer, fields: { TIMER: 15 } }))).toThrow();
  expect(() => compileScriptProgram(graph(chain(start, startTimer(0, 1))))).toThrow('周期');
});

it('pauses immediately while waiting without a startup task, then steps into the first host cycle', async () => {
  const { runner, run } = local();
  const initial = run(graph(chain({ ...cycle, fields: { PERIOD: 35 } }, log('hello'), { id: 'off', type: 'mb_run_control', fields: { MODE: 'stop' } })));
  expect(initial.state).toBe('waiting');
  expect(runner.pause(initial.id)).toBe(true);
  await delay(80);
  const paused = runner.snapshot!;
  expect(paused).toMatchObject({ state: 'paused', current: null, events: { onRun: { calls: 0 } } });
  runner.resume(initial.id, paused.pause!.token, 'step');
  await expect.poll(() => runner.snapshot?.current?.source).toBe('on_run');
  expect(runner.snapshot).toMatchObject({ state: 'paused', completed: 0 });
  runner.resume(initial.id, runner.snapshot!.pause!.token, 'continue');
  await runner.settle();
  expect(runner.snapshot).toMatchObject({ state: 'passed', events: { onRun: { calls: 1 }, timers: [] } });
});

it('keeps on_run independent of channel resets, elapsed time, finite dispatch counts and stops', () => {
  let t = 0;
  const clock = new ScriptEventClock(100, () => t);
  const idle = new Map();
  clock.startTimer(0, 30, 3);
  t = 10; expect(clock.elapsed(0)).toBe(10);
  clock.startTimer(0, 50, 1); expect(clock.elapsed(0)).toBe(0);
  t = 60; expect(clock.takeDue(idle)).toEqual(['T0']); expect(clock.isRunning(0)).toBe(false);
  t = 100; expect(clock.takeDue(idle)).toEqual(['on_run']);
  clock.enableCycle(false); clock.startTimer(0, 10, 0);
  t = 300; expect(clock.takeDue(idle)).toEqual(['T0']); expect(clock.takeDue(idle)).toEqual([]);
  clock.stopTimer(0); expect(clock.nextDelay()).toBe(Infinity);
  clock.setPeriod(20); clock.enableCycle(true); t = 320;
  expect(clock.takeDue(idle)).toEqual(['on_run']); expect(clock.elapsed(0)).toBe(0);
});

it('can wait on elapsed time, check timer state and cancel a multi-shot timer before its first callback', async () => {
  const { runner, run } = local();
  const pin = (block: ScriptBlock) => ({ block });
  run(graph(chain(start, startTimer(250, 3), { id: 'await-time', type: 'mb_wait', fields: { TIMEOUT: 1000 },
    inputs: { CONDITION: pin({ id: 'elapsed-test', type: 'mb_compare_values', fields: { OP: 'ge', B: 20 },
      inputs: { A: pin({ id: 'elapsed', type: 'mb_timer_elapsed', fields: { TIMER: 0 } }) } }) } },
    { id: 'assert-active', type: 'mb_assert', inputs: { CONDITION: pin({ id: 'active', type: 'mb_timer_running', fields: { TIMER: 0 } }) } },
    { id: 'disarm', type: 'mb_timer_stop', fields: { TIMER: 0 } },
    { ...log('after'), inputs: { OPERAND: pin({ id: 'after-time', type: 'mb_timer_elapsed', fields: { TIMER: 0 } }) } }),
    chain(timer, log('unexpected'))));
  await runner.settle();
  expect(runner.snapshot?.state).toBe('passed');
  expect(runner.snapshot!.entries.filter(e => e.log).map(e => e.detail)).toEqual(['after 0']);
});

it('continues on_run while on_start waits for a confirmed sample, and cancels the subscription on stop', async () => {
  const notifications = new RuntimeNotifications();
  const runner = new MasterScriptRunner({
    point: ref => ({ ref, blockKey: 'confirmed', span: { offset: 0, length: 1 }, type: 'UInt16', highRisk: false, identity: 'temperature',
      label: 'temperature', read: () => ({ value: 31, detail: '31' }), validateWrite() {} }),
    slave: () => ({ label: 'station', state: () => 'online' }), write: () => { throw new Error('unexpected write'); },
  }, notifications);
  const g = graph(chain(start, { id: 'read', type: 'mb_read', fields: { POINT: '["s","p"]', TIMEOUT: 5000 } }, log('received')),
    chain({ ...cycle, fields: { PERIOD: 10 } }, log('active'), { id: 'off', type: 'mb_run_control', fields: { MODE: 'stop' } }));
  const plan = runner.prepare({ id: 'device', name: 'device', revision: 0, graph: g });
  runner.start(plan);
  try {
    await expect.poll(() => runner.snapshot?.entries.some(row => row.blockId === 'off')).toBe(true);
    expect(runner.snapshot!.current?.blockId).toBe('read');
    expect(runner.snapshot!.entries.some(row => row.blockId === 'received')).toBe(false);
    notifications.publish({ kind: 'sample', blockKey: 'confirmed', range: { offset: 0, length: 1 } });
    await runner.settle();
    expect(runner.snapshot!.entries.filter(e => e.log).map(e => e.source)).toEqual(['on_run', 'on_start']);
    runner.start(plan);
    runner.stop(); await runner.settle();
    const count = runner.snapshot!.completed;
    notifications.publish({ kind: 'sample', blockKey: 'confirmed', range: { offset: 0, length: 1 } });
    expect(runner.snapshot!.completed).toBe(count);
  } finally { runner.stop(); await runner.settle(); }
});

it('plans high-risk event writes, holds dispatch during confirmation, then joins an in-flight device receipt on stop', async () => {
  const sent: number[] = [];
  let acknowledge!: (result: PointWriteResult) => void;
  const runner = new MasterScriptRunner({
    point: ref => ({ ref, blockKey: 'mixed', span: { offset: 0, length: 1 }, label: 'speed', type: 'UInt16', highRisk: true,
      identity: 'speed', read: () => ({ value: 4, detail: '4' }), validateWrite() {} }),
    slave: () => ({ label: 'station', state: () => 'online' }),
    write: (_ref, fields) => { sent.push(fields.engineering!); return new Promise(resolve => { acknowledge = resolve; }); },
  }, new RuntimeNotifications());
  const g = graph(chain(start, { ...init('speed'), fields: { VARIABLE: 'speed', OPERAND: 42 } }, startTimer(10, 1)),
    chain(timer, { id: 'write', type: 'mb_write', fields: { POINT: '["s","p"]' }, inputs: {
      OPERAND: { block: { id: 'value', type: 'mb_variable', fields: { VARIABLE: 'speed' } } },
    } }, log('after-write')), chain(cycle, log('other-task')));
  const plan = runner.prepare({ id: 'high', name: 'high', revision: 0, graph: g });
  expect(plan.approval?.writes.length).toBe(1);
  expect(() => runner.start(plan)).toThrow('确认');
  const run = runner.start(plan, plan.approval!.key);
  await expect.poll(() => runner.snapshot?.pendingWrite?.value).toBe('42');
  const callsAtPrompt = runner.snapshot!.events!.onRun!.calls;
  await delay(110);
  expect(runner.snapshot?.events?.onRun?.calls).toBe(callsAtPrompt);
  expect(sent).toEqual([]);
  expect(runner.confirmWrite(run.id, runner.snapshot!.pendingWrite!.token)).toBe(true);
  await expect.poll(() => sent).toEqual([42]);
  runner.stop();
  expect(runner.snapshot?.state).toBe('stopping');
  acknowledge({ phase: 'confirmed', result: 'ok', exceptionCode: null });
  await runner.settle();
  expect(runner.snapshot?.state).toBe('stopped');
  expect(runner.snapshot!.entries.at(-1)).toMatchObject({ blockId: 'write', result: 'ok', source: 'T0' });
  expect(runner.snapshot!.entries.some(e => e.blockId === 'after-write')).toBe(false);
});
