import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { LuaFactory } from 'wasmoon';
import { createScratch } from '../../tools/test-paths.mjs';
import { canvasScriptFixture, heldButtonFixture } from '../support/canvas-script-fixture';
import { WorkspaceService } from '../../src/main/services/workspace';
import { HistoryStore } from '../../src/main/services/history';
import { RuntimeManager } from '../../src/main/runtime/manager';
import { commandSchema } from '../../src/shared/commands';
import { compileScriptLua } from '../../src/domain/script-lua-program';
import { type WidgetEvent, type SignalValue } from '../../src/domain/canvas-script';
import { scriptBlocks as blocks } from '../../src/domain/master-script';

async function fixture(workspace = canvasScriptFixture()) {
  const root = createScratch('canvas-script-'), service = new WorkspaceService(path.join(root, 'data'));
  service.adopt(workspace, null);
  const manager = new RuntimeManager(service, await HistoryStore.open(path.join(root, 'history.db')));
  manager.start();
  const command = (raw: unknown) => manager.handleCommand(commandSchema.parse(raw));
  const epoch = manager.buildSnapshot().canvasSignals!.epoch;
  const interact = (widgetId: string, event: WidgetEvent, value?: SignalValue, actionId: string = randomUUID(), revision = 0, pressId?: string) =>
    command({ type: 'canvas.interact', epoch, canvasId: 'panel', widgetId, event, value, actionId, revision, pressId });
  const run = (id: string) => manager.buildSnapshot().scriptRuns?.[id];
  const start = (id: string) => command({ type: 'script.start', scriptId: id, revision: 0 });
  return { workspace, service, manager, command, interact, run, start };
}

it('pairs a held press across a canvas save and a debug pause, with exactly one activation', async () => {
  const f = await fixture(heldButtonFixture());
  const phase = (event: WidgetEvent, id: string, revision = 0) => f.interact('sample', event, undefined, randomUUID(), revision, id);
  const held = () => f.manager.buildSnapshot().canvasSignals?.variables.held;
  try {
    await f.start('capture');
    expect(await phase('press','first')).toMatchObject({ ok:true,value:1 });
    await expect.poll(held).toBe(true);
    await f.command({ type:'canvas.edit', canvasId:'panel', expectedRevision:0, changes:{name:'操作台 B'} });
    expect(await phase('press','stale')).toMatchObject({ok:false});
    expect(await f.interact('sample','click')).toMatchObject({ok:false});
    const run = f.run('capture')!;
    await f.command({type:'script.pause',runId:run.id});
    const pause = f.run('capture')!.pause!;
    expect(await phase('release','first')).toMatchObject({ok:true,value:1});
    expect(await phase('release','first')).toMatchObject({ok:true,value:0});
    expect(await phase('cancel','first')).toMatchObject({ok:true,value:0});
    expect(await phase('click','first')).toMatchObject({ok:true,value:1});
    expect(await phase('click','first')).toMatchObject({ok:true,value:0});
    expect(await phase('release','stale')).toMatchObject({ok:true,value:0});
    expect(held()).toBe(true);
    await f.command({type:'script.resume',runId:run.id,token:pause.token,mode:'continue'});
    await expect.poll(() => f.run('capture')?.entries.filter(row=>row.log).map(row=>row.detail)).toEqual(['按下 true','松开 false','点击 true']);
    expect(held()).toBe(false);
  } finally { await f.manager.stop(); }
});

it('keeps concurrent window presses independent and excludes runs started or restarted after a press', async () => {
  const f = await fixture();
  const phase = (event: WidgetEvent, id: string) => f.interact('sample', event, undefined, randomUUID(), 0, id);
  const logs = (id: string) => f.run(id)?.entries.filter(e=>e.log).map(e=>e.detail);
  try {
    const src = f.workspace.masterScripts![0]!;
    await f.command({type:'script.save',script:{...src,id:'another'},expectedRevision:null});
    await f.start('capture');
    await phase('press','window-a'); await f.start('another'); await phase('press','window-b');
    await phase('release','window-a');
    await phase('click','window-a');
    await expect.poll(() => logs('capture')).toEqual(['按下 true','按下 true','松开 false','点击 true']);
    expect(logs('another')).toEqual(['按下 true']);
    await f.command({type:'script.stop',runId:f.run('capture')!.id}); await f.start('capture');
    expect(await phase('cancel','window-b')).toMatchObject({ok:true,value:1});
    await expect.poll(() => logs('another')).toEqual(['按下 true','取消 false']);
    expect(logs('capture')).toEqual([]);
    await phase('press','old-workspace');
    await f.command({type:'workspace.importText',text:JSON.stringify(f.workspace)});
    await f.start('capture');
    expect(await phase('release','old-workspace')).toMatchObject({ok:true,value:0});
    expect(logs('capture')).toEqual([]);
  } finally { await f.manager.stop(); }
});

it('allows click-only listeners to activate on a matched release and ignores a removed button', async () => {
  const ws = canvasScriptFixture(), src = ws.masterScripts![0]!;
  src.graph.blocks!.blocks = src.graph.blocks!.blocks.filter(b=>b.fields?.EVENT === 'click');
  const f = await fixture(ws);
  const phase = (event: WidgetEvent, id: string) => f.interact('sample', event, undefined, randomUUID(), 0, id);
  try {
    await f.start('capture');
    await phase('press','one'); await phase('release','one'); await phase('click','one');
    await expect.poll(() => f.run('capture')?.entries.filter(e=>e.log)).toHaveLength(1);
    await phase('press','two');
    expect((await f.command({type:'canvas.edit',canvasId:'panel',expectedRevision:0,changes:{removeWidgetIds:['sample']}})).ok).toBe(true);
    expect(await phase('release','two')).toMatchObject({ok:true,value:0});
    expect(f.run('capture')?.state).toBe('failed');
    expect(f.run('capture')?.entries.filter(e=>e.log)).toHaveLength(1);
  } finally { await f.manager.stop(); }
});

it('routes individual edges and changing values once, preserves ordering and isolates each flow', async () => {
  const f = await fixture();
  try {
    for (const id of ['capture', 'observe']) { expect(await f.start(id)).toMatchObject({ ok: true }); expect(f.run(id)?.state).toBe('waiting'); }
    for (const event of ['press','release','click'] as const) expect(await f.interact('sample', event, undefined, event)).toMatchObject({ ok: true, value: 1 });
    expect(await f.interact('sample', 'click', undefined, 'click')).toMatchObject({ ok: true, value: 1 });
    await expect.poll(() => f.run('capture')?.entries.filter(e => e.log).map(e => e.detail)).toEqual(['按下 true','松开 false','点击 true']);
    await expect.poll(() => f.run('observe')?.entries.filter(e => e.log).map(e => e.detail)).toEqual(['计数 1']);
    expect(f.run('capture')?.entries.at(-1)?.trigger?.binding).toMatchObject({ kind: 'widget', widgetId: 'sample', event: 'click' });
    expect(f.run('capture')?.variableScopes[0]?.values).toContainEqual({ name: 'last_count', value: 1 });
    await f.interact('enabled','change'); await f.interact('note','submit','实验'); await f.interact('sample','cancel');
    await expect.poll(() => f.run('capture')?.entries.filter(e => e.log).slice(-3).map(e => e.detail)).toEqual(['开关 true','备注 实验','取消 false']);
    expect(f.manager.buildSnapshot().canvasSignals?.variables).toEqual({ count: 1, enabled: true, note: '实验' });
    expect(await f.interact('note','press')).toMatchObject({ ok: false });
    expect(await f.interact('note','submit',true)).toMatchObject({ ok: false });
    expect(await f.interact('sample','click',undefined,'stale',2)).toMatchObject({ ok: false });
    const run = f.run('capture')!;
    await f.command({ type:'script.pause', runId: run.id });
    await f.interact('sample','click');
    expect(f.run('capture')?.completed).toBe(run.completed);
    await f.command({ type:'script.resume', runId: run.id, token: f.run('capture')!.pause!.token, mode:'continue' });
    await expect.poll(() => f.run('observe')?.entries.filter(e => e.log).at(-1)?.detail).toBe('计数 2');
    await f.command({ type:'script.stop', runId:run.id });
    expect(await f.interact('sample','click')).toMatchObject({ ok:true, value:0 });
    expect(f.run('capture')?.state).toBe('stopped');
    expect(f.run('observe')?.state).toBe('waiting');
    await f.command({ type: 'workspace.new' });
    expect(await f.interact('sample','click')).toMatchObject({ ok: false });
    expect(f.manager.buildSnapshot().canvasSignals?.variables).toEqual({});
  } finally { await f.manager.stop(); }
});

it('persists declarations, validates event bindings, rejects stale edits, and terminates retired subscriptions', async () => {
  const f = await fixture();
  try {
    const variable = { id: 'threshold', name: 'threshold', type: 'number', initial: 35 };
    expect(await f.command({ type:'variable.save', variable, expected:null })).toMatchObject({ ok:true });
    expect(await f.command({ type:'variable.save', variable, expected:null })).toMatchObject({ ok:false });
    expect(await f.command({ type:'variable.save', variable:{ ...variable, id:'second' }, expected:null })).toMatchObject({ ok:false });
    const renamed = { ...variable, name: 'limit', initial: 45 };
    expect(await f.command({ type:'variable.save', variable:renamed, expected:variable })).toMatchObject({ ok:true });
    expect(f.manager.buildSnapshot().canvasSignals?.variables.threshold).toBe(35);
    expect(await f.command({ type:'variable.delete', expected:renamed })).toMatchObject({ ok:true });
    expect(await f.command({ type:'variable.delete', expected:f.workspace.variables![0] })).toMatchObject({ ok:false });
    await f.start('capture');
    expect(await f.command({ type:'canvas.edit', canvasId:'panel', expectedRevision:0, changes:{ name:'重命名' } })).toMatchObject({ ok:true });
    await f.interact('sample','click',undefined,'renamed',1);
    await expect.poll(() => f.run('capture')?.entries.at(-1)?.trigger?.label).toContain('重命名');
    await f.command({ type:'canvas.delete', canvasId:'panel', expectedRevision:1 });
    expect(f.run('capture')?.state).toBe('failed');
    expect(await f.start('capture')).toMatchObject({ ok:false });
  } finally { await f.manager.stop(); }
});

it('executes the portable Lua callback and rejects an event value outside a receiving callback', async () => {
  const script = canvasScriptFixture().masterScripts![0]!;
  const lua = compileScriptLua(script.graph).source.text;
  const engine = await new LuaFactory().createEngine();
  try {
    expect(engine.doStringSync(`local count = 0; rt = { get_workspace_variable = function() return count end,
      set_workspace_variable = function(_, v) count = v end, event_value = function() return true end }; print = function() end
      local handlers = (function() ${lua} end)(); for _, h in ipairs(handlers.inputs) do
      if h.canvas == "panel" and h.widget == "sample" and h.event == "click" then h.handle() end end; return count`)).toBe(1);
  } finally { engine.global.close(); }
  expect(() => compileScriptLua({ blocks: { languageVersion: 0, blocks: [{ id:'s',type:blocks.start,next:{block:{id:'l',type:blocks.log,
    inputs:{OPERAND:{block:{id:'v',type:blocks.eventValue}}}}} }] } })).toThrow('仅可在');
});

it('delivers one gesture to each active subscriber and ignores repeated values', async () => {
  const f = await fixture();
  try {
    const copy = { ...f.workspace.masterScripts![0]!, id: 'second', name: '第二流程' };
    expect(await f.command({ type:'script.save', script:copy, expectedRevision:null })).toMatchObject({ ok:true });
    await f.start('capture'); await f.start('second'); await f.start('observe');
    expect(await f.interact('sample','click',undefined,'one')).toMatchObject({ ok:true, value:2 });
    await f.interact('sample','click',undefined,'one');
    await expect.poll(() => f.run('observe')?.entries.filter(e => e.log).map(e => e.detail)).toEqual(['计数 1','计数 2']);
    expect(f.run('capture')?.entries.filter(e => e.log)).toHaveLength(1);
    expect(f.run('second')?.entries.filter(e => e.log)).toHaveLength(1);
    const listener = { id:'notes', name:'备注变化', graph:{ blocks:{ languageVersion:0, blocks:[{
      id:'listen', type:blocks.onWorkspaceChange, fields:{ TAG:'note' }, next:{block:{id:'log',type:blocks.log,fields:{TEXT:'变化'}}},
    }] } } };
    expect(await f.command({type:'script.save',script:listener,expectedRevision:null})).toMatchObject({ok:true});
    await f.start('notes');
    await f.interact('note','submit','A'); await f.interact('note','submit','A'); await f.interact('note','submit','B');
    await expect.poll(() => f.run('capture')?.entries.filter(e => e.blockId === 'submitted')).toHaveLength(3);
    expect(f.run('notes')?.entries.filter(e => e.log)).toHaveLength(2);
  } finally { await f.manager.stop(); }
});

it('wakes a startup wait from a workspace variable and rejects incompatible assignments before execution', async () => {
  const f = await fixture();
  try {
    const listening = { id:'waiting', name:'等待使能', graph:{blocks:{languageVersion:0,blocks:[{id:'start',type:blocks.start,next:{block:{
      id:'wait',type:blocks.wait,fields:{TIMEOUT:2000},inputs:{CONDITION:{block:{id:'enabled',type:blocks.workspaceValue,fields:{TAG:'enabled'}}}},
      next:{block:{id:'done',type:blocks.log,fields:{TEXT:'已使能'}}},
    }}}]}} };
    expect((await f.command({type:'script.save',script:listening,expectedRevision:null})).ok).toBe(true);
    expect((await f.start('waiting')).ok).toBe(true);
    await f.interact('enabled','change');
    await expect.poll(() => f.run('waiting')?.state).toBe('passed');
    const invalid = { id:'invalid',name:'类型校验',graph:{blocks:{languageVersion:0,blocks:[{id:'start',type:blocks.start,next:{block:{
      id:'set',type:blocks.setWorkspaceValue,fields:{TAG:'enabled',OPERAND:1},
    }}}]}} };
    expect((await f.command({type:'script.save',script:invalid,expectedRevision:null})).ok).toBe(true);
    expect(await f.start('invalid')).toMatchObject({ok:false,error:expect.stringContaining('类型不一致')});
    expect(f.run('invalid')).toBeUndefined();
  } finally { await f.manager.stop(); }
});

it('receives its own startup change and stops only the flow that recursively changes the same variable', async () => {
  const f = await fixture();
  try {
    await f.start('observe');
    const set = (id: string, value: number) => ({ id, type: blocks.setWorkspaceValue, fields: { TAG:'count', OPERAND:value } });
    const graph = { blocks: { languageVersion:0, blocks:[
      { id:'start', type:blocks.start, next:{block:set('first', 1)} },
      { id:'changed', type:blocks.onWorkspaceChange, fields:{ TAG:'count' }, next:{block:set('again', 2)} },
    ] } };
    expect((await f.command({type:'script.save',script:{id:'feedback',name:'反馈',graph},expectedRevision:null})).ok).toBe(true);
    expect((await f.start('feedback')).ok).toBe(true);
    await expect.poll(() => f.run('feedback')?.state).toBe('failed');
    expect(f.run('feedback')?.detail).toContain('循环更新');
    await expect.poll(() => f.run('observe')?.entries.find(e => e.log)?.detail).toBe('计数 1');
    expect(f.run('observe')?.state).toBe('waiting');
  } finally { await f.manager.stop(); }
});

it('breaks before a canvas event step and settles exactly one assignment when stepping', async () => {
  const f = await fixture();
  try {
    const source = f.workspace.masterScripts![0]!;
    const script = { ...source, graph: { ...source.graph, breakpoints:['increment'] } };
    expect((await f.command({type:'script.save',script,expectedRevision:0})).ok).toBe(true);
    expect((await f.command({type:'script.start',scriptId:source.id,revision:1})).ok).toBe(true);
    await f.interact('sample','click');
    await expect.poll(() => f.run('capture')?.state).toBe('paused');
    const paused = f.run('capture')!;
    expect(paused.current).toMatchObject({blockId:'increment',triggerLabel:'采样面板 / 采样一次 · 点击'});
    expect(f.manager.buildSnapshot().canvasSignals!.variables.count).toBe(0);
    await f.command({type:'script.resume',runId:paused.id,token:paused.pause!.token,mode:'step'});
    await expect.poll(() => f.run('capture')?.pause?.reason).toBe('step');
    expect(f.run('capture')?.current?.blockId).toBe('remember');
    expect(f.run('capture')?.completed).toBe(1);
    expect(f.manager.buildSnapshot().canvasSignals!.variables.count).toBe(1);
  } finally { await f.manager.stop(); }
});
