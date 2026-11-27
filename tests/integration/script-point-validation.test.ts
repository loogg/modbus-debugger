import path from 'node:path';
import * as Blockly from 'blockly/core';
import { expect, it } from 'vitest';
import { scriptBlocks as b, scriptPointKey, type ScriptBlock, type ScriptGraph } from '../../src/domain/master-script';
import type { Workspace } from '../../src/domain/model';
import { RuntimeManager } from '../../src/main/runtime/manager';
import { HistoryStore } from '../../src/main/services/history';
import { WorkspaceService } from '../../src/main/services/workspace';
import { bindings, graphOf, inspectScriptDraft, makeFieldOptions } from '../../src/renderer/features/scripts/blocks';
import { loadScriptGraph } from '../../src/renderer/features/scripts/block-controls';
import { createScratch } from '../../tools/test-paths.mjs';
import { templateWorkspace } from '../support/template-workspace';
import { FakeTransport } from '../support/fake';
import { pointChangeScript, slaveStateScript } from '../support/equipment-event-fixture';

const POINT = scriptPointKey({slaveId:'s1', pointId:'Keep'});
const statementGraph = (block: ScriptBlock, ...definitions: ScriptBlock[]): ScriptGraph => ({
  blocks:{languageVersion:0,blocks:[{id:'start',type:b.start,next:{block}}, ...definitions]},
});
const procedure: ScriptBlock = { id:'proc',type:b.procedure,fields:{NAME:'read_feedback',PARAMS:''},inputs:{BODY:{block:{
  id:'logged',type:b.log,fields:{TEXT:'反馈'},inputs:{OPERAND:{block:{id:'nested-value',type:b.pointValue,fields:{POINT}}}},
}}} };

function inspection(model: Workspace, graph: ScriptGraph) {
  const editor = new Blockly.Workspace();
  try {
    bindings.set(editor, makeFieldOptions(model, graph));
    loadScriptGraph(graph, editor);
    return inspectScriptDraft(editor, graphOf(editor));
  } finally { editor.dispose(); }
}

it('returns the same binding error from Blockly, plan and start, with the executable block selected', async () => {
  const root = createScratch('point-bindings-'), service = new WorkspaceService(root);
  const model = templateWorkspace();
  const event = pointChangeScript('s1','Keep');
  const cases = [
    {graph:event.graph, blockId:'point-event'},
    {graph:statementGraph({id:'read', type:b.read, fields:{POINT}}),blockId:'read'},
    {graph:statementGraph({id:'write', type:b.write, fields:{POINT,VALUE:'3'}}),blockId:'write'},
    {graph:statementGraph({id:'call',type:b.call,fields:{FUNCTION:'proc'}},procedure),blockId:'nested-value'},
  ];
  service.adopt(model,null);
  const manager = new RuntimeManager(service, await HistoryStore.open(path.join(root,'history.db')), {transportFactory:() => new FakeTransport('tcp')});
  try {
    for (const {graph,blockId} of cases) {
      const script = {...event,id:blockId,graph};
      const preview = inspection(model,graph);
      expect(preview.issue).toMatchObject({ blockId, message:expect.stringContaining('从站已停用') });
      expect(preview.source?.ranges.has(blockId)).toBe(true);
      expect((await manager.handleCommand({type:'script.save',script,expectedRevision:null})).ok).toBe(true);
      for (const type of ['script.plan','script.start'] as const)
        expect(await manager.handleCommand({type,scriptId:script.id,revision:0})).toEqual({ok:false,error:preview.issue!.message});
      expect(manager.buildSnapshot().scriptRuns?.[script.id]).toBeUndefined();
    }
    const enabled = {...service.current.slaves[0]!, enabled:true};
    expect((await manager.handleCommand({type:'slave.upsert',slave:enabled,expected:service.current.slaves[0]})).ok).toBe(true);
    expect(inspection(service.current,event.graph).issue).toBeNull();
    expect((await manager.handleCommand({type:'script.plan',scriptId:'point-event',revision:0})).ok).toBe(true);
    expect((await manager.handleCommand({type:'script.start',scriptId:'point-event',revision:0})).ok).toBe(true);
    expect(manager.buildSnapshot().scriptRuns?.['point-event']?.state).toBe('waiting');
  } finally { await manager.stop(); }
});

it('does not require an enabled point for status observation, empty event hats, or uncalled functions', async () => {
  const root = createScratch('point-uses-'), service = new WorkspaceService(root), model = templateWorkspace();
  const unused = statementGraph({id:'useful',type:b.log,fields:{TEXT:'完成'}},procedure,
    {id:'empty',type:b.onPointChange,fields:{POINT}});
  model.masterScripts = [slaveStateScript('s1'),{id:'unused',name:'无点位执行',revision:0,graph:unused}];
  service.adopt(model,null);
  const manager = new RuntimeManager(service, await HistoryStore.open(path.join(root,'history.db')), {transportFactory:() => new FakeTransport('tcp')});
  try {
    for (const script of model.masterScripts) {
      expect(inspection(model,script.graph).issue).toBeNull();
      expect((await manager.handleCommand({type:'script.plan',scriptId:script.id,revision:0})).ok).toBe(true);
      expect((await manager.handleCommand({type:'script.start',scriptId:script.id,revision:0})).ok).toBe(true);
    }
  } finally { await manager.stop(); }
});

it('keeps read, write and numeric diagnostics specific to the selected point', () => {
  const ws = templateWorkspace(); ws.slaves[0]!.enabled = true;
  const point = ws.templates[0]!.points.find(p=>p.id==='Keep')!;
  point.access = 'wo';
  expect(inspection(ws,pointChangeScript('s1','Keep').graph).issue).toMatchObject({blockId:'point-event',message:expect.stringContaining('点位为只写')});
  point.access = 'ro';
  expect(inspection(ws,statementGraph({id:'write',type:b.write,fields:{POINT,VALUE:'5'}})).issue).toMatchObject({blockId:'write',message:expect.stringContaining('点位为只读')});
  const flag = scriptPointKey({slaveId:'s1',pointId:'Flag'});
  const predicate = (block: ScriptBlock) => statementGraph({id:'assert',type:b.assert,inputs:{CONDITION:{block}}});
  expect(inspection(ws,predicate({id:'range',type:b.range,fields:{POINT:flag,MIN:0,MAX:1}})).issue).toMatchObject({blockId:'range',message:expect.stringContaining('数值点位')});
  expect(inspection(ws,predicate({id:'compare',type:b.compare,fields:{POINT:flag,OP:'gt',VALUE:'0'}})).issue).toMatchObject({blockId:'compare',message:expect.stringContaining('等于和不等于')});
});
