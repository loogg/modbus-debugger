import { expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createScratch, snapshotLegacyPreferences, assertLegacyPreferencesUnchanged } from '../../tools/test-paths.mjs';
import { templateWorkspace } from '../support/template-workspace';
import { removeTemplateBlock, removeTemplatePoint, pointMemorySpan } from '../../src/domain/template-edit';
import { WorkspaceService } from '../../src/main/services/workspace';
import { RuntimeManager } from '../../src/main/runtime/manager';
import { HistoryStore } from '../../src/main/services/history';
import { FakeTransport } from '../support/fake';

it('maps register, byte, bit and string widths rather than cache data',()=>{
  const t=templateWorkspace().templates[0]!;const b=t.blocks[0]!;
  expect(pointMemorySpan(b,t.points[0]!)).toMatchObject({start:0,end:1,width:2});
  expect(pointMemorySpan(b,t.points[1]!)).toMatchObject({start:2,end:3});
  expect(pointMemorySpan(b,t.points[3]!)).toMatchObject({start:4,end:4,startBit:4,endBit:6});
  expect(pointMemorySpan(b,t.points[4]!)).toMatchObject({startBit:8,endBit:15});
  expect(pointMemorySpan(b,t.points[5]!)).toMatchObject({start:34,end:36,width:3});
  expect(pointMemorySpan({...b,area:1},t.points[2]!)).toMatchObject({width:1,startBit:0,endBit:0});
});
it('deletes only the chosen template block and references, preserving other templates and history definitions',()=>{
  const before=templateWorkspace();const after=removeTemplateBlock(before,'t1','b1');
  expect(after.templates[0]!.blocks.map(b=>b.id)).toEqual(['b2']);expect(after.templates[0]!.points.map(p=>p.id)).toEqual(['Keep']);
  expect(after.templates[1]).toEqual(before.templates[1]);expect(after.slaves).toEqual(before.slaves);
  expect(after.trendGroups[0]!.signals.map(s=>s.id)).toEqual(['keep','other']);expect(before.templates[0]!.blocks).toHaveLength(2);
  expect(()=>removeTemplateBlock(before,'t1','missing')).toThrow();
});
it('deletes only the chosen template point and references, preserving other points and templates',()=>{
  const before=templateWorkspace();const after=removeTemplatePoint(before,'t1','Ia');
  expect(after.templates[0]!.points.map(p=>p.id)).not.toContain('Ia');
  expect(after.templates[0]!.points.some(p=>p.id==='Ib')).toBe(true);
  expect(after.templates[1]).toEqual(before.templates[1]);
  expect(()=>removeTemplatePoint(before,'t1','missing')).toThrow();
});
it('persists block saves without a file dialog, reuses the path, and restores rename/deletion from disk',async()=>{
  const legacy=snapshotLegacyPreferences();const root=createScratch('template-save-');const service=new WorkspaceService(path.join(root,'data'));service.set(templateWorkspace());
  const history=await HistoryStore.open(path.join(root,'history.db'));const manager=new RuntimeManager(service,history,{transportFactory:()=>new FakeTransport('tcp')});
  try {
    expect(await manager.handleCommand({type:'template.save',templateId:'t1',blockId:'missing'})).toMatchObject({ok:false});expect(service.currentPath).toBeNull();
    expect(await manager.handleCommand({type:'template.save',templateId:'t1',blockId:'b1'})).toMatchObject({ok:true});
    const saved=service.currentPath!;expect(path.dirname(saved)).toBe(path.join(root,'data','workspaces'));expect(JSON.parse(fs.readFileSync(saved,'utf8')).templates[0].points[0].name).toBe('Ia');
    await manager.handleCommand({type:'template.rename',templateId:'t1',name:'已改名'});await manager.handleCommand({type:'template.deleteBlock',templateId:'t1',blockId:'b1'});await manager.handleCommand({type:'template.save',templateId:'t1'});
    expect(service.currentPath).toBe(saved);const reopened=new WorkspaceService(path.join(root,'data'));expect(reopened.loadFrom(null).ok).toBe(true);
    expect(reopened.current.templates[0]!.name).toBe('已改名');expect(reopened.current.templates[0]!.blocks.map(b=>b.id)).toEqual(['b2']);expect(reopened.current.trendGroups[0]!.signals).toHaveLength(2);
  } finally {await manager.stop();assertLegacyPreferencesUnchanged(legacy)}
});
