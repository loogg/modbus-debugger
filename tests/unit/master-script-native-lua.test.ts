import * as Blockly from 'blockly/core';
import { expect, it } from 'vitest';
import type { ScriptBlock } from '../../src/domain/master-script';
import { loadScriptGraph } from '../../src/renderer/features/scripts/block-controls';
import { generateScriptLuaSource, graphOf } from '../../src/renderer/features/scripts/blocks';
import { scriptFileSchema } from '../../src/domain/master-script';
import eventExample from '../../docs/examples/independent-on-run.modbus-script.json';

const pin = (block: ScriptBlock) => ({ block });
const param = (id: string, index: number): ScriptBlock => ({ id, type: 'mb_parameter', fields: { PARAM: String(index) } });
const variable = (id: string, name: string): ScriptBlock => ({ id, type: 'mb_variable', fields: { VARIABLE: name } });
const log = (id: string, operand: ScriptBlock): ScriptBlock => ({ id, type: 'mb_log', fields: { TEXT: '反馈' }, inputs: { OPERAND: pin(operand) } });
const start = (block: ScriptBlock): ScriptBlock => ({ id: 'entry', type: 'mb_start', next: pin(block) });
function generate(roots: ScriptBlock[]) {
  const ws = new Blockly.Workspace();
  try {
    loadScriptGraph({ blocks: { languageVersion: 0, blocks: roots } }, ws);
    return generateScriptLuaSource(ws, graphOf(ws));
  } finally { ws.dispose(); }
}

it('declares each callee before its caller, with independent parameter scopes and matching block ranges', () => {
  const callee: ScriptBlock = { id: 'z', type: 'mb_function', fields: { NAME: 'increment', PARAMS: 'value' }, inputs: {
    RESULT: pin({ id: 'add', type: 'mb_arithmetic', fields: { OP: 'add', B: 1 }, inputs: { A: pin(param('v', 0)) } }),
  } };
  const caller: ScriptBlock = { id: 'a', type: 'mb_procedure', fields: { NAME: 'report', PARAMS: 'increment' }, inputs: {
    BODY: pin(log('inside', { id: 'nested', type: 'mb_call_value', fields: { FUNCTION: 'z' }, inputs: { ARG0: pin(param('argument', 0)) } })),
  } };
  const main = start({ id: 'invoke', type: 'mb_call', fields: { FUNCTION: 'a', ARG0: 41 } });
  const output = generate([caller, main, callee]);
  expect(output.text).toBe([
    'local function increment(value)', '  return value + 1', 'end', '',
    'local function report(increment_2)', '  print("反馈", increment(increment_2))', 'end', '', 'report(41)',
  ].join('\n'));
  expect(output.ranges.get('z')).toEqual({ first: 0, last: 2 });
  expect(output.ranges.get('nested')).toEqual({ first: 5, last: 5 });
  expect(output.lines[5]?.blockId).toBe('inside');
  expect(generate([callee, main, caller]).text).toBe(output.text);
});

it('protects Lua keywords, host globals and existing ASCII names when making legacy aliases', () => {
  const fn: ScriptBlock = { id: 'lookup', type: 'mb_function', fields: { NAME: 'print', PARAMS: 'end, distance-mm, distance_mm, 采样, arg_4' },
    inputs: { RESULT: pin(param('result', 3)) } };
  const main = start(log('log', { id: 'call', type: 'mb_call_value', fields: { FUNCTION: 'lookup', ARG3: 17 } }));
  const { text } = generate([main, fn]);
  expect(text).toContain('local function print_(end_, distance_mm_2, distance_mm, arg_4_2, arg_4)\n  return arg_4_2');
  expect(text).toContain('print("反馈", print_(0, 0, 0, 17, 0))');
});

it('hoists branch-created and self-referenced variables, but declares direct first assignments in place', () => {
  const branch: ScriptBlock = { type: 'mb_if', id: 'if', fields: { BOOL_CONDITION: 'TRUE' },
    inputs: { YES: pin({ type: 'mb_set_var', id: 'set', fields: { VARIABLE: 'speed', OPERAND: 17 } }) },
    next: pin(log('observe', variable('read', 'speed'))) };
  const init: ScriptBlock = { type: 'mb_set_var', id: 'init', fields: { VARIABLE: 'limit', OPERAND: 70 }, next: pin(branch) };
  const result = generate([start(init)]);
  expect(result.text).toBe('local speed\nlocal limit = 70\nif true then\n  speed = 17\nend\nprint("反馈", speed)');
  expect(result.lines[0]?.blockId).toBe('entry');
  const self: ScriptBlock = { type: 'mb_set_var', id: 'self', fields: { VARIABLE: 'speed' }, inputs: { OPERAND: pin(variable('rhs', 'speed')) } };
  expect(generate([start(self)]).text).toBe('local speed\nspeed = speed');
});

it('keeps expression grouping and boolean precedence when emitting infix Lua', () => {
  const expression: ScriptBlock = { type: 'mb_arithmetic', id: 'ratio', fields: { OP: 'divide' }, inputs: {
    A: pin({ type: 'mb_arithmetic', id: 'sum', fields: { A: 8, B: 4, OP: 'add' } }),
    B: pin({ type: 'mb_arithmetic', id: 'difference', fields: { A: 5, B: 2, OP: 'subtract' } }),
  } };
  const cmp: ScriptBlock = { id: 'cmp', type: 'mb_compare_values', fields: { OP: 'ge', B: 4 }, inputs: { A: pin(expression) } };
  const predicate: ScriptBlock = { id: 'not', type: 'mb_not', inputs: { CONDITION: pin(cmp) } };
  expect(generate([start(log('check', predicate))]).text).toBe('print("反馈", not ((8 + 4) / (5 - 2) >= 4))');
});

it('keeps checked evaluation through a direct user function call inside an error handler', () => {
  const ratio: ScriptBlock = { type: 'mb_function', id: 'ratio-def', fields: { NAME: 'ratio', PARAMS: 'a,b' }, inputs: {
    RESULT: pin({ type: 'mb_arithmetic', id: 'division', fields: { OP: 'divide' }, inputs: { A: pin(param('left', 0)), B: pin(param('right', 1)) } }),
  } };
  const attempt: ScriptBlock = { type: 'mb_try', id: 'try', inputs: {
    BODY: pin({ type: 'mb_set_var', id: 'result', fields: { VARIABLE: 'output' }, inputs: {
      OPERAND: pin({ type: 'mb_call_value', id: 'call', fields: { FUNCTION: 'ratio-def', ARG0: 2, ARG1: 0 } }),
    } }), ERROR: pin({ type: 'mb_log', id: 'failure', fields: { TEXT: '计算失败' } }),
  } };
  const { text } = generate([start(attempt), ratio]);
  expect(text).toContain('local function ratio(a, b)\n  return modbus.arithmetic(a, "/", b)\nend');
  expect(text).toContain('output = ratio(2, 0)');
  expect(text).toContain('modbus.attempt(function()');
});

it('keeps the full 200-argument graph representable within Lua 5.4 local/register limits', () => {
  const names = Array.from({ length: 200 }, (_, i) => 'p' + i);
  const fn: ScriptBlock = { type: 'mb_procedure', id: 'wide', fields: { NAME: 'wide', PARAMS: names.join(',') }, inputs: {
    BODY: pin({ type: 'mb_set_var', id: 'output', fields: { VARIABLE: 'result' }, inputs: { OPERAND: pin(param('last-parameter', 199)) },
      next: pin(log('report', variable('result-value', 'result'))) }),
  } };
  const { text } = generate([start({ id: 'invoke', type: 'mb_call', fields: { FUNCTION: 'wide', ARG199: 41 } }), fn]);
  expect(text).toContain('local function wide(...)\n  local _frame = {...}\n  _frame.result = _frame[200]');
  expect(text).toContain('wide(table.unpack({');
  expect(text).toContain('41}, 1, 200))');
});
it('exports separate host callbacks with shared locals, real coroutine yields and clickable source lines', () => {
  const graph = scriptFileSchema.parse(eventExample).graph;
  const { text, lines, ranges } = generate(graph.blocks!.blocks);
  expect(text).toContain('local work_count, heartbeat_count');
  expect(text).toContain('local function on_start()');
  expect(text).toContain('rt.set_run_period(100)');
  expect(text).toContain('coroutine.yield()');
  expect(text).toContain('local function on_run()');
  expect(text).toContain('return { on_start = on_start, on_run = on_run, run_period_ms = 250 }');
  expect(text).not.toContain('start_timer');
  expect(lines[ranges.get('tick')!.first]).toMatchObject({ blockId: 'tick', text: '  heartbeat_count = heartbeat_count + 1' });
  expect(lines[ranges.get('cycle')!.first]?.text).toBe('local function on_run()');
  expect(ranges.get('cycle')!.last).toBeLessThan(lines.length - 1);
});

it('round-trips all timer operations and maps each channel body to its event hat', () => {
  const set: ScriptBlock = { id: 'arm', type: 'mb_timer_start', fields: { TIMER: '2', PERIOD: 75, MODE: 'count', COUNT: 3 } };
  const timer: ScriptBlock = { id: 'timer2', type: 'mb_on_timer', fields: { TIMER: '2' }, next: pin({
    id: 'test', type: 'mb_if', inputs: { CONDITION: pin({ id: 'is-running', type: 'mb_timer_running', fields: { TIMER: '2' } }),
      YES: pin(log('print', { id: 'elapsed', type: 'mb_timer_elapsed', fields: { TIMER: '2' } })) },
    next: pin({ id: 'cancel', type: 'mb_timer_stop', fields: { TIMER: '2' } }),
  }) };
  const other: ScriptBlock = { id: 'timer1', type: 'mb_on_timer', fields: { TIMER: '1' }, next: pin({ id: 'other', type: 'mb_log', fields: { TEXT: 'T1' } }) };
  const result = generate([start(set), timer, other]);
  expect(result.text).toContain('rt.start_timer(2, 75, 3)');
  expect(result.text).toContain('if _timer_id == 1 then');
  expect(result.text).toContain('elseif _timer_id == 2 then');
  expect(result.text).toContain('if rt.is_timer_running(2) then');
  expect(result.text).toContain('rt.get_timer_value(2)');
  expect(result.text).toContain('rt.stop_timer(2)');
  expect(result.lines[result.ranges.get('timer2')!.first]!.blockId).toBe('timer2');
  expect(result.text).not.toContain('function on_run');
});
