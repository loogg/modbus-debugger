import fs from 'node:fs';
import path from 'node:path';
import { setImmediate as turn, setTimeout as delay } from 'node:timers/promises';
import * as Blockly from 'blockly/core';
import { LuaFactory } from 'wasmoon';
import { beforeAll, expect, it, vi } from 'vitest';
import { compileScriptProgram, masterScriptSchema, scriptFileSchema, serializeScriptFile, type MasterScript, type ScriptBlock } from '../../src/domain/master-script';
import { emptyWorkspace } from '../../src/domain/model';
import { loadScriptLua } from '../../src/main/runtime/script-lua-handle';
import { MasterScriptRunner } from '../../src/main/runtime/master-script-runner';
import { RuntimeNotifications } from '../../src/main/runtime/runtime-notifications';
import { RuntimeManager } from '../../src/main/runtime/manager';
import { WorkspaceService } from '../../src/main/services/workspace';
import { HistoryStore } from '../../src/main/services/history';
import { loadScriptGraph } from '../../src/renderer/features/scripts/block-controls';
import { graphOf, inspectScriptDraft } from '../../src/renderer/features/scripts/blocks';
import { createScratch } from '../../tools/test-paths.mjs';

const pin = (block: ScriptBlock) => ({ block });
const chain = (...blocks: ScriptBlock[]) => blocks.reduceRight<ScriptBlock | undefined>((next, block) => next ? { ...block, next: pin(next) } : block, undefined)!;
const start: ScriptBlock = { id: 'start', type: 'mb_start' };
const cycle: ScriptBlock = { id: 'cycle', type: 'mb_on_run', fields: { PERIOD: 15 } };
const log = (id: string): ScriptBlock => ({ id, type: 'mb_log', fields: { TEXT: id } });
const script = (...blocks: ScriptBlock[]): MasterScript => ({ id: 'audit', name: 'audit', revision: 0, graph: { blocks: { languageVersion: 0, blocks } } });
const unused = (): never => { throw Error('unexpected device operation'); };
const local = () => new MasterScriptRunner({ point: unused, slave: unused, write: unused }, new RuntimeNotifications());
const factory = new LuaFactory();
beforeAll(loadScriptLua);

function inspect(input: MasterScript) {
  const workspace = new Blockly.Workspace();
  try {
    loadScriptGraph(input.graph, workspace);
    const graph = graphOf(workspace);
    return { graph, ...inspectScriptDraft(workspace, graph) };
  } finally { workspace.dispose(); }
}

it('executes the copied program and desktop plan with identical exact integers, checked errors and plain break', async () => {
  const read: ScriptBlock = { id: 'value', type: 'mb_variable', fields: { VARIABLE: 'value' } };
  const assign = (op: string, a: number, b: number): ScriptBlock => ({ id: 'assign', type: 'mb_set_var', fields: { VARIABLE: 'value' },
    inputs: { OPERAND: pin({ id: 'formula', type: 'mb_arithmetic', fields: { OP: op, A: a, B: b } }) } });
  const branch = (operand: ScriptBlock, op: string, rhs: number): ScriptBlock => ({ id: 'branch', type: 'mb_if', extraState: { elseIfCount: 0, hasElse: true },
    inputs: { CONDITION: pin({ id: 'test', type: 'mb_compare_values', fields: { OP: op, B: rhs }, inputs: { A: pin(operand) } }),
      YES: pin(log('ALARM')), NO: pin(log('NORMAL')) } });
  const cases: [MasterScript, string][] = [
    [script(chain(start, assign('add', 9007199254740991, 2), branch(read, 'gt', 9007199254740992))), 'ALARM'],
    [script(chain(start, assign('divide', 1, 0), log('unreached'))), '除数不能为零'],
    [script(chain(start, branch({ id: 'flag', type: 'mb_boolean', fields: { BOOL: 'FALSE' } }, 'eq', 0))), '比较两侧的值类型不一致'],
    [script(chain(start, { id: 'if', type: 'mb_if', inputs: {
      CONDITION: pin({ id: 'call', type: 'mb_call_value', fields: { FUNCTION: 'zero' } }), YES: pin(log('wrong')) } }),
      { id: 'zero', type: 'mb_function', fields: { NAME: 'zero', RESULT: 0 } }), '条件需要布尔值'],
    [script(chain(start, { id: 'loop', type: 'mb_repeat', fields: { COUNT: 2 }, inputs: { BODY: pin({ id: 'break', type: 'mb_break' }) } }, log('finished'))), 'finished'],
    [script(chain(start, { id: 'loop', type: 'mb_repeat', fields: { COUNT: 2 }, inputs: { BODY: pin({ id: 'try', type: 'mb_try',
      inputs: { BODY: pin({ id: 'break', type: 'mb_break' }), ERROR: pin(log('wrong-handler')) } }) } }, log('finished'))), 'finished'],
    [script(chain(start, { id: 'try', type: 'mb_try', inputs: { BODY: pin(assign('divide', 3, 0)), ERROR: pin(log('recovered')) } })), 'recovered'],
  ];
  for (const [input, expected] of cases) {
    const preview = inspect(input);
    expect(preview.issue).toBeNull();
    const engine = await factory.createEngine();
    const runner = local();
    try {
      engine.global.set('source', preview.source!.text);
      const copied = engine.doStringSync(`
        local printed
        local env = setmetatable({print=function(text) printed=text end}, {__index=_G})
        local ok, message = pcall(assert(load(source, "@copied", "t", env)))
        return ok and printed or message`);
      runner.start(runner.prepare(input)); await runner.settle();
      const actual = runner.snapshot!;
      expect(copied).toBe(expected);
      expect(actual.detail ?? actual.entries.find(e => e.log)?.detail).toBe(expected);
      if (expected === 'ALARM') expect(actual.variableScopes[0]?.values[0]?.value).toBe('9007199254740993');
    } finally { runner.stop(); await runner.settle(); engine.global.close(); }
  }
});

it('keeps wide integer literals and checked log values through editing, native execution and copy', async () => {
  const precise: ScriptBlock = { id: 'large', type: 'mb_number', fields: { NUM: '9007199254740993' } };
  const missing: ScriptBlock = { id: 'unset', type: 'mb_variable', fields: { VARIABLE: 'unassigned' } };
  const formula: ScriptBlock = { id: 'bad', type: 'mb_arithmetic', fields: { OP: 'divide', A: 1, B: 0 } };
  const inputs = [precise, missing, formula].map((block, i): ScriptBlock => ({ ...log('log-' + i), fields: { TEXT: '' }, inputs: { OPERAND: pin(block) } }));
  const data = script(chain(start, ...inputs, log('done')));
  const p = inspect(data);
  const vm = await factory.createEngine();
  const runner = local();
  try {
    vm.global.set('source', p.source!.text);
    const result = vm.doStringSync(`local log = {}
      local env = setmetatable({print = function(value) log[#log+1] = tostring(value) end}, {__index = _G})
      assert(load(source, '@copy', 't', env))()
      return table.concat(log, '\\n')`);
    runner.start(runner.prepare({ ...data, graph: p.graph })); await runner.settle();
    const rows = runner.snapshot!.entries.filter(e => e.log).map(e => e.detail);
    expect(rows).toEqual(['9007199254740993', '变量「unassigned」尚未赋值', '除数不能为零', 'done']);
    expect(result).toBe(rows.join('\n'));
  } finally { runner.stop(); await runner.settle(); vm.global.close(); }
});

it('uses the same model for numeric timer selectors, defaults, capacity, and callback context', () => {
  const types = ['mb_timer_start', 'mb_timer_stop', 'mb_on_timer', 'mb_timer_elapsed', 'mb_timer_running'] as const;
  for (const type of types) for (const channel of [7, '7']) {
    const saved = masterScriptSchema.parse(script({ id: 'timer', type, fields: { TIMER: channel } }));
    expect(saved.graph.blocks!.blocks[0]?.fields?.TIMER).toBe('7');
    expect(inspect(saved).graph.blocks!.blocks[0]?.fields?.TIMER).toBe('7');
  }
  const old = script(chain(start, { id: 'delay', type: 'mb_delay' }));
  expect(compileScriptProgram(old.graph).steps[0]).toMatchObject({ kind: 'delay', ms: 500 });
  expect(inspect(old).source?.text).toContain('modbus.delay(500)');
  expect(inspect(script(chain(cycle, { id: 'bad', type: 'mb_delay' }))).issue).toMatchObject({ blockId: 'bad' });
  const large = script(chain(start, ...Array.from({ length: 180 }, (_, i) => ({ ...log(String(i)), fields: { TEXT: '测'.repeat(1000) } }))));
  const text = serializeScriptFile(large);
  expect(Buffer.byteLength(text)).toBeLessThan(1_000_000);
  expect(scriptFileSchema.parse(JSON.parse(text)).graph).toEqual(large.graph);
  const tooMany = script(chain(start, ...Array.from({ length: 200 }, (_, i) => log('row' + i))));
  expect(inspect(tooMany).issue?.message).toContain('200');
  expect(masterScriptSchema.safeParse(tooMany).success).toBe(false);
});

it('publishes script revisions and deletes only after the atomic replace succeeds', async () => {
  const root = createScratch('script-save-');
  const service = new WorkspaceService(root);
  service.adopt(emptyWorkspace(), null);
  const manager = new RuntimeManager(service, await HistoryStore.open(path.join(root, 'history.db')));
  manager.start();
  try {
    const input = script(chain(start, log('before')));
    const save = (name: string, expectedRevision: number | null) => manager.handleCommand({ type: 'script.save', script: { ...input, name }, expectedRevision });
    expect((await save('before', null)).ok).toBe(true);
    const original = fs.readFileSync(service.currentPath!, 'utf8');
    const revision = service.revision;
    const lock = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw Error('workspace busy'); });
    try {
      expect((await save('after', 0)).ok).toBe(false);
      expect((await manager.handleCommand({ type: 'script.delete', scriptId: input.id, expectedRevision: 0 })).ok).toBe(false);
      expect((await manager.handleCommand({ type: 'script.start', scriptId: input.id, revision: 1 })).ok).toBe(false);
      expect(service.revision).toBe(revision);
      expect(service.current.masterScripts![0]).toMatchObject({ name: 'before', revision: 0 });
      expect(fs.readFileSync(service.currentPath!, 'utf8')).toBe(original);
    } finally { lock.mockRestore(); }
    expect(await save('after', 0)).toMatchObject({ ok: true, value: { name: 'after', revision: 1 } });
  } finally { await manager.stop(); }
});

it.each(['pause', 'step'])('settles a dispatched write before the %s checkpoint while on_run is due', async mode => {
  let ack!: () => void;
  let sent!: () => void;
  const onWire = new Promise<void>(resolve => { sent = resolve; });
  const runner = new MasterScriptRunner({ point: ref => ({ ref, blockKey: 's', span: { offset: 0, length: 1 }, label: 'setpoint',
    identity: 'setpoint', type: 'UInt16', highRisk: false, read: unused, validateWrite() {} }), slave: unused,
    write: () => new Promise(resolve => { ack = () => resolve({ phase: 'confirmed', result: 'ok', exceptionCode: null }); sent(); }) }, new RuntimeNotifications());
  const flow = script(chain(start, { id: 'write', type: 'mb_write', fields: { POINT: '["s","p"]', VALUE: '40' } }, log('after-write')), chain(cycle, log('tick')));
  if (mode === 'step') flow.graph.breakpoints = ['write'];
  try {
    const view = runner.start(runner.prepare(flow));
    if (mode === 'step') runner.resume(view.id, runner.snapshot!.pause!.token, 'step');
    await onWire;
    if (mode === 'pause') runner.pause(view.id);
    await delay(45);
    expect(runner.snapshot?.state).not.toBe('paused'); expect(runner.snapshot?.completed).toBe(0);
    ack();
    await expect.poll(() => runner.snapshot?.state).toBe('paused');
    expect(runner.snapshot?.current?.blockId).toBe('after-write');
    expect(runner.snapshot?.entries).toMatchObject([{ blockId: 'write', result: 'ok' }]);
  } finally { ack?.(); runner.stop(); await runner.settle(); }
});

it('observes elapsed-time thresholds at the logical deadline across a short timer rollover', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
  const runner = local();
  try {
    const elapsed: ScriptBlock = { id: 'elapsed', type: 'mb_timer_elapsed', fields: { TIMER: 0 } };
    const check: ScriptBlock = { id: 'check', type: 'mb_compare_values', fields: { OP: 'ge', B: 8 }, inputs: { A: pin(elapsed) } };
    runner.start(runner.prepare(script(chain(start, { id: 'arm', type: 'mb_timer_start', fields: { TIMER: 0, PERIOD: 10, MODE: 'loop' } },
      { id: 'wait', type: 'mb_wait', fields: { TIMEOUT: 100 }, inputs: { CONDITION: pin(check) } },
      { id: 'off', type: 'mb_timer_stop', fields: { TIMER: 0 } }, log('matched')))));
    await turn(); await vi.advanceTimersByTimeAsync(110); await turn(); await turn();
    expect(runner.snapshot?.state).toBe('passed');
    expect(runner.snapshot?.entries.at(-1)?.detail).toBe('matched');
  } finally { runner.stop(); await runner.settle(); vi.useRealTimers(); }
});
