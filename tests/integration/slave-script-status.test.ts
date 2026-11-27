import path from 'node:path';
import { expect, it } from 'vitest';
import { workspaceSchema } from '../../src/domain/model';
import { buildTcpAdu, encodeResponsePdu } from '../../src/domain/protocol';
import { RuntimeManager } from '../../src/main/runtime/manager';
import { HistoryStore } from '../../src/main/services/history';
import { WorkspaceService } from '../../src/main/services/workspace';
import { createScratch } from '../../tools/test-paths.mjs';
import { slaveStateScript } from '../support/equipment-event-fixture';
import { FakeTransport } from '../support/fake';
import { templateWorkspace } from '../support/template-workspace';

it('uses authoritative per-unit loss and recovery, including gateway and target exception responses', async () => {
  const root = createScratch('script-unit-status-');
  const workspace = new WorkspaceService(root), model = templateWorkspace();
  const template = model.templates[0]!;
  model.connections[0] = { ...model.connections[0]!, timeoutMs:100, retries:0, reconnect:'manual' };
  model.slaves = model.slaves.slice(0,2).map(s => ({...s,enabled:true}));
  model.templates = [{ ...template, blocks:[{...template.blocks.find(b => b.id === 'b2')!, length:1, periodMs:30}],
    points:template.points.filter(p=>p.id === 'Keep') }];
  model.trendGroups = [];
  model.masterScripts = model.slaves.map(s => slaveStateScript(s.id));
  workspace.adopt(workspaceSchema.parse(model), null);
  const transport = new FakeTransport('tcp');
  let mode: 'ok' | 'silent' | 'gateway' | 'exception' = 'ok', unit1Reads = 0, gatewayReplies = 0;
  transport.onResponse(frame => {
    const unit = frame[6]!, tid = frame[0]! * 256 + frame[1]!;
    if (unit === 1) unit1Reads++;
    if (unit === 2 && mode === 'silent') return null;
    if (unit === 2 && (mode === 'gateway' || mode === 'exception')) {
      if (mode === 'gateway') gatewayReplies++;
      return [buildTcpAdu(tid,unit,encodeResponsePdu({kind:'exception',fc:3,code:mode === 'gateway' ? 11 : 2}))];
    }
    return [buildTcpAdu(tid,unit,encodeResponsePdu({kind:'registers',fc:3,registers:[unit]}))];
  });
  const manager = new RuntimeManager(workspace, await HistoryStore.open(path.join(root,'history.db')), {transportFactory:()=>transport});
  manager.start();
  const report = (id: string) => manager.buildSnapshot().scriptRuns?.[`slave-events-${id}`];
  try {
    await expect.poll(() => model.slaves.map(s=>manager.buildSnapshot().slaveStates?.[s.id]?.state)).toEqual(['online','online']);
    for (const script of model.masterScripts) expect((await manager.handleCommand({type:'script.start',scriptId:script.id,revision:0})).ok).toBe(true);
    const reads = unit1Reads;
    mode = 'silent';
    await expect.poll(() => report('s2')?.completed, {timeout:6000}).toBe(2);
    expect(manager.buildSnapshot().slaveStates?.s2?.state).toBe('offline');
    expect(manager.buildSnapshot().slaveStates?.s1?.state).toBe('online');
    expect(unit1Reads).toBeGreaterThan(reads);
    mode = 'gateway';
    await expect.poll(() => gatewayReplies, {timeout:5000}).toBeGreaterThan(1);
    expect(report('s2')?.completed).toBe(2);
    mode = 'exception';
    await expect.poll(() => report('s2')?.completed, {timeout:5000}).toBe(4);
    expect(report('s2')?.entries.filter(e=>e.log).map(e=>e.detail)).toEqual(['上次 online','本次 offline','上次 offline','本次 online']);
    expect(report('s1')?.completed).toBe(0);
    mode = 'ok';
    expect((await manager.handleCommand({type:'workspace.new'})).ok).toBe(true);
    expect(manager.buildSnapshot().scriptRuns).toEqual({});
  } finally { await manager.stop(); }
});
