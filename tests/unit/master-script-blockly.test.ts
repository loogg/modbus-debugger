import { expect, it } from 'vitest';
import * as Blockly from 'blockly/core';
import { scriptFileSchema, scriptPointKey, scriptVariableGroups, type ScriptBlock, type ScriptGraph } from '../../src/domain/master-script';
import { bindings, generateScriptLua, generateScriptLuaSource, graphOf, inspectScriptDraft, makeFieldOptions } from '../../src/renderer/features/scripts/blocks';
import { templateWorkspace } from '../support/template-workspace';
import { loadScriptGraph } from '../../src/renderer/features/scripts/block-controls';
import { compileMasterScript, compileScriptProgram, withScriptBreakpoints } from '../../src/domain/master-script';
import alarmExample from '../../docs/examples/consecutive-temperature.modbus-script.json';
import { synchronizeScriptFunctions } from '../../src/renderer/features/scripts/function-blocks';
import { searchPalette, variablePalette } from '../../src/renderer/features/scripts/block-palette';
import { canvasScriptFixture } from '../support/canvas-script-fixture';
import { widgetKey } from '../../src/domain/canvas-script';

it('selects compatible widget events, retains the same control across a rename and diagnoses a removed binding', () => {
  const model = canvasScriptFixture(), graph = model.masterScripts![0]!.graph;
  const workspace = new Blockly.Workspace();
  try {
    bindings.set(workspace, makeFieldOptions(model, graph));
    loadScriptGraph(graph, workspace);
    const hat = workspace.getBlockById('on-click')!;
    expect(hat.getField('WIDGET')!.getText()).toContain('采样一次');
    const event = hat.getField('EVENT') as Blockly.FieldDropdown;
    hat.setFieldValue(widgetKey('panel','note'), 'WIDGET');
    expect(hat.getFieldValue('EVENT')).toBe('submit');
    expect(event.getOptions(false).map(([,value]) => value)).toEqual(['submit']);
    hat.setFieldValue(widgetKey('panel','sample'), 'WIDGET');
    expect(hat.getFieldValue('EVENT')).toBe('click');
    const saved = graphOf(workspace);
    model.canvases![0]!.widgets[0]!.label = '采样 B';
    bindings.set(workspace, makeFieldOptions(model, saved));
    expect(hat.getField('WIDGET')!.getText()).toContain('采样 B');
    expect(inspectScriptDraft(workspace, saved).issue).toBeNull();
    model.canvases![0]!.widgets.shift();
    bindings.set(workspace, makeFieldOptions(model, saved));
    expect(inspectScriptDraft(workspace, saved).issue?.message).toContain('失效');
    expect(hat.getFieldValue('WIDGET')).toBe(widgetKey('panel','sample'));
  } finally { workspace.dispose(); }
});

it('lists variables from the editable graph by scope, skipping disabled bodies and keeping same-named parameters separate', () => {
  const graph = scriptFileSchema.parse(alarmExample).graph;
  const groups = scriptVariableGroups(graph);
  expect(groups.map(group => [group.label, [...group.names.keys()]])).toEqual([
    ['主流程', ['over_limit_count', 'current_temperature']],
    ['exceeds_limit', ['temperature', 'threshold']], ['log_overheat', ['temperature', 'threshold']],
  ]);
  graph.blocks!.blocks[1]!.enabled = false;
  graph.blocks!.blocks[0]!.next!.block.next!.block.disabledReasons = ['manual'];
  expect(scriptVariableGroups(graph).map(group => [...group.names.keys()])).toEqual([['over_limit_count'], ['temperature', 'threshold']]);
  const names = ['current_temperature', 'over_limit_count'];
  expect(searchPalette('TEMPERATURE', names)).toEqual([expect.objectContaining({ type: 'mb_variable', fields: { VARIABLE: 'current_temperature' } })]);
  expect(variablePalette(names)).toContainEqual(expect.objectContaining({ type: 'mb_variable', fields: { VARIABLE: 'over_limit_count' } }));
  expect(searchPalette('打印', names)).toEqual([expect.objectContaining({ type: 'mb_log' })]);
  expect(searchPalette('nothing_matches', names)).toEqual([expect.objectContaining({ kind: 'label' })]);
});

it('preserves function identity across renames and retains meaningful surplus arguments until explicitly cleared', () => {
  const ws = new Blockly.Workspace();
  try {
    const start = ws.newBlock('mb_start', 'start');
    const fn = ws.newBlock('mb_function', 'twice');
    fn.setFieldValue('返回原值', 'NAME'); fn.setFieldValue('输入,备用', 'PARAMS');
    const param = ws.newBlock('mb_parameter', 'formal');
    fn.getInput('RESULT')!.connection!.connect(param.outputConnection!);
    param.setFieldValue('0', 'PARAM');
    const set = ws.newBlock('mb_set_var', 'store');
    start.nextConnection!.connect(set.previousConnection!);
    const call = ws.newBlock('mb_call_value', 'call');
    set.getInput('OPERAND')!.connection!.connect(call.outputConnection!);
    call.setFieldValue('twice', 'FUNCTION');
    expect(call.getInput('ARG1')).not.toBeNull();
    call.getInputTargetBlock('ARG1')!.setFieldValue(17, 'NUM');
    fn.setFieldValue('取首个值', 'NAME'); fn.setFieldValue('读数,备用', 'PARAMS');
    synchronizeScriptFunctions(ws);
    expect(call.getField('FUNCTION')!.getText()).toBe('取首个值');
    expect(param.getField('PARAM')!.getText()).toBe('读数');
    const legacyLua = generateScriptLua(ws, graphOf(ws));
    expect(legacyLua).toMatch(/local function compute_value\(arg_1, arg_2\)\s+return _ops\.read\(arg_1, "读数"\)\s+end/);
    expect(legacyLua).toContain('local count = compute_value(0, 17)');
    fn.setFieldValue('读数', 'PARAMS'); synchronizeScriptFunctions(ws);
    expect(call.getFieldValue('ARG_LABEL1')).toContain('多余');
    expect(inspectScriptDraft(ws, graphOf(ws)).issue?.blockId).toBe('call');
    call.getInputTargetBlock('ARG1')!.setFieldValue(0, 'NUM'); synchronizeScriptFunctions(ws);
    expect(call.getInput('ARG1')).toBeNull();
    const saved = scriptFileSchema.parse({ format: 'modbus-master-script', version: 1, name: '函数', graph: graphOf(ws) }).graph;
    ws.clear(); loadScriptGraph(saved, ws);
    expect(ws.getBlockById('call')!.getFieldValue('FUNCTION')).toBe('twice');
    ws.getBlockById('twice')!.dispose();
    expect(inspectScriptDraft(ws, graphOf(ws)).issue).toMatchObject({ blockId: 'call', message: expect.stringContaining('函数') });
  } finally { ws.dispose(); }
});

it('round-trips the temperature alarm with editable numeric sockets, source ranges and both variable statements as breakpoints', () => {
  const ws = new Blockly.Workspace();
  try {
    const graph = scriptFileSchema.parse(alarmExample).graph;
    bindings.set(ws, makeFieldOptions(null, graph));
    loadScriptGraph(graph, ws);
    const saved = graphOf(ws);
    expect(compileScriptProgram(saved)).toEqual(compileScriptProgram(graph));
    expect(withScriptBreakpoints(saved, ['initial-count', 'increment', 'excess-degrees']).breakpoints).toEqual(['initial-count', 'increment']);
    const source = generateScriptLuaSource(ws, saved);
    expect(source.text).toContain('over_limit_count = _ops.add(_ops.read(over_limit_count, "over_limit_count"), 1)');
    expect(source.text).toMatch(/local function exceeds_limit\(temperature, threshold\)\s+return _ops\.gt\(_ops\.read\(temperature, "temperature"\), _ops\.read\(threshold, "threshold"\)\)\s+end/);
    expect(source.text).toContain('print("温度连续三次超限，超出阈值（°C）", _ops.observe(function() return _ops.subtract(_ops.read(temperature, "temperature"), _ops.read(threshold, "threshold")) end))');
    expect(source.text).toContain('if exceeds_limit(_ops.read(current_temperature, "current_temperature"), 70) then');
    expect(source.text).toContain('log_overheat(_ops.read(current_temperature, "current_temperature"), 70)');
    expect(source.ranges.get('over-limit')!.last).toBeLessThan(source.ranges.get('start')!.first);
    expect(source.ranges.get('excess-degrees')).toEqual(source.ranges.get('alarm'));
    const math = ws.getBlockById('at-three')!;
    const socket = math.getInput('B')!.connection!;
    socket.targetBlock()!.setFieldValue(12.5, 'NUM');
    const a = ws.newBlock('mb_arithmetic', 'nested');
    a.setFieldValue('divide', 'OP');
    socket.connect(a.outputConnection!);
    expect(generateScriptLua(ws, graphOf(ws))).toContain('_ops.eq(_ops.read(over_limit_count, "over_limit_count"), _ops.divide(0, 1))');
    a.unplug(); a.dispose();
    expect(Number(socket.targetBlock()?.getFieldValue('NUM'))).toBe(12.5);
  } finally { ws.dispose(); }
});

it('keeps a plain log on one row, persists an empty expanded socket and reopens legacy attached values', () => {
  const ws = new Blockly.Workspace();
  try {
    const log = ws.newBlock('mb_log', 'log');
    expect(log.getInput('OPERAND')).toBeNull();
    expect(log.getInputsInline()).toBe(true);
    log.setFieldValue('ON', 'WITH_VALUE');
    expect(log.getInput('OPERAND')?.connection).toBeDefined();
    const open = graphOf(ws);
    ws.clear(); loadScriptGraph(open, ws);
    const restored = ws.getBlockById('log')!;
    expect(restored.getInput('OPERAND')?.connection).toBeDefined();
    restored.setFieldValue('OFF', 'WITH_VALUE');
    expect(restored.getInput('OPERAND')).toBeNull();
    restored.setFieldValue('ON', 'WITH_VALUE');
    restored.getInput('OPERAND')!.connection!.connect(ws.newBlock('mb_number', 'value').outputConnection!);
    const legacy = graphOf(ws);
    expect(legacy.blocks?.blocks[0]?.fields?.WITH_VALUE).toBeUndefined();
    ws.clear(); loadScriptGraph(legacy, ws);
    expect(ws.getBlockById('log')?.getInputTargetBlock('OPERAND')?.id).toBe('value');
  } finally { ws.dispose(); }
});

it('validates the draft structure and workspace bindings, locates the issue, and clears it after correction', () => {
  const ws = new Blockly.Workspace();
  const missing = scriptPointKey({ slaveId: 's1', pointId: 'Removed' });
  const graph: ScriptGraph = { blocks: { languageVersion: 0, blocks: [{ id: 'entry', type: 'mb_start',
    next: { block: { id: 'sample', type: 'mb_read', fields: { POINT: missing, TIMEOUT: 600 } } } }] } };
  const inspect = () => inspectScriptDraft(ws, graphOf(ws));
  try {
    bindings.set(ws, makeFieldOptions(templateWorkspace(), graph));
    loadScriptGraph(graph, ws);
    const loose = ws.newBlock('mb_delay', 'loose');
    expect(inspect()).toMatchObject({ source: null, issue: { blockId: 'loose', message: expect.stringContaining('同一个') } });
    loose.dispose();
    expect(inspect()).toMatchObject({ source: { text: expect.stringContaining('"Removed"') }, issue: { blockId: 'sample', message: expect.stringContaining('可读点位') } });
    ws.getBlockById('sample')!.setFieldValue(scriptPointKey({ slaveId: 's1', pointId: 'Keep' }), 'POINT');
    expect(inspect().issue).toBeNull();
    ws.getBlockById('sample')!.dispose();
    expect(inspect()).toMatchObject({ source: null, issue: { blockId: 'entry', message: expect.stringContaining('至少一个步骤') } });
  } finally { bindings.delete(ws); ws.dispose(); }
});

it('maps containers, identical statements and nested expressions to the exact emitted lines after edits', () => {
  const ws = new Blockly.Workspace();
  const log = (id: string): ScriptBlock => ({ type: 'mb_log', id, fields: { TEXT: '采样' } });
  const branch: ScriptBlock = { type: 'mb_if', id: 'branch', extraState: { elseIfCount: 0, hasElse: true }, inputs: {
    CONDITION: { block: { type: 'mb_and', id: 'condition', fields: { BOOL_A: 'TRUE' }, inputs: {
      B: { block: { type: 'mb_not', id: 'negate', inputs: { CONDITION: { block: {
        type: 'mb_state', id: 'device-online', fields: { SLAVE: 's1', STATE: 'online' },
      } } } } },
    } } }, YES: { block: log('first') }, NO: { block: log('second') },
  } };
  const repeat: ScriptBlock = { id: 'loop', type: 'mb_repeat', fields: { COUNT: 2 }, inputs: { BODY: { block: branch } },
    next: { block: { ...log('omitted'), disabledReasons: ['MANUALLY_DISABLED'], next: { block: log('after') } } } };
  try {
    const graph: ScriptGraph = { blocks: { languageVersion: 0, blocks: [{ id: 'start', type: 'mb_start', next: { block: repeat } }] } };
    bindings.set(ws, makeFieldOptions(templateWorkspace(), graph));
    loadScriptGraph(graph, ws);
    const source = generateScriptLuaSource(ws, graphOf(ws));
    const line = (id: string) => source.lines.findIndex(item => item.blockId === id);
    const first = line('first');
    const second = line('second');
    const after = line('after');
    expect(first).toBeGreaterThan(line('branch'));
    expect(second).toBe(first + 2);
    expect(source.lines[first]?.text).toBe(source.lines[second]?.text);
    expect(source.ranges.get('first')).toEqual({ first, last: first });
    expect(source.ranges.get('second')).toEqual({ first: second, last: second });
    expect(source.ranges.get('branch')).toEqual({ first: 1, last: second + 1 });
    expect(source.lines[second - 1]).toEqual({ text: '  else', blockId: 'branch' });
    expect(source.ranges.get('loop')).toEqual({ first: 0, last: after - 1 });
    expect(source.lines[after - 1]).toEqual({ text: 'end', blockId: 'loop' });
    expect(source.ranges.get('start')).toEqual({ first: 0, last: after });
    expect(source.ranges.has('omitted')).toBe(false);
    const expr = source.lines.findIndex(item => item.text.includes('modbus.negate'));
    expect(source.ranges.get('negate')).toEqual({ first: expr, last: expr });
    expect(source.ranges.get('condition')!.last).toBeGreaterThan(expr);
    expect(source.text).toBe(source.lines.map(item => item.text).join('\n'));
    expect(source.text).not.toContain('\x00');
    ws.getBlockById('second')!.setFieldValue('另一分支', 'TEXT');
    const edited = generateScriptLuaSource(ws, graphOf(ws));
    expect(edited.lines[second]).toEqual({ text: '    print("另一分支")', blockId: 'second' });
    ws.getBlockById('second')!.unplug();
    expect(() => generateScriptLuaSource(ws, graphOf(ws))).toThrow('请将步骤接到同一个');
  } finally { ws.dispose(); }
});

it('preserves log operands and executable breakpoints through Blockly editing and portable export', () => {
  const workspace = new Blockly.Workspace();
  const point = scriptPointKey({ slaveId: 's1', pointId: 'Keep' });
  const first: ScriptBlock = { id: 'intro', type: 'mb_log', fields: { TEXT: '开始 "恢复"' }, next: { block: {
    id: 'readout', type: 'mb_log', fields: { TEXT: '确认值' }, inputs: { OPERAND: { block: { id: 'ref', type: 'mb_point_value', fields: { POINT: point } } } },
  } } };
  const graph: ScriptGraph = { blocks: { languageVersion: 0, blocks: [{ id: 'start', type: 'mb_start', next: { block: first } }] } };
  try {
    bindings.set(workspace, makeFieldOptions(templateWorkspace(), graph));
    loadScriptGraph(graph, workspace);
    const saved = withScriptBreakpoints(graphOf(workspace), ['intro', 'ref', 'ghost', 'intro']);
    const portable = scriptFileSchema.parse({ format: 'modbus-master-script', version: 1, name: '日志', graph: saved });
    expect(portable.graph.breakpoints).toEqual(['intro']);
    expect(compileMasterScript(portable.graph)).toEqual([
      { blockId: 'intro', kind: 'log', message: '开始 "恢复"' },
      { blockId: 'readout', kind: 'log', message: '确认值', operand: { blockId: 'ref', kind: 'point', ref: { slaveId: 's1', pointId: 'Keep' } } },
    ]);
    expect(generateScriptLua(workspace, saved)).toContain('print("开始 \\"恢复\\"")\n  print("确认值", _ops.observe(function() return modbus.value("s1", "Keep") end))');
    workspace.getBlockById('intro')!.setFieldValue('', 'TEXT');
    expect(() => compileMasterScript(graphOf(workspace))).toThrow('请输入日志文字或接入一个值');
  } finally { bindings.delete(workspace); workspace.dispose(); }
});

it('round-trips the device binding and escapes text in generated Lua with the installed Blockly library', () => {
  const workspace = new Blockly.Workspace();
  const point = scriptPointKey({ slaveId: 's1', pointId: 'Late' });
  const graph: ScriptGraph = { blocks: { languageVersion: 0, blocks: [{
    type: 'mb_start', id: 'entry', x: 30, y: 24,
    next: { block: { type: 'mb_write', id: 'write', fields: { POINT: point, VALUE: 'A\n"quoted"\\path' } } },
  }] } };
  try {
    bindings.set(workspace, makeFieldOptions(templateWorkspace(), graph));
    loadScriptGraph(graph, workspace);
    expect(workspace.getBlockById('write')?.getFieldValue('POINT')).toBe(point);
    const saved = graphOf(workspace);
    expect(scriptFileSchema.safeParse({ format: 'modbus-master-script', version: 1, name: '共享流程', graph: saved }).success).toBe(true);
    expect(generateScriptLua(workspace, saved)).toBe('modbus.write("s1", "Late", "A\\010\\"quoted\\"\\\\path")');
  } finally { workspace.dispose(); }
});

it('starts new condition switches off, retains legacy unset conditions, and restores the literal after disconnecting an expression', () => {
  const workspace = new Blockly.Workspace();
  try {
    const start = workspace.newBlock('mb_start', 'entry');
    const check = workspace.newBlock('mb_assert', 'check');
    start.nextConnection!.connect(check.previousConnection!);
    const slot = check.getInput('CONDITION')!.connection!;
    expect(slot.targetBlock()?.getFieldValue('BOOL')).toBe('FALSE');
    expect(generateScriptLua(workspace, graphOf(workspace))).toBe('modbus.assert(function() return false end)');
    slot.targetBlock()!.setFieldValue('TRUE', 'BOOL');
    const expression = workspace.newBlock('mb_not');
    slot.connect(expression.outputConnection!);
    expect(generateScriptLua(workspace, graphOf(workspace))).toContain('function() return not false end');
    expression.unplug(); expression.dispose();
    expect(slot.targetBlock()?.getFieldValue('BOOL')).toBe('TRUE');
    const graph = graphOf(workspace);
    workspace.clear();
    loadScriptGraph(graph, workspace);
    expect(generateScriptLua(workspace, graphOf(workspace))).toBe('modbus.assert(function() return true end)');
    const legacy = graph.blocks!.blocks[0]!.next!.block;
    delete legacy.fields!.BOOL_CONDITION;
    workspace.clear();
    loadScriptGraph(graph, workspace);
    expect(workspace.getBlockById('check')!.getInputTargetBlock('CONDITION')!.getFieldValue('BOOL')).toBe('UNSET');
    expect(() => compileMasterScript(graphOf(workspace))).toThrow('条件积木');
  } finally { workspace.dispose(); }
});

it('replaces an editable literal in the same socket, restores it on detach, and round-trips expandable branches', () => {
  const ws = new Blockly.Workspace();
  const key = scriptPointKey({ slaveId: 's1', pointId: 'Keep' });
  const graph: ScriptGraph = { blocks: { languageVersion: 0, blocks: [{ id: 'start', type: 'mb_start', next: { block: {
    id: 'if', type: 'mb_if', fields: { BOOL_CONDITION: 'FALSE', BOOL_COND1: 'TRUE' }, extraState: { elseIfCount: 1, hasElse: true },
    inputs: { YES1: { block: { type: 'mb_write', id: 'restore', fields: { POINT: key, VALUE: '77' },
      inputs: { OPERAND: { block: { id: 'saved', type: 'mb_variable', fields: { VARIABLE: '原值' } } } } } },
    NO: { block: { type: 'mb_stop', id: 'stop' } } },
  } } }] } };
  try {
    bindings.set(ws, makeFieldOptions(templateWorkspace(), graph));
    loadScriptGraph(graph, ws);
    const saved = graphOf(ws);
    expect(scriptFileSchema.safeParse({ format:'modbus-master-script', version:1, name:'值槽', graph:saved }).success).toBe(true);
    expect(compileMasterScript(saved)).toMatchObject([{ kind: 'branch', arms: [
      { condition: { kind: 'truth', operand: { value: false } } },
      { condition: { operand: { value: true } }, steps: [{ kind: 'write', operand: { kind: 'variable', name: '原值' } }] },
    ], no: [{ kind: 'stop' }] }]);
    expect(generateScriptLua(ws, saved)).toContain('elseif true then');
    const write = ws.getBlockById('restore')!;
    const reporter = write.getInputTargetBlock('OPERAND')!;
    reporter.unplug(); reporter.dispose();
    expect(write.getInputTargetBlock('OPERAND')?.isShadow()).toBe(true);
    expect(write.getInputTargetBlock('OPERAND')?.getFieldValue('TEXT')).toBe('77');
    expect(generateScriptLua(ws, graphOf(ws))).toContain('modbus.write("s1", "Keep", "77")');
    expect(() => compileMasterScript({ blocks: { languageVersion: 0, blocks: [{ type: 'mb_start', id: 'start', next: { block: { type: 'mb_break', id: 'exit' } } }] } })).toThrow('循环内');
  } finally { ws.dispose(); }
});

it('opens legacy blocks and shows timeout fields and Lua arguments only for explicit waits', () => {
  const point = scriptPointKey({ slaveId: 's1', pointId: 'Keep' });
  const condition = (id: string): ScriptBlock => ({ id, type: 'mb_compare', fields: { POINT: point, OP: 'eq', VALUE: '17' } });
  const check: ScriptBlock = { id: 'assert', type: 'mb_assert', fields: { TIMEOUT: 4000 }, inputs: { CONDITION: { block: condition('check') } } };
  const wait: ScriptBlock = { id: 'wait', type: 'mb_wait', fields: { TIMEOUT: 3000 }, inputs: { CONDITION: { block: condition('until') } } };
  const branch: ScriptBlock = { id: 'if', type: 'mb_if', fields: { TIMEOUT: 4000 }, inputs: {
    CONDITION: { block: condition('test') }, YES: { block: check }, NO: { block: wait },
  } };
  const capture: ScriptBlock = { id: 'capture', type: 'mb_read_var', fields: { POINT: point, VARIABLE: '初值', TIMEOUT: 5000 }, next: { block: branch } };
  const graph: ScriptGraph = { blocks: { languageVersion: 0, blocks: [{ id: 'start', type: 'mb_start', next: { block: capture } }] } };
  const imported = scriptFileSchema.parse({ format: 'modbus-master-script', version: 1, name: '旧流程', graph });
  expect(capture.fields?.TIMEOUT).toBe(5000);
  const workspace = new Blockly.Workspace();
  try {
    bindings.set(workspace, makeFieldOptions(templateWorkspace(), imported.graph));
    loadScriptGraph(imported.graph, workspace);
    for (const id of ['capture', 'assert', 'if']) {
      const block = workspace.getBlockById(id)!;
      expect(block.getField('TIMEOUT')).toBeNull();
    }
    expect(workspace.getBlockById('wait')!.getFieldValue('TIMEOUT')).toBe(3000);
    const lua = generateScriptLua(workspace, graphOf(workspace));
    expect(lua).toContain('local value = modbus.value("s1", "Keep")');
    expect(lua).toContain('if modbus.check(function() return modbus.compare("s1", "Keep", "eq", "17") end) then');
    expect(lua).toContain('modbus.assert(function() return modbus.compare("s1", "Keep", "eq", "17") end)');
    expect(lua).toContain('modbus.wait(function() return modbus.compare("s1", "Keep", "eq", "17") end, 3000)');
  } finally { workspace.dispose(); }
});
