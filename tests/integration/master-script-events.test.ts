import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { compileScriptProgram, newScriptGraph, type ScriptBlock, type ScriptGraph } from '../../src/domain/master-script';
import { MasterScriptRunner } from '../../src/main/runtime/master-script-runner';
import { RuntimeNotifications } from '../../src/main/runtime/runtime-notifications';
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

function local() {
  const unused = (): never => { throw new Error('unexpected device access'); };
  const runner = new MasterScriptRunner({ point: unused, slave: unused, write: unused }, new RuntimeNotifications());
  const run = (g: ScriptGraph) => runner.start(runner.prepare({ id: 'test', name: 'events', revision: 0, graph: g }));
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
  const { runner, run } = local();
  run(graph(chain(start, startTimer(10, 3)), chain(timer, log('open'), pause('slow', 35), log('close'))));
  await runner.settle();
  expect(runner.snapshot?.state).toBe('passed');
  expect(runner.snapshot!.entries.filter(e => e.log).map(e => [e.source, e.detail]))
    .toEqual(Array.from({ length: 3 }).flatMap(() => [['T0', 'open'], ['T0', 'close']]));
});

it('shares root variables across callbacks and isolates simultaneous invocations of the same procedure', async () => {
  const { runner, run } = local();
  const call = (id: string, value: number): ScriptBlock => ({ type: 'mb_call', id, fields: { FUNCTION: 'fn', ARG0: value } });
  const fn: ScriptBlock = { id: 'fn', type: 'mb_procedure', fields: { NAME: 'sample', PARAMS: 'value' }, inputs: {
    BODY: { block: chain(pause('wait', 85), { ...log('reading'), inputs: { OPERAND: { block: { type: 'mb_parameter', id: 'arg', fields: { PARAM: '0' } } } } }, add('value')) },
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
  run(g);
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
