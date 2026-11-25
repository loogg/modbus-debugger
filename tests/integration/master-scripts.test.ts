import fs from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { compileMasterScript, scriptBlocks, scriptFileSchema, scriptPointKey, type MasterScript, type ScriptBlock, type ScriptGraph } from '../../src/domain/master-script';
import { workspaceSchema } from '../../src/domain/model';
import { buildTcpAdu, encodeResponsePdu } from '../../src/domain/protocol';
import { RuntimeManager } from '../../src/main/runtime/manager';
import { MasterScriptRunner } from '../../src/main/runtime/master-script-runner';
import { RuntimeNotifications } from '../../src/main/runtime/runtime-notifications';
import { HistoryStore } from '../../src/main/services/history';
import { WorkspaceService } from '../../src/main/services/workspace';
import type { ScriptApprovalView } from '../../src/shared/script-run';
import { createScratch } from '../../tools/test-paths.mjs';
import { FakeTransport } from '../support/fake';
import { templateWorkspace } from '../support/template-workspace';

const reference = { slaveId: 's1', pointId: 'Keep' };
const POINT = scriptPointKey(reference);
const read: ScriptBlock = { type: scriptBlocks.read, id: 'read', fields: { POINT, TIMEOUT: 800 } };
const write: ScriptBlock = { type: scriptBlocks.write, id: 'write', fields: { POINT, VALUE: '44' } };
const capture: ScriptBlock = { type: scriptBlocks.readVariable, id: 'capture', fields: { POINT, VARIABLE: ' 初值 ' } };
const compareVariable: ScriptBlock = { type: scriptBlocks.compareVariable, id: 'compare-var', fields: { POINT, OP: 'gt', VARIABLE: '初值' } };
const assertCondition = (condition: ScriptBlock): ScriptBlock => ({
  type: scriptBlocks.assert, id: 'check',
  inputs: { CONDITION: { block: condition } },
});
const assertValue = (value: string) => assertCondition({ type: scriptBlocks.compare, id: 'predicate', fields: { POINT, OP: 'eq', VALUE: value } });
const graphFor = (...steps: ScriptBlock[]): ScriptGraph => {
  let next: ScriptBlock | undefined;
  for (const block of steps.slice().reverse()) next = { ...block, ...(next ? { next: { block: next } } : {}) };
  return { blocks: { languageVersion: 0, blocks: [{ type: scriptBlocks.start, id: 'entry', ...(next ? { next: { block: next } } : {}) }] } };
};
const scriptDef = (graph: ScriptGraph): MasterScript => ({ id: 'demo', name: '验证转速', revision: 0, graph });

const counter = '超限次数';
const counterValue: ScriptBlock = { id: 'counter-value', type: 'mb_variable', fields: { VARIABLE: counter } };
const setCounter: ScriptBlock = { id: 'set', type: 'mb_set_var', fields: { VARIABLE: counter, OPERAND: 3 } };
const changeCounter: ScriptBlock = { id: 'change', type: 'mb_change_var', fields: { VARIABLE: counter, OPERAND: 1 } };

function localRunner() {
  const unused = (): never => { throw new Error('本流程只操作运行变量'); };
  return new MasterScriptRunner({ point: unused, slave: unused, write: unused }, new RuntimeNotifications());
}

it('passes parameters by value through nested functions, steps into a procedure, and restores caller locals', async () => {
  const parameter = (id: string): ScriptBlock => ({ type: 'mb_parameter', id, fields: { PARAM: '0' } });
  const get = (id: string): ScriptBlock => ({ type: 'mb_variable', id, fields: { VARIABLE: '温度' } });
  const doubled: ScriptBlock = { type: 'mb_function', id: 'double', fields: { NAME: '加倍', PARAMS: '温度' }, inputs: {
    RESULT: { block: { type: 'mb_arithmetic', id: 'times-two', fields: { B: 2, OP: 'multiply' }, inputs: { A: { block: parameter('x') } } } },
  } };
  const nested: ScriptBlock = { type: 'mb_function', id: 'nested', fields: { NAME: '再加一', PARAMS: '温度' }, inputs: {
    RESULT: { block: { type: 'mb_arithmetic', id: 'plus-one', fields: { OP: 'add', B: 1 },
      inputs: { A: { block: { type: 'mb_call_value', id: 'nested-double', fields: { FUNCTION: 'double' }, inputs: { ARG0: { block: parameter('inner') } } } } } } },
  } };
  const log: ScriptBlock = { id: 'inside', type: 'mb_log', fields: { TEXT: '函数结果' }, inputs: {
    OPERAND: { block: { id: 'compute', type: 'mb_call_value', fields: { FUNCTION: 'nested' }, inputs: { ARG0: { block: parameter('v') } } } },
  }, next: { block: { id: 'local', type: 'mb_set_var', fields: { VARIABLE: '温度', OPERAND: 99 } } } };
  const procedure: ScriptBlock = { id: 'proc', type: 'mb_procedure', fields: { NAME: '记录', PARAMS: '温度' }, inputs: { BODY: { block: log } } };
  const graph = graphFor({ ...setCounter, fields: { VARIABLE: '温度', OPERAND: 8 } },
    { type: 'mb_call', id: 'invoke', fields: { FUNCTION: 'proc', ARG0: 4 } },
    { type: 'mb_log', id: 'outside', fields: { TEXT: '主流程' }, inputs: { OPERAND: { block: get('outer') } } });
  graph.blocks!.blocks.push(doubled, nested, procedure);
  graph.breakpoints = ['invoke'];
  const runner = localRunner();
  const run = runner.start(runner.prepare(scriptDef(graph)));
  await expect.poll(() => runner.snapshot?.state).toBe('paused');
  expect(runner.resume(run.id, runner.snapshot!.pause!.token, 'step')).toBe(true);
  await expect.poll(() => runner.snapshot?.current?.blockId).toBe('inside');
  expect(runner.snapshot?.pause?.variables).toEqual([{ name: '温度', value: '4' }]);
  const pausedScopes = runner.snapshot!.variableScopes;
  expect(pausedScopes).toEqual([
    { functionId: null, inCall: false, values: [{ name: '温度', value: 8 }] },
    { functionId: 'proc', inCall: true, values: [{ name: '温度', value: 4 }] },
  ]);
  expect(runner.resume(run.id, runner.snapshot!.pause!.token, 'continue')).toBe(true);
  await runner.settle();
  expect(runner.snapshot?.state).toBe('passed');
  expect(runner.snapshot?.entries.filter(row => row.log).map(row => row.detail)).toEqual(['函数结果 9', '主流程 8']);
  expect(runner.snapshot?.variableScopes).toEqual([
    pausedScopes[0], { functionId: 'proc', inCall: false, values: [{ name: '温度', value: 99 }] },
    { functionId: 'nested', inCall: false, values: [{ name: '温度', value: 4 }] },
    { functionId: 'double', inCall: false, values: [{ name: '温度', value: 4 }] },
  ]);
  expect(pausedScopes[1]!.values[0]!.value).toBe(4);
  const restarted = runner.start(runner.prepare(scriptDef(graph)), undefined, true);
  expect(restarted.variableScopes).toEqual([]);
  runner.stop(restarted.id);
  await runner.settle();
});

it('publishes confirmed zero, false and empty text as distinct typed watch values', async () => {
  const samples = { number: 0, flag: false, text: '' } as const;
  const unused = (): never => { throw new Error('unexpected device operation'); };
  const runner = new MasterScriptRunner({
    point: ref => {
      const key = ref.pointId as keyof typeof samples;
      return { ref, blockKey: 'data', span: { offset: 0, length: 1 }, label: key, highRisk: false,
        type: key === 'flag' ? 'Bool' : key === 'text' ? 'String' : 'UInt16', identity: key,
        validateWrite: unused, read: () => ({ value: samples[key], detail: String(samples[key]) }) };
    },
    slave: unused, write: unused,
  }, new RuntimeNotifications());
  const reads = Object.keys(samples).map(key => ({ ...capture, id: key,
    fields: { VARIABLE: key, POINT: scriptPointKey({ slaveId: 's1', pointId: key }) } }));
  runner.start(runner.prepare(scriptDef(graphFor(...reads))));
  await runner.settle();
  expect(runner.snapshot?.variableScopes).toEqual([{ functionId: null, inCall: false,
    values: [{ name: 'number', value: 0 }, { name: 'flag', value: false }, { name: 'text', value: '' }] }]);
});

it('detects duplicate names, stale references, parameter misuse, recursive calls and excessive expanded work', () => {
  const invoke = (id: string, fn: string): ScriptBlock => ({ type: 'mb_call', id, fields: { FUNCTION: fn } });
  const graph = graphFor(invoke('entry-call', 'a'));
  const a: ScriptBlock = { id: 'a', type: 'mb_procedure', fields: { NAME: 'A' }, inputs: { BODY: { block: invoke('a-b', 'b') } } };
  const b: ScriptBlock = { id: 'b', type: 'mb_procedure', fields: { NAME: 'B' }, inputs: { BODY: { block: invoke('b-a', 'a') } } };
  graph.blocks!.blocks.push(a, b);
  expect(() => compileMasterScript(graph)).toThrow('递归调用');
  b.fields!.NAME = 'A';
  expect(() => compileMasterScript(graph)).toThrow('重复');
  b.fields!.NAME = 'B'; b.fields!.PARAMS = 'x，x';
  expect(() => compileMasterScript(graph)).toThrow('参数名');
  b.fields!.PARAMS = '';
  b.inputs!.BODY!.block = { id: 'loop', type: 'mb_repeat', fields: { COUNT: 100 },
    inputs: { BODY: { block: { id: 'delay', type: 'mb_delay', fields: { MS: 0 } } } } };
  a.inputs!.BODY!.block = { id: 'outer-loop', type: 'mb_repeat', fields: { COUNT: 20 }, inputs: { BODY: { block: invoke('inner-call', 'b') } } };
  expect(() => compileMasterScript(graph)).toThrow('最多执行');
  expect(() => compileMasterScript(graphFor(invoke('missing', 'b')))).toThrow('请选择存在');
  expect(() => compileMasterScript(graphFor({ ...setCounter, inputs: { OPERAND: { block: { id: 'orphan', type: 'mb_parameter', fields: { PARAM: '0' } } } } }))).toThrow('当前函数的参数');
});

it('collects point dependencies from a calculation and wakes a wait when a new confirmed reading arrives', async () => {
  const notifications = new RuntimeNotifications();
  let temperature: number | undefined;
  const runner = new MasterScriptRunner({
    point: ref => ({ ref, blockKey: 'telemetry', span: { offset: 0, length: 1 }, label: '温度', type: 'UInt16',
      highRisk: false, identity: 'temp', validateWrite() {}, read: () => ({ value: temperature, detail: temperature === undefined ? '等待采样' : String(temperature) }) }),
    slave: () => ({ label: '设备', state: () => 'online' }), write: async () => { throw new Error('意外写入'); },
  }, notifications);
  const graph = graphFor({ id: 'wait', type: 'mb_wait', fields: { TIMEOUT: 2000 }, inputs: {
    CONDITION: { block: { id: 'invoke', type: 'mb_call_value', fields: { FUNCTION: 'hot' } } },
  } });
  graph.blocks!.blocks.push({ id: 'hot', type: 'mb_function', fields: { NAME: '温度达标' }, inputs: {
    RESULT: { block: { type: 'mb_compare', id: 'compare', fields: { POINT, OP: 'ge', VALUE: 70 } } },
  } });
  runner.start(runner.prepare(scriptDef(graph)));
  expect(runner.snapshot?.state).toBe('running');
  temperature = 69;
  notifications.publish({ kind: 'sample', blockKey: 'telemetry', range: { offset: 0, length: 1 } });
  expect(runner.snapshot?.judgments.compare?.matched).toBe(false);
  temperature = 74;
  notifications.publish({ kind: 'sample', blockKey: 'telemetry', range: { offset: 0, length: 1 } });
  await runner.settle();
  expect(runner.snapshot).toMatchObject({ state: 'passed', judgments: { compare: { matched: true } } });
});

it('plans only reachable high-risk device writes and confirms the bound argument before sending', async () => {
  const sent: number[] = [];
  const runner = new MasterScriptRunner({
    point: ref => ({ ref, blockKey: 'control', span: { offset: 0, length: 1 }, label: '给定值', type: 'UInt16',
      highRisk: true, identity: 'target', validateWrite() {}, read: () => ({ value: 0, detail: '0' }) }),
    slave: () => ({ label: '设备', state: () => 'online' }),
    write: async (_ref, fields) => { sent.push(fields.engineering!); return { phase: 'confirmed', result: 'ok', exceptionCode: null }; },
  }, new RuntimeNotifications());
  const graph = graphFor({ type: 'mb_call', id: 'invoke', fields: { FUNCTION: 'send', ARG0: 37 } });
  graph.blocks!.blocks.push({ id: 'send', type: 'mb_procedure', fields: { NAME: '发送', PARAMS: '数值' }, inputs: {
    BODY: { block: { ...write, inputs: { OPERAND: { block: { type: 'mb_parameter', id: 'input', fields: { PARAM: '0' } } } } } },
  } }, { id: 'unused', type: 'mb_procedure', fields: { NAME: '其他写入' }, inputs: { BODY: { block: { ...write, id: 'unused-write' } } } });
  const plan = runner.prepare(scriptDef(graph));
  expect(plan.approval?.writes).toHaveLength(1);
  expect(() => runner.start(plan)).toThrow('确认');
  const view = runner.start(plan, plan.approval!.key);
  await expect.poll(() => runner.snapshot?.pendingWrite?.value).toBe('37');
  expect(sent).toEqual([]);
  expect(runner.confirmWrite(view.id, runner.snapshot!.pendingWrite!.token)).toBe(true);
  await runner.settle();
  expect(sent).toEqual([37]);
  expect(runner.snapshot?.state).toBe('passed');
});

it.each([['add', 8], ['subtract', 2], ['multiply', 15], ['divide', 5 / 3]] as const)(
  'evaluates %s using a runtime variable, then compares the stored result', async (operator, expected) => {
    const runner = localRunner();
    const expression: ScriptBlock = { type: 'mb_arithmetic', id: 'operation', fields: { A: 5, OP: operator }, inputs: { B: { block: counterValue } } };
    const setResult: ScriptBlock = { type: 'mb_set_var', id: 'result', fields: { VARIABLE: '结果' }, inputs: { OPERAND: { block: expression } } };
    const check = assertCondition({ type: 'mb_compare_values', id: 'equal', fields: { OP: 'eq', B: expected },
      inputs: { A: { block: { type: 'mb_variable', id: 'get-result', fields: { VARIABLE: '结果' } } } } });
    runner.start(runner.prepare(scriptDef(graphFor(setCounter, setResult, changeCounter, check))));
    await runner.settle();
    expect(runner.snapshot).toMatchObject({ state: 'passed', judgments: { equal: { matched: true } },
      entries: [{ detail: '变量「超限次数」 = 3' }, { detail: '变量「结果」 = ' + expected }, { detail: '变量「超限次数」 = 4' }, { result: 'ok' }] });
    runner.start(runner.prepare(scriptDef(graphFor(changeCounter))));
    await runner.settle();
    expect(runner.snapshot).toMatchObject({ state: 'failed', detail: expect.stringContaining('尚未赋值') });
  },
);

it.each([['divide', 0, '除数不能为零'], ['multiply', 1e308, '运算结果超出有限数值范围']] as const)(
  'recovers from %s without partially changing a variable', async (operator, rhs, error) => {
    const runner = localRunner();
    const invalid: ScriptBlock = { type: 'mb_arithmetic', id: 'invalid', fields: { OP: operator, A: 1e308, B: rhs } };
    const assignment = { ...setCounter, id: 'replace', inputs: { OPERAND: { block: invalid } } };
    const handle: ScriptBlock = { type: 'mb_log', id: 'handled', fields: { TEXT: '原值' }, inputs: { OPERAND: { block: counterValue } } };
    const attempt: ScriptBlock = { type: 'mb_try', id: 'try', inputs: { BODY: { block: assignment }, ERROR: { block: handle } } };
    runner.start(runner.prepare(scriptDef(graphFor(setCounter, attempt))));
    await runner.settle();
    expect(runner.snapshot?.state).toBe('passed');
    expect(runner.snapshot?.entries.slice(-2)).toMatchObject([{ blockId: 'replace', handled: true, detail: error }, { blockId: 'handled', detail: '原值 3' }]);
  },
);

it('rejects ordered boolean comparisons and increments on nonnumeric variables', async () => {
  const runner = localRunner();
  const setFlag: ScriptBlock = { ...setCounter, inputs: { OPERAND: { block: { id: 'flag', type: 'mb_boolean', fields: { BOOL: 'TRUE' } } } } };
  runner.start(runner.prepare(scriptDef(graphFor(setFlag, changeCounter))));
  await runner.settle();
  expect(runner.snapshot).toMatchObject({ state: 'failed', detail: expect.stringContaining('有限数值') });
  const check = assertCondition({ id: 'cmp', type: 'mb_compare_values', fields: { OP: 'gt' },
    inputs: { A: { block: counterValue }, B: { block: { id: 'false', type: 'mb_boolean', fields: { BOOL: 'FALSE' } } } } });
  runner.start(runner.prepare(scriptDef(graphFor(setFlag, check))));
  await runner.settle();
  expect(runner.snapshot).toMatchObject({ state: 'failed', detail: expect.stringContaining('大小比较需要两个数值') });
});

async function setup(highRisk = false) {
  const root = createScratch('master-scripts-');
  const service = new WorkspaceService(root);
  const fixture = templateWorkspace();
  const point = fixture.templates[0]!.points.find(item => item.id === reference.pointId)!;
  fixture.templates = [{ ...fixture.templates[0]!, blocks: [{ id: 'b2', name: '控制', start: 6, area: 3, length: 1, periodMs: 30 }], points: [{ ...point, highRisk }] }];
  fixture.slaves = [{ ...fixture.slaves[0]!, enabled: true }];
  fixture.trendGroups = [];
  fixture.connections[0] = { ...fixture.connections[0]!, timeoutMs: 100, retries: 0, reconnect: 'manual' };
  service.adopt(workspaceSchema.parse(fixture), null);
  const transport = new FakeTransport('tcp');
  let word = 17;
  transport.onResponse(adu => {
    if (adu[6] !== 1) return null;
    if (adu[7] === 6) { word = (adu[10]! << 8) | adu[11]!; return [adu]; }
    return [buildTcpAdu((adu[0]! << 8) | adu[1]!, 1, encodeResponsePdu({ kind: 'registers', fc: 3, registers: [word] }))];
  });
  const manager = new RuntimeManager(service, await HistoryStore.open(path.join(root, 'history.db')), { transportFactory: () => transport });
  manager.start();
  return { root, service, manager, transport };
}

it('saves, exports, approves, and runs the configured device steps over the existing scheduler', async () => {
  const h = await setup(true);
  try {
    const script = scriptDef(graphFor(read, write, { ...read, id: 'read-back' }, assertValue('44')));
    const saved = await h.manager.handleCommand({ type: 'script.save', script, expectedRevision: null });
    expect(saved).toMatchObject({ ok: true, value: { revision: 0 } });
    expect(await h.manager.handleCommand({ type: 'script.save', script, expectedRevision: 99 })).toMatchObject({ ok: false });
    const savedWorkspace = workspaceSchema.parse(JSON.parse(fs.readFileSync(h.service.currentPath!, 'utf8')));
    expect(savedWorkspace.masterScripts).toEqual([script]);
    const file = path.join(h.root, 'share.modbus-script.json');
    expect(await h.manager.handleCommand({ type: 'script.exportFile', scriptId: script.id, path: file })).toMatchObject({ ok: true });
    expect(scriptFileSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8'))).graph).toEqual(script.graph);

    const params = { scriptId: script.id, revision: 0 };
    expect(await h.manager.handleCommand({ type: 'script.start', ...params })).toMatchObject({ ok: false });
    expect(h.transport.sent.some(frame => frame[7] === 6)).toBe(false);
    const plan = await h.manager.handleCommand({ type: 'script.plan', ...params });
    expect(plan).toMatchObject({ ok: true, value: { writes: [{ target: expect.stringContaining('Keep'), value: '44' }] } });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const deltas: string[] = [];
    h.manager.onDelta = delta => { if (delta.scriptRun) deltas.push(delta.scriptRun.state); };
    expect(await h.manager.handleCommand({ type: 'script.start', ...params, approval: (plan.value as ScriptApprovalView).key })).toMatchObject({ ok: true });
    await expect.poll(() => h.manager.buildSnapshot().scriptRun?.state).toBe('passed');
    expect(h.manager.buildSnapshot().scriptRun?.entries).toMatchObject([
      { blockId: 'read', detail: '17' },
      { blockId: 'write', detail: expect.stringContaining('写入应答成功') },
      { blockId: 'read-back', detail: '44' },
      { blockId: 'check', detail: expect.stringContaining('当前值 44') },
    ]);
    await expect.poll(() => deltas).toContain('passed');
    expect(h.transport.sent.filter(frame => frame[7] === 6)).toHaveLength(1);
  } finally { await h.manager.stop(); }
});

it('stores confirmed values by name, compares after an explicit new sample, and clears variables for each run', async () => {
  const h = await setup();
  try {
    const check = assertCondition(compareVariable);
    const overwrite = { ...capture, id: 'overwrite' };
    const equal = { ...assertCondition({ ...compareVariable, id: 'equal-var', fields: { ...compareVariable.fields, OP: 'eq' } }), id: 'equal' };
    const script = scriptDef(graphFor(capture, write, read, check, overwrite, equal));
    await expect.poll(() => h.manager.buildSnapshot().points['s1::Keep']?.engNumber).toBe(17);
    expect(await h.manager.handleCommand({ type: 'script.save', script, expectedRevision: null })).toMatchObject({ ok: true });
    expect(await h.manager.handleCommand({ type: 'script.start', scriptId: script.id, revision: 0 })).toMatchObject({ ok: true });
    await expect.poll(() => h.manager.buildSnapshot().scriptRun?.state).toBe('passed');
    expect(h.manager.buildSnapshot().scriptRun?.entries).toMatchObject([
      { blockId: 'capture', detail: '变量「初值」 = 17' },
      { blockId: 'write', result: 'ok' },
      { blockId: 'read', detail: '44' },
      { blockId: 'check', detail: expect.stringContaining('当前值 44，预期大于变量「初值」（17）') },
      { blockId: 'overwrite', detail: '变量「初值」 = 44' },
      { blockId: 'equal', detail: expect.stringContaining('当前值 44，预期等于变量「初值」（44）') },
    ]);

    const missing = { ...scriptDef(graphFor(check)), id: 'missing-capture' };
    expect(await h.manager.handleCommand({ type: 'script.save', script: missing, expectedRevision: null })).toMatchObject({ ok: true });
    expect(await h.manager.handleCommand({ type: 'script.start', scriptId: missing.id, revision: 0 })).toMatchObject({ ok: true });
    await expect.poll(() => h.manager.buildSnapshot().scriptRun).toMatchObject({
      state: 'failed', entries: [{ blockId: 'check', detail: '变量「初值」尚未赋值' }],
    });
    expect(h.transport.sent.filter(frame => frame[7] === 6)).toHaveLength(1);
  } finally { await h.manager.stop(); }
});

it('captures and evaluates every point comparison from the latest confirmed value with no new sample notification', async () => {
  const feedback = { slaveId: 's1', pointId: 'Feedback' };
  const runner = new MasterScriptRunner({
    point: ref => {
      const isFeedback = ref.pointId === feedback.pointId;
      return {
        ref, blockKey: 's1::b2', span: { offset: isFeedback ? 1 : 0, length: 1 }, label: ref.pointId,
        type: 'UInt16', highRisk: false, identity: ref.pointId, validateWrite() {},
        read: () => isFeedback ? { value: 42, detail: '42' } : { value: 17, detail: '17' },
      };
    },
    slave: () => ({ label: '设备', state: () => 'online' }),
    write: async () => ({ phase: 'confirmed', exceptionCode: null, result: 'ok' }),
  }, new RuntimeNotifications());
  const compareFeedback = { ...compareVariable, fields: { ...compareVariable.fields, POINT: scriptPointKey(feedback) } };
  const range: ScriptBlock = { id: 'range', type: scriptBlocks.range, fields: { POINT, MIN: 17, MAX: 17 } };
  const rangeCheck = { ...assertCondition(range), id: 'check-range' };
  const literalCheck = { ...assertValue('17'), id: 'check-literal' };
  const script = scriptDef(graphFor(capture, write, assertCondition(compareFeedback), rangeCheck, literalCheck));
  runner.start(runner.prepare(script));
  await runner.settle();
  expect(runner.snapshot).toMatchObject({ state: 'passed', entries: [
    { blockId: 'capture', detail: '变量「初值」 = 17' },
    { blockId: 'write', result: 'ok' },
    { blockId: 'check', detail: 'Feedback 当前值 42，预期大于变量「初值」（17）' },
    { blockId: 'check-range', result: 'ok' },
    { blockId: 'check-literal', result: 'ok' },
  ] });
});

it('removes an unsent script write from a busy connection queue when stopped', async () => {
  const h = await setup();
  try {
    const runtime = h.manager.runtimeFor('c1')!;
    await expect.poll(() => runtime.state).toBe('online');
    const scan = runtime.scanUnits({ from: 8, to: 9 }, { timeoutMs: 140, retries: 0 });
    await expect.poll(() => runtime.scan?.currentUnit).toBe(8);
    const script = scriptDef(graphFor(write));
    await h.manager.handleCommand({ type: 'script.save', script, expectedRevision: null });
    expect(await h.manager.handleCommand({ type: 'script.start', scriptId: script.id, revision: 0 })).toMatchObject({ ok: true });
    const run = h.manager.buildSnapshot().scriptRun!;
    expect(run.current?.blockId).toBe('write');
    await h.manager.handleCommand({ type: 'script.stop', runId: run.id });
    await expect.poll(() => h.manager.buildSnapshot().scriptRun?.state).toBe('stopped');
    await scan;
    expect(h.transport.sent.some(frame => frame[7] === 6)).toBe(false);
  } finally { await h.manager.stop(); }
});

it('disarms event callbacks when a different workspace is opened', async () => {
  const h = await setup();
  try {
    const graph = graphFor({ id: 'arm', type: 'mb_timer_start', fields: { TIMER: 0, PERIOD: 30, MODE: 'loop' } });
    graph.blocks!.blocks.push({ id: 'event', type: 'mb_on_timer', fields: { TIMER: 0 }, next: { block: write } });
    const script = scriptDef(graph);
    expect(await h.manager.handleCommand({ type: 'script.save', script, expectedRevision: null })).toMatchObject({ ok: true });
    expect(await h.manager.handleCommand({ type: 'script.start', scriptId: script.id, revision: 0 })).toMatchObject({ ok: true });
    await expect.poll(() => h.transport.sent.some(frame => frame[7] === 6)).toBe(true);
    const target = path.join(h.root, 'new.workspace.json');
    fs.writeFileSync(target, JSON.stringify({ ...h.service.current, name: 'next', masterScripts: [] }));
    expect(await h.manager.handleCommand({ type: 'workspace.open', path: target })).toMatchObject({ ok: true });
    await expect.poll(() => h.manager.buildSnapshot().scriptRun?.state).toBe('stopped');
    const writes = h.transport.sent.filter(frame => frame[7] === 6).length;
    await new Promise(resolve => setTimeout(resolve, 90));
    expect(h.transport.sent.filter(frame => frame[7] === 6)).toHaveLength(writes);
    expect(h.manager.buildSnapshot().scriptRun?.events?.timers).toEqual([]);
  } finally { await h.manager.stop(); }
});

it('settles an already-sent write and stops before the next step', async () => {
  const h = await setup();
  try {
    let acknowledgement: Uint8Array | undefined;
    h.transport.onResponse(request => {
      if (request[7] === 6) { acknowledgement = request; return null; }
      return [buildTcpAdu((request[0]! << 8) | request[1]!, 1, encodeResponsePdu({ kind: 'registers', fc: 3, registers: [17] }))];
    });
    await expect.poll(() => h.manager.runtimeFor('c1')?.state).toBe('online');
    const script = scriptDef(graphFor(write, { ...write, id: 'second' }));
    expect(await h.manager.handleCommand({ type: 'script.save', script, expectedRevision: null })).toMatchObject({ ok: true });
    expect(await h.manager.handleCommand({ type: 'script.start', scriptId: script.id, revision: 0 })).toMatchObject({ ok: true });
    await expect.poll(() => acknowledgement, { interval: 5 }).toBeTruthy();
    const runId = h.manager.buildSnapshot().scriptRun!.id;
    await h.manager.handleCommand({ type: 'script.stop', runId });
    expect(h.manager.buildSnapshot().scriptRun?.state).toBe('stopping');
    h.transport.inject(acknowledgement!);
    await expect.poll(() => h.manager.buildSnapshot().scriptRun?.state).toBe('stopped');
    expect(h.manager.buildSnapshot().scriptRun?.entries).toMatchObject([{ blockId: 'write', result: 'ok', detail: expect.stringContaining('写入应答成功') }]);
    expect(h.transport.sent.filter(frame => frame[7] === 6)).toHaveLength(1);
  } finally { await h.manager.stop(); }
});

it('requires the explicitly awaited point to be fully covered by a new sample after writing', async () => {
  let writes = 0;
  const notifications = new RuntimeNotifications();
  const runner = new MasterScriptRunner({
    point: ref => ({
      ref, blockKey: 's1::b2', span: { offset: 1, length: 1 }, label: '保持寄存器', type: 'UInt16',
      highRisk: false, identity: 'bind', validateWrite() {},
      read: () => ({ value: 17, detail: '17' }),
    }),
    slave: () => ({ label: '设备', state: () => 'online' }),
    write: async () => { writes++; return { phase: 'confirmed', exceptionCode: null, result: 'ok' }; },
  }, notifications);
  const feedback = { ...read, id: 'read-back', fields: { POINT, TIMEOUT: 160 } };
  const script = scriptDef(graphFor(read, write, feedback, assertValue('17'), { ...write, id: 'later-write' }));
  runner.start(runner.prepare(script));
  notifications.publish({ kind: 'sample', blockKey: 's1::b2', range: { offset: 1, length: 1 } });
  await expect.poll(() => runner.snapshot?.current?.blockId, { interval: 5 }).toBe('read-back');
  notifications.publish({ kind: 'sample', blockKey: 's1::b2', range: { offset: 3, length: 1 } });
  await runner.settle();
  expect(runner.snapshot).toMatchObject({ state: 'failed', detail: expect.stringContaining('等待点位的新确认值') });
  expect(writes).toBe(1);
});

it('reacts to the matching sample in the same turn and releases its timer and subscriptions on every exit', async () => {
  vi.useFakeTimers();
  try {
    const notifications = new RuntimeNotifications();
    let current = 0;
    let inspections = 0;
    const runner = new MasterScriptRunner({
      point: ref => ({
        ref, blockKey: 's1::b2', span: { offset: 1, length: 2 }, label: '反馈', type: 'UInt32',
        highRisk: false, identity: 'feedback', validateWrite() {},
        read: () => { inspections++; return { value: current, detail: String(current) }; },
      }),
      slave: () => ({ label: '设备', state: () => 'online' }),
      write: async () => { throw new Error('Unexpected write'); },
    }, notifications);
    const wait: ScriptBlock = { ...assertValue('1'), type: scriptBlocks.wait, fields: { TIMEOUT: 500 } };
    const plan = runner.prepare(scriptDef(graphFor(wait)));
    const confirm = () => notifications.publish({ kind: 'sample', blockKey: 's1::b2', range: { offset: 0, length: 3 } });

    runner.start(plan);
    expect(inspections).toBe(1);
    await vi.advanceTimersByTimeAsync(150);
    notifications.publish({ kind: 'slaveState', slaveId: 's2' });
    notifications.publish({ kind: 'sample', blockKey: 's1::other', range: { offset: 0, length: 3 } });
    notifications.publish({ kind: 'sample', blockKey: 's1::b2', range: { offset: 1, length: 1 } });
    expect(inspections).toBe(1);
    current = 1;
    confirm();
    current = 0;
    confirm();
    await runner.settle();
    expect(inspections).toBe(2);
    expect(runner.snapshot).toMatchObject({ state: 'passed', entries: [{ detail: expect.stringContaining('当前值 1') }] });
    expect(vi.getTimerCount()).toBe(0);

    runner.start(plan);
    runner.stop();
    await runner.settle();
    expect(runner.snapshot?.state).toBe('stopped');
    expect(vi.getTimerCount()).toBe(0);
    confirm();
    expect(inspections).toBe(3);

    runner.start(plan);
    await vi.advanceTimersByTimeAsync(500);
    await runner.settle();
    expect(runner.snapshot).toMatchObject({ state: 'failed', detail: expect.stringContaining('等待超时') });
    const atTimeout = inspections;
    confirm();
    expect(inspections).toBe(atTimeout);
  } finally { vi.useRealTimers(); }
});

it('wakes a state-only wait when a slave stops responding and when its first valid answer returns', async () => {
  const h = await setup();
  try {
    await expect.poll(() => h.manager.buildSnapshot().slaveStates?.s1?.state).toBe('online');
    const waitFor = (state: string): ScriptBlock => ({
      id: state, type: scriptBlocks.wait, fields: { TIMEOUT: 2500 },
      inputs: { CONDITION: { block: { id: `state-${state}`, type: scriptBlocks.state, fields: { SLAVE: 's1', STATE: state } } } },
    });
    const script = scriptDef(graphFor(waitFor('offline'), waitFor('online'), read));
    expect(await h.manager.handleCommand({ type: 'script.save', script, expectedRevision: null })).toMatchObject({ ok: true });
    expect(await h.manager.handleCommand({ type: 'script.start', scriptId: script.id, revision: 0 })).toMatchObject({ ok: true });
    h.transport.onResponse(() => null);
    await expect.poll(() => h.manager.buildSnapshot().scriptRun?.current?.blockId, { timeout: 2500 }).toBe('online');
    expect(h.manager.runtimeFor('c1')?.state).toBe('online');
    h.transport.onResponse(adu => [buildTcpAdu((adu[0]! << 8) | adu[1]!, 1, encodeResponsePdu({ kind: 'registers', fc: 3, registers: [42] }))]);
    await expect.poll(() => h.manager.buildSnapshot().scriptRun?.state).toBe('passed');
    expect(h.manager.buildSnapshot().scriptRun?.entries).toMatchObject([
      { blockId: 'offline', detail: expect.stringContaining('当前离线') },
      { blockId: 'online', detail: expect.stringContaining('当前在线') },
      { blockId: 'read', detail: '42' },
    ]);
  } finally { await h.manager.stop(); }
});

it('combines unavailable and decisive operands without treating unavailable as false', async () => {
  const runner = new MasterScriptRunner({
    point: ref => ({
      ref, blockKey: 's1::b2', span: { offset: 0, length: 1 }, label: '保持寄存器', type: 'UInt16',
      highRisk: false, identity: 'bind', validateWrite() {}, read: () => ({ detail: '没有确认采样' }),
    }),
    slave: () => ({ label: '设备', state: () => 'online' }),
    write: async () => { throw new Error('Unexpected write'); },
  }, new RuntimeNotifications());
  const unavailable = assertValue('1').inputs!.CONDITION!.block!;
  const online: ScriptBlock = { id: 'online', type: scriptBlocks.state, fields: { SLAVE: 's1', STATE: 'online' } };
  const offline: ScriptBlock = { id: 'offline', type: scriptBlocks.state, fields: { SLAVE: 's1', STATE: 'offline' } };
  const combination = (type: typeof scriptBlocks.and | typeof scriptBlocks.or, left: ScriptBlock, right: ScriptBlock): ScriptBlock =>
    ({ id: type, type, inputs: { A: { block: left }, B: { block: right } } });
  const negate = (operand: ScriptBlock): ScriptBlock => ({ id: 'not', type: scriptBlocks.not, inputs: { CONDITION: { block: operand } } });
  const run = async (predicate: ScriptBlock) => {
    runner.start(runner.prepare(scriptDef(graphFor(assertCondition(predicate)))));
    await runner.settle();
    return runner.snapshot;
  };
  expect((await run(combination(scriptBlocks.or, unavailable, online)))?.state).toBe('passed');
  expect((await run(negate(combination(scriptBlocks.and, unavailable, offline))))?.state).toBe('passed');
  expect(await run(negate(unavailable))).toMatchObject({ state: 'failed', detail: expect.stringContaining('条件暂不可判定') });
  expect((await run(combination(scriptBlocks.or, online, compareVariable)))?.state).toBe('passed');
  expect(await run(combination(scriptBlocks.and, offline, compareVariable))).toMatchObject({ state: 'failed', detail: '设备 当前在线，预期离线' });
  const branch: ScriptBlock = { type: scriptBlocks.branch, id: 'branch', inputs: {
    CONDITION: { block: unavailable }, NO: { block: { type: scriptBlocks.delay, id: 'else', fields: { MS: 0 } } },
  } };
  runner.start(runner.prepare(scriptDef(graphFor(branch))));
  await runner.settle();
  expect(runner.snapshot).toMatchObject({ state: 'failed', entries: [{ blockId: 'branch', detail: expect.stringContaining('条件暂不可判定') }] });
  runner.start(runner.prepare(scriptDef(graphFor(capture))));
  await runner.settle();
  expect(runner.snapshot).toMatchObject({ state: 'failed', entries: [{ blockId: 'capture', detail: expect.stringContaining('没有确认采样') }] });
});

it('captures a false sample and rejects comparing it to a numeric point', async () => {
  const runner = new MasterScriptRunner({
    point: ref => ({
      ref, blockKey: 's1::b2', span: { offset: 0, length: 1 }, label: ref.pointId,
      type: ref.pointId === 'flag' ? 'Bool' : 'UInt16', highRisk: false, identity: 'bind', validateWrite() {},
      read: () => ref.pointId === 'flag' ? { value: false, detail: 'false' } : { value: 0, detail: '0' },
    }),
    slave: () => ({ label: '设备', state: () => 'online' }),
    write: async () => { throw new Error('Unexpected write'); },
  }, new RuntimeNotifications());
  const captureFlag = { ...capture, fields: { ...capture.fields, POINT: scriptPointKey({ slaveId: 's1', pointId: 'flag' }) } };
  runner.start(runner.prepare(scriptDef(graphFor(captureFlag, assertCondition(compareVariable)))));
  await runner.settle();
  expect(runner.snapshot).toMatchObject({ state: 'failed', entries: [
    { blockId: 'capture', detail: '变量「初值」 = false' },
    { blockId: 'check', detail: '变量「初值」与点位 Keep 的值类型不一致' },
  ] });
});

it('rejects unsupported, disconnected and over-expanded flows', () => {
  expect(() => compileMasterScript({ blocks: { languageVersion: 0, blocks: [...graphFor(write).blocks!.blocks, read] } })).toThrow('同一个');
  const delay: ScriptBlock = { type: scriptBlocks.delay, id: 'pause', fields: { MS: 1 } };
  const loop: ScriptBlock = { type: scriptBlocks.repeat, id: 'inner', fields: { COUNT: 100 }, inputs: { BODY: { block: delay } } };
  expect(() => compileMasterScript(graphFor({ ...loop, id: 'outer', inputs: { BODY: { block: loop } } }))).toThrow('1000');
  expect(scriptFileSchema.safeParse({ format: 'modbus-master-script', version: 1, name: 'bad', graph: { blocks: { languageVersion: 0, blocks: [{ type: 'other', id: 'x' }] } } }).success).toBe(false);
  expect(compileMasterScript(graphFor({ ...write, enabled: false }, read))).toEqual([{ kind: 'read', blockId: 'read', ref: reference, timeoutMs: 800 }]);
  expect(() => compileMasterScript(graphFor({ ...capture, fields: { ...capture.fields, VARIABLE: '  ' } }))).toThrow('变量名');
  const incomplete: ScriptBlock = { type: scriptBlocks.and, id: 'empty-and', inputs: { A: { block: compareVariable } } };
  expect(() => compileMasterScript(graphFor(assertCondition(incomplete)))).toThrow('请连接一个启用的条件积木');
});

it('handles an unacknowledged write, restores a captured value, and breaks out of the nearest loop', async () => {
  const h = await setup();
  try {
    await expect.poll(() => h.manager.buildSnapshot().points['s1::Keep']?.engNumber).toBe(17);
    let word = 17;
    h.transport.onResponse(adu => {
      if (adu[7] === 6) {
        word = adu[10]! * 256 + adu[11]!;
        return word === 44 ? null : [adu];
      }
      return [buildTcpAdu(adu[0]! * 256 + adu[1]!, 1, encodeResponsePdu({ kind: 'registers', fc: 3, registers: [word] }))];
    });
    const chain = (...steps: ScriptBlock[]) => graphFor(...steps).blocks!.blocks[0]!.next!;
    const restore: ScriptBlock = { ...write, id: 'restore', inputs: { OPERAND: { block: { id: 'variable', type: 'mb_variable', fields: { VARIABLE: '初值' } } } } };
    const branch: ScriptBlock = { id:'classify', type:'mb_if', fields: { BOOL_CONDITION:'FALSE' },
      extraState:{ elseIfCount:1, hasElse:true }, inputs:{
        YES: { block:{ type:'mb_stop', id:'wrong-arm' } },
        COND1: { block:{ type:'mb_error_is', id:'unknown', fields:{ CODE:'unknown' } } },
        YES1: chain(restore, read, { type:'mb_break', id:'leave' }), NO:{ block:{ type:'mb_stop', id:'wrong-else' } },
      } };
    const loop: ScriptBlock = { id:'loop', type:'mb_forever', inputs:{ BODY:{ block:{
      id:'attempt', type:'mb_try', inputs:{ BODY:chain(write, { ...write, id:'unreachable' }), ERROR:{ block:branch } },
    } } } };
    const script = scriptDef(graphFor(capture, loop, assertValue('17')));
    expect(await h.manager.handleCommand({ type:'script.save', script, expectedRevision:null })).toMatchObject({ ok:true });
    expect(await h.manager.handleCommand({ type:'script.start', scriptId:script.id, revision:0 })).toMatchObject({ ok:true });
    await expect.poll(() => h.manager.buildSnapshot().scriptRun?.state).toBe('passed');
    const run = h.manager.buildSnapshot().scriptRun!;
    expect(run.entries.map(entry => entry.blockId)).toEqual(['capture','loop','attempt','write','classify','restore','read','leave','check']);
    expect(run.entries[3]).toMatchObject({ result:'failed', handled:true, detail:expect.stringContaining('写入结果未知') });
    expect(run.judgments.unknown?.matched).toBe(true);
    expect(run.judgments.predicate).toMatchObject({ matched:true, samples:[{ timeMs:expect.any(Number) }] });
    expect(h.transport.sent.filter(frame => frame[7] === 6).map(frame => frame[11])).toEqual([44,17]);
  } finally { await h.manager.stop(); }
});

it('requires a fresh approval of the resolved value for high-risk dynamic writes, and cancels it on stop', async () => {
  const h = await setup(true);
  try {
    await expect.poll(() => h.manager.buildSnapshot().points['s1::Keep']?.engNumber).toBe(17);
    const dynamic: ScriptBlock = { ...write, inputs:{ OPERAND:{ block:{ id:'value', type:'mb_point_value', fields:{ POINT } } } } };
    const script = scriptDef(graphFor(dynamic, { id:'end', type:'mb_stop' }));
    await h.manager.handleCommand({ type:'script.save', script, expectedRevision:null });
    const request = { scriptId:script.id, revision:0 };
    const plan = await h.manager.handleCommand({ type:'script.plan', ...request });
    if (!plan.ok) throw new Error(plan.error);
    const start = () => h.manager.handleCommand({ type:'script.start', ...request, approval:(plan.value as ScriptApprovalView).key });
    await start();
    const first = h.manager.buildSnapshot().scriptRun!;
    expect(first.pendingWrite).toMatchObject({ value:'17' });
    expect(h.transport.sent.some(frame => frame[7] === 6)).toBe(false);
    await h.manager.handleCommand({ type:'script.stop', runId:first.id });
    await expect.poll(() => h.manager.buildSnapshot().scriptRun?.state).toBe('stopped');
    await start();
    const next = h.manager.buildSnapshot().scriptRun!;
    expect(await h.manager.handleCommand({ type:'script.confirmWrite', runId:next.id, token:first.pendingWrite!.token })).toMatchObject({ ok:false });
    expect(await h.manager.handleCommand({ type:'script.confirmWrite', runId:next.id, token:next.pendingWrite!.token })).toMatchObject({ ok:true });
    await expect.poll(() => h.manager.buildSnapshot().scriptRun?.state).toBe('stopped');
    expect(h.transport.sent.filter(frame => frame[7] === 6)).toHaveLength(1);
  } finally { await h.manager.stop(); }
});

it('yields a pure main loop to I/O and propagates stop through an error container', async () => {
  const runner = new MasterScriptRunner({
    point: () => { throw new Error('Unexpected point'); }, slave: () => { throw new Error('Unexpected slave'); },
    write: async () => { throw new Error('Unexpected write'); },
  }, new RuntimeNotifications());
  const condition: ScriptBlock = { id:'pass', type:'mb_assert', fields:{ BOOL_CONDITION:'TRUE' } };
  const loop: ScriptBlock = { id:'loop', type:'mb_forever', inputs:{ BODY:{block:condition} } };
  const attempt: ScriptBlock = { id:'try', type:'mb_try', inputs:{ BODY:{block:loop}, ERROR:{block:{id:'handler',type:'mb_stop'}} } };
  runner.start(runner.prepare(scriptDef(graphFor(attempt))));
  await new Promise(resolve => setTimeout(resolve, 12));
  runner.stop();
  await runner.settle();
  expect(runner.snapshot!.completed).toBeGreaterThan(2);
  expect(runner.snapshot!.entries.length).toBeLessThanOrEqual(250);
  expect(runner.snapshot!.entries.some(entry => entry.blockId === 'handler')).toBe(false);
  expect(runner.snapshot!.state).toBe('stopped');
});

it('checks repeat-until before entering each iteration and supports a boolean expression as the written value', async () => {
  let flag = false;
  const values: boolean[] = [];
  const runner = new MasterScriptRunner({
    point: ref => ({ ref,label:'开关',blockKey:'s1::flags',span:{offset:0,length:1},type:'Bool',identity:'flag',highRisk:false,
      read:()=>({value:flag,detail:String(flag)}), validateWrite() {} }),
    slave: () => ({label:'从站',state:()=>'online'}),
    write: async (_ref,fields) => { flag=fields.boolValue!; values.push(flag); return {phase:'confirmed',result:'ok',exceptionCode:null}; },
  },new RuntimeNotifications());
  const change: ScriptBlock = {...write,inputs:{OPERAND:{block:{id:'state',type:'mb_state',fields:{SLAVE:'s1',STATE:'online'}}}}};
  const loop: ScriptBlock = {id:'until',type:'mb_repeat_until',inputs:{
    CONDITION:{block:{id:'flag',type:'mb_point_value',fields:{POINT}}}, BODY:{block:change},
  }};
  const plan = runner.prepare(scriptDef(graphFor(loop)));
  runner.start(plan); await runner.settle();
  runner.start(plan); await runner.settle();
  expect(values).toEqual([true]);
  expect(runner.snapshot).toMatchObject({ state:'passed', completed:1, judgments:{flag:{matched:true}} });
});

it('pauses before a dynamic write, keeps polling, and sends only the inspected value after single-step and high-risk approval', async () => {
  const h = await setup(true);
  try {
    const snapshot = () => h.manager.buildSnapshot().scriptRun!;
    await expect.poll(() => h.manager.buildSnapshot().points['s1::Keep']?.engNumber).toBe(17);
    const dynamic = { ...write, inputs: { OPERAND: { block: { id: 'source', type: scriptBlocks.pointValue, fields: { POINT } } } } };
    const log: ScriptBlock = { id: 'log', type: 'mb_log', fields: { TEXT: '恢复值' },
      inputs: { OPERAND: { block: { id: 'saved', type: 'mb_variable', fields: { VARIABLE: '初值' } } } } };
    const script = scriptDef({ ...graphFor(capture, dynamic, log), breakpoints: ['write'] });
    await h.manager.handleCommand({ type: 'script.save', script, expectedRevision: null });
    const request = { scriptId: script.id, revision: 0 };
    const plan = await h.manager.handleCommand({ type: 'script.plan', ...request });
    if (!plan.ok) throw new Error(plan.error);
    await h.manager.handleCommand({ type: 'script.start', ...request, approval: (plan.value as ScriptApprovalView).key });
    await expect.poll(() => snapshot().state).toBe('paused');
    const before = snapshot();
    expect(before).toMatchObject({ current: { blockId: 'write' }, pause: { reason: 'breakpoint', writePreview: '17', variables: [{ name: '初值', value: '17' }] } });
    expect(await h.manager.handleCommand({ type: 'script.delete', scriptId: script.id, expectedRevision: 0 })).toMatchObject({ ok: false });
    h.transport.onResponse(adu => adu[7] === 6 ? [adu] : [buildTcpAdu(adu[0]! * 256 + adu[1]!, 1, encodeResponsePdu({ kind: 'registers', fc: 3, registers: [26] }))]);
    await expect.poll(() => h.manager.buildSnapshot().points['s1::Keep']?.engNumber).toBe(26);
    expect(h.transport.sent.filter(f => f[7] === 6)).toHaveLength(0);
    const command = { type: 'script.resume', runId: before.id, token: before.pause!.token, mode: 'step' } as const;
    expect(await h.manager.handleCommand(command)).toMatchObject({ ok: true });
    expect(await h.manager.handleCommand(command)).toMatchObject({ ok: false });
    await expect.poll(() => snapshot().pendingWrite?.value).toBe('17');
    expect(h.transport.sent.filter(f => f[7] === 6)).toHaveLength(0);
    await h.manager.handleCommand({ type: 'script.confirmWrite', runId: before.id, token: snapshot().pendingWrite!.token });
    await expect.poll(() => snapshot().pause?.reason).toBe('step');
    expect(snapshot().current?.blockId).toBe('log');
    expect(await h.manager.handleCommand(command)).toMatchObject({ ok: false });
    expect(h.transport.sent.filter(f => f[7] === 6).map(f => f[11])).toEqual([17]);
    expect(await h.manager.handleCommand({ ...command, token: snapshot().pause!.token, mode: 'continue' })).toMatchObject({ ok: true });
    await expect.poll(() => snapshot().state).toBe('passed');
    expect(snapshot().entries.at(-1)).toMatchObject({ blockId: 'log', log: true, atMs: expect.any(Number), detail: '恢复值 17' });
  } finally { await h.manager.stop(); }
});

it('steps into error handlers, re-arms breakpoints on loops, and cancels a pause without running its step', async () => {
  const runner = new MasterScriptRunner({
    point: () => { throw new Error('Unexpected point'); }, slave: () => { throw new Error('Unexpected slave'); },
    write: async () => { throw new Error('Unexpected write'); },
  }, new RuntimeNotifications());
  const graph = graphFor({ id: 'loop', type: 'mb_forever', inputs: { BODY: { block: { id: 'try', type: 'mb_try', inputs: {
    BODY: { block: { id: 'fail', type: 'mb_assert', fields: { BOOL_CONDITION: 'FALSE' } } },
    ERROR: { block: { id: 'caught', type: 'mb_log', fields: { TEXT: '已捕获' } } },
  } } } } });
  const initial = runner.start(runner.prepare(scriptDef(graph)), undefined, true);
  expect(initial.pause?.reason).toBe('entry');
  expect(runner.setBreakpoint(initial.id, 'loop', true)).toBe(true);
  expect(runner.setBreakpoint(initial.id, 'entry', true)).toBe(false);
  expect(runner.setBreakpoint(initial.id, 'caught', true)).toBe(true);
  const resume = () => runner.resume(initial.id, runner.snapshot!.pause!.token, 'continue');
  expect(resume()).toBe(true);
  await expect.poll(() => runner.snapshot?.current?.blockId).toBe('caught');
  expect(runner.snapshot!.entries.find(e => e.blockId === 'fail')).toMatchObject({ handled: true });
  expect(resume()).toBe(true);
  await expect.poll(() => runner.snapshot?.current?.blockId).toBe('loop');
  expect(runner.snapshot?.pause?.reason).toBe('breakpoint');
  const token = runner.snapshot!.pause!.token;
  runner.stop(initial.id);
  await runner.settle();
  expect(runner.snapshot).toMatchObject({ state: 'stopped', pause: null });
  expect(runner.resume(initial.id, token, 'step')).toBe(false);
  expect(runner.snapshot!.entries.filter(e => e.log)).toHaveLength(1);
});

it('finishes the in-flight wait before a requested pause and logs unavailable inputs without extra sampling', async () => {
  const changes = new RuntimeNotifications();
  let value: number | undefined = 0;
  const runner = new MasterScriptRunner({
    point: ref => ({ ref, blockKey: 's1::b2', span: { offset: 0, length: 1 }, label: '转速', type: 'UInt16',
      identity: 'p', highRisk: false, validateWrite() {}, read: () => ({ value, detail: value === undefined ? '没有确认采样' : String(value) }) }),
    slave: () => { throw new Error('Unexpected slave'); }, write: async () => { throw new Error('Unexpected write'); },
  }, changes);
  const logPoint: ScriptBlock = { id: 'log-point', type: 'mb_log', fields: { TEXT: '转速' },
    inputs: { OPERAND: { block: { id: 'p', type: 'mb_point_value', fields: { POINT } } } } };
  const logVariable: ScriptBlock = { id: 'log-var', type: 'mb_log',
    inputs: { OPERAND: { block: { id: 'v', type: 'mb_variable', fields: { VARIABLE: '未赋值' } } } } };
  const initial = runner.start(runner.prepare(scriptDef(graphFor(read, logPoint, logVariable))));
  expect(runner.pause(initial.id)).toBe(true);
  expect(runner.snapshot?.state).toBe('pausing');
  changes.publish({ kind: 'sample', blockKey: 's1::b2', range: { offset: 0, length: 1 } });
  await expect.poll(() =>runner.snapshot?.state).toBe('paused');
  expect(runner.snapshot).toMatchObject({ current: { blockId: 'log-point' }, entries: [{ blockId: 'read' }] });
  value = undefined;
  runner.resume(initial.id, runner.snapshot!.pause!.token, 'continue');
  await runner.settle();
  expect(runner.snapshot?.state).toBe('passed');
  expect(runner.snapshot?.entries.filter(e => e.log).map(e => e.detail)).toEqual(['转速 没有确认采样', '变量「未赋值」尚未赋值']);
});
