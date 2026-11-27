import { beforeAll, expect, it, vi } from 'vitest';
import { LuaFactory } from 'wasmoon';
import { scriptBlocks, type MasterScript } from '../../src/domain/master-script';
import { compileScriptLua } from '../../src/domain/script-lua-program';
import { MasterScriptRunner } from '../../src/main/runtime/master-script-runner';
import { loadScriptLua } from '../../src/main/runtime/script-lua-handle';
import { RuntimeNotifications } from '../../src/main/runtime/runtime-notifications';
import type { SignalValue } from '../../src/domain/canvas-script';
import type { SlaveCommunicationState } from '../../src/shared/snapshot';
import { pointChangeScript, slaveStateScript } from '../support/equipment-event-fixture';

beforeAll(loadScriptLua);
function harness() {
  const notifications = new RuntimeNotifications();
  const ref = { slaveId: 'device', pointId: 'feedback' }, blockKey = 'device::actual';
  let value: SignalValue | undefined, state: SlaveCommunicationState = 'online';
  const read = vi.fn(() => ({ value, detail: String(value) }));
  const runner = new MasterScriptRunner({
    point: () => ({ ref, blockKey, label: '反馈点', type: 'Float64', highRisk: false, identity: 'binding',
      span: { offset: 2, length: 2 }, read, validateWrite() {} }),
    slave: () => ({ label: '从站', state: () => state }), write: () => { throw new Error('unexpected write'); },
  }, new RuntimeNotifications(notifications));
  const script = pointChangeScript(ref.slaveId, ref.pointId);
  return { runner, read, script,
    start: (plan: MasterScript = script) => runner.start(runner.prepare(plan)),
    sample: (next: SignalValue | undefined, offset = 2, length = 2, origin: 'read' | 'write' = 'read', key = blockKey) => {
      value = next;
      notifications.publish({ kind: 'sample', blockKey: key, range: { offset, length }, origin });
    },
    communication: (next: SlaveCommunicationState) => { state = next; notifications.publish({ kind: 'slaveState', slaveId: ref.slaveId }); },
    logs: () => runner.snapshot?.entries.filter(e => e.log).map(e => e.detail),
  };
}

it('compares complete confirmed samples per run and preserves each transition across a breakpoint', async () => {
  const h = harness();
  const idle = h.start({ ...h.script, graph: { ...h.script.graph, breakpoints: ['point-old'] } });
  try {
    expect(idle.state).toBe('waiting');
    expect(h.read).not.toHaveBeenCalled();
    h.sample(0, 2, 1); h.sample(0, 3, 1); h.sample(8, 2, 2, 'read', 'other');
    expect(h.read).not.toHaveBeenCalled();
    h.sample(0); h.sample(0); h.sample(1, 2, 2, 'write');
    expect(h.read).toHaveBeenCalledTimes(2);
    h.sample(1); h.sample(1); h.sample(0);
    await expect.poll(() => h.runner.snapshot?.state).toBe('paused');
    expect(h.logs()).toEqual([]);
    h.runner.setBreakpoint(idle.id, 'point-old', false);
    h.runner.resume(idle.id, h.runner.snapshot!.pause!.token, 'continue');
    await expect.poll(h.logs).toEqual(['上次 0','本次 1','上次 1','本次 0']);
    expect(h.runner.snapshot!.entries[0]!.trigger?.transition).toEqual({previous:0, value:1});
    h.runner.stop(idle.id); await h.runner.settle();
    const n = h.read.mock.calls.length;
    h.sample(10);
    expect(h.read).toHaveBeenCalledTimes(n);
    h.start(); h.sample(10); h.sample(11);
    await expect.poll(h.logs).toEqual(['上次 10','本次 11']);
  } finally { h.runner.stop(); await h.runner.settle(); }
});

it.each([[false,true],['','已就绪'],[68.001,68.002]] as const)('preserves typed values and ignores invalid and disconnected samples (%s)', async (a,b) => {
  const h = harness();
  try {
    h.start(); h.sample(a); h.communication('offline'); h.communication('online');
    h.sample(b); h.sample(NaN); h.sample(a); h.sample(b);
    await expect.poll(() => h.runner.snapshot?.completed).toBe(2);
    expect(h.runner.snapshot!.entries[1]?.trigger?.transition).toEqual({previous:a, value:b});
  } finally { h.runner.stop(); await h.runner.settle(); }
});

it('exports a Lua handler with stable device IDs and rejects previous-value references outside a transition', async () => {
  const script = pointChangeScript();
  const source = compileScriptLua(script.graph).source;
  expect(source.ranges.has('point-event')).toBe(true);
  const engine = await new LuaFactory().createEngine();
  try {
    expect(engine.doStringSync(`local out = {}; print = function(k,v) out[k]=v end
      rt={previous_event_value=function() return 12 end,event_value=function() return 14 end}
      local p=(function() ${source.text} end)();local h=p.inputs[1];assert(h.slave=="slave-1" and h.point=="pt-speed" and h.event=="value_changed")
      h.handle();return out["上次"]*100+out["本次"]`)).toBe(1214);
  } finally { engine.global.close(); }
  const root = script.graph.blocks!.blocks[0]!;
  expect(() => compileScriptLua({blocks:{languageVersion:0,blocks:[{...root,type:scriptBlocks.onWorkspaceChange,fields:{TAG:'x'}}]}})).toThrow('上次事件值仅可');
});

it('queues stable communication edges while paused and suppresses retry churn and notifications after stopping', async () => {
  const h = harness(), script = slaveStateScript('device');
  try {
    const run = h.start(script);
    h.communication('online');
    expect(h.logs()).toEqual([]);
    expect(h.runner.pause(run.id)).toBe(true);
    h.communication('offline'); h.communication('offline'); h.communication('connecting'); h.communication('offline');
    h.communication('connecting'); h.communication('pending'); h.communication('online'); h.communication('online');
    expect(h.runner.snapshot?.completed).toBe(0);
    h.runner.resume(run.id,h.runner.snapshot!.pause!.token,'continue');
    await expect.poll(h.logs).toEqual(['上次 online','本次 offline','上次 offline','本次 online']);
    h.runner.stop(run.id); await h.runner.settle();
    h.communication('offline'); h.communication('online');
    expect(h.runner.snapshot?.completed).toBe(4);
    h.communication('pending'); h.start(script);
    h.communication('online');
    await expect.poll(h.logs).toEqual(['上次 pending','本次 online']);
  } finally { h.runner.stop(); await h.runner.settle(); }
});

it('validates per-direction state hats and executes both functions in an independent Lua VM', async () => {
  const model = slaveStateScript();
  const { source } = compileScriptLua(model.graph);
  const heads = model.graph.blocks!.blocks;
  expect(() => compileScriptLua({blocks:{languageVersion:0,blocks:[heads[0]!,{...heads[1]!,fields:{SLAVE:'slave-1',STATE:'online'}}]}})).toThrow('相同入口');
  expect(() => compileScriptLua({blocks:{languageVersion:0,blocks:[{...heads[0]!,fields:{SLAVE:'slave-1',STATE:'connecting'}}]}})).toThrow('STATE');
  expect(() => compileScriptLua({blocks:{languageVersion:0,blocks:[{...heads[0]!,fields:{STATE:'online'}}]}})).toThrow('请选择');
  const engine = await new LuaFactory().createEngine();
  try {
    expect(engine.doStringSync(`local previous, current, rows; rows = {}
      print = function(_,v) table.insert(rows,v) end
      rt = { previous_event_value=function() return previous end, event_value=function() return current end }
      local p=(function() ${source.text} end)();local by={}
      for _,h in ipairs(p.inputs) do assert(h.slave=="slave-1"); by[h.event]=h.handle end
      previous,current="online","offline";by.offline();previous,current="offline","online";by.online()
      return table.concat(rows,",")`)).toBe('online,offline,offline,online');
  } finally { engine.global.close(); }
});
