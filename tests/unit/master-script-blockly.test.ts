import { expect, it } from 'vitest';
import * as Blockly from 'blockly/core';
import { scriptFileSchema, scriptPointKey, type ScriptBlock, type ScriptGraph } from '../../src/domain/master-script';
import { bindings, generateScriptLua, graphOf, makeFieldOptions } from '../../src/renderer/features/scripts/blocks';
import { templateWorkspace } from '../support/template-workspace';
import { loadScriptGraph } from '../../src/renderer/features/scripts/block-controls';
import { compileMasterScript, withScriptBreakpoints } from '../../src/domain/master-script';

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
      { blockId: 'readout', kind: 'log', message: '确认值', operand: { kind: 'point', ref: { slaveId: 's1', pointId: 'Keep' } } },
    ]);
    expect(generateScriptLua(workspace, saved)).toBe('print("开始 \\"恢复\\"")\nprint("确认值", modbus.value("s1", "Keep"))');
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
    expect(generateScriptLua(workspace, graphOf(workspace))).toContain('modbus.negate(function() return false end)');
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
    expect(generateScriptLua(ws, saved)).toContain('elseif modbus.check(function() return true end) then');
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
    expect(lua).toContain('modbus.read_into("初值", "s1", "Keep")');
    expect(lua).toContain('if modbus.check(function() return modbus.compare("s1", "Keep", "eq", "17") end) then');
    expect(lua).toContain('modbus.assert(function() return modbus.compare("s1", "Keep", "eq", "17") end)');
    expect(lua).toContain('modbus.wait(function() return modbus.compare("s1", "Keep", "eq", "17") end, 3000)');
  } finally { workspace.dispose(); }
});
