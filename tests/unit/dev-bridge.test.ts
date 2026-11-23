import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DevBridgeServer } from '../../src/main/services/dev-bridge';
import { AppBackendService } from '../../src/main/services/backend-service';
import { RuntimeManager } from '../../src/main/runtime/manager';
import { WorkspaceService } from '../../src/main/services/workspace';
import { HistoryStore } from '../../src/main/services/history';
import { UpdateService } from '../../src/main/services/updater';
import { createScratch } from '../../tools/test-paths.mjs';
import { connectBridge } from '../support/bridge-client';
import path from 'node:path';
import fs from 'node:fs';
import packageJson from '../../package.json';
import { templateWorkspace } from '../support/template-workspace';
import type { ColumnDataReadResult } from '../../src/shared/point-data';

describe('authenticated development Bridge',()=>{
  let root:string,workspace:WorkspaceService,manager:RuntimeManager,updater:UpdateService,backend:AppBackendService,server:DevBridgeServer,port:number;
  const clients:Array<Awaited<ReturnType<typeof connectBridge>>>=[];
  const connect=async(options?:{origin?:string;protocol?:string})=>{
    const client=await connectBridge(port,options??{origin:'http://localhost:5173',protocol:server.sessionProtocol});clients.push(client);return client;
  };
  beforeEach(async()=>{
    root=createScratch('dev-bridge-');workspace=new WorkspaceService(path.join(root,'data'));
    manager=new RuntimeManager(workspace,await HistoryStore.open(path.join(root,'history.db')));
    updater=new UpdateService({currentVersion:packageJson.version,packageKind:'zip',platform:'win32',arch:'x64',dataDirectory:root,tempDirectory:root,
      fetch:async()=>({ok:true,json:async()=>({})}) as Response,reveal:()=>{},openExternal:async()=>{},canInstall:false,bootPending:false,installMessage:null,confirmBoot:async()=>null,install:async()=>{}});
    backend=new AppBackendService(manager,updater);
    server=new DevBridgeServer(backend,{port:0,fileRoots:[root]});port=await server.start();
  });
  afterEach(async()=>{for(const client of clients.splice(0))client.close();await server.close();await manager.stop();await updater.dispose();});
  it('allows an authenticated snapshot, command, real file export and delta subscription',async()=>{
    const client=await connect();expect(client.status).toBe(101);
    await client.waitFor(message=>message.type==='hello');
    client.send({type:'snapshot',id:'snapshot'});
    expect(await client.waitFor(message=>message.type==='response'&&message.id==='snapshot')).toMatchObject({ok:true,value:{revision:expect.any(Number)}});
    client.send({type:'command',id:'edit',command:{type:'template.add',template:{id:'t',name:'Authenticated',version:'1',description:'',blocks:[],points:[]}}});
    expect(await client.waitFor(message=>message.type==='response'&&message.id==='edit')).toMatchObject({ok:true});
    expect(await client.waitFor(message=>message.type==='delta')).toMatchObject({delta:{workspace:{templates:[{name:'Authenticated'}]}}});
    const output=path.join(root,'export.workspace.json');
    client.send({type:'command',id:'export',command:{type:'workspace.exportFile',path:output}});
    expect(await client.waitFor(message=>message.type==='response'&&message.id==='export')).toMatchObject({ok:true});
    expect(JSON.parse(fs.readFileSync(output,'utf8')).templates[0].name).toBe('Authenticated');
  });
  it('saves and runs a script over the authenticated Bridge and constrains its export path', async () => {
    manager.start();
    const client = await connect();
    const request = async (id: string, command: unknown) => {
      client.send({ type: 'command', id, command });
      return client.waitFor(message => message.type === 'response' && message.id === id);
    };
    const script = { id: 'bridge-script', name: 'Bridge 脚本', graph: { blocks: { languageVersion: 0, blocks: [
      { id: 'start', type: 'mb_start', next: { block: { id: 'delay', type: 'mb_delay', fields: { MS: 1 } } } },
    ] } } };
    expect(await request('script-save', { type: 'script.save', script, expectedRevision: null })).toMatchObject({ ok: true });
    expect(await request('script-start', { type: 'script.start', scriptId: script.id, revision: 0 })).toMatchObject({ ok: true });
    expect(await client.waitFor(message => message.type === 'delta' && message.delta.scriptRun?.state === 'passed')).toMatchObject({ delta: { scriptRun: { completed: 1 } } });
    expect(await request('script-export', { type: 'script.exportFile', scriptId: script.id, path: path.join(root, 'flow.json') })).toMatchObject({ ok: true });
    expect(await request('script-outside', { type: 'script.exportFile', scriptId: script.id, path: path.join(path.dirname(root), 'outside-flow.json') })).toMatchObject({ ok: false });
  });
  it.each([undefined,'https://untrusted.audit.invalid','http://localhost:51730','http://localhost:5173.evil.invalid'])('rejects Origin %s even with a valid session',async origin=>{
    const client=await connect({origin,protocol:server.sessionProtocol});expect(client.status).toBe(403);expect(client.messages).toEqual([]);expect(server.clientCount).toBe(0);
  });
  it.each([undefined,'modbus-review.wrong'])('rejects missing or incorrect credentials: %s',async protocol=>{
    const client=await connect({origin:'http://localhost:5173',protocol});expect(client.status).toBe(403);expect(client.messages).toEqual([]);
  });
  it('rejects a token from another session and does not disclose credentials in health responses',async()=>{
    const other=new DevBridgeServer(backend,{port:0});
    const client=await connect({origin:'http://localhost:5173',protocol:other.sessionProtocol});expect(client.status).toBe(403);
    const health=await (await fetch(`http://127.0.0.1:${port}`)).text();expect(health).not.toContain(server.sessionProtocol);expect(health).not.toContain('versions');
    server.writeSessionFile(path.join(root,'session.json'));
    const session=JSON.parse(fs.readFileSync(path.join(root,'session.json'),'utf8')) as {reviewUrl:string};
    const url=new URL(session.reviewUrl);expect(url.origin).toBe('http://localhost:5173');expect(url.searchParams.has('bridgeToken')).toBe(false);expect(url.hash).toContain('bridgeToken=');
  });
  it.each(['workspace.apply','dialog.openFile','dialog.saveFile','update.install','eval_shell'])('does not expose %s to a browser client',async type=>{
    const client=await connect();client.send({type:'command',id:'forbidden',command:{type,workspace:workspace.current,accept:['json'],defaultName:'x'}});
    expect(await client.waitFor(message=>message.type==='response'&&message.id==='forbidden')).toMatchObject({ok:false});
  });
  it('rejects an outside path, a sibling prefix, a relative path and history redirection without touching them',async()=>{
    const client=await connect();const outside=createScratch('dev-bridge-outside-');
    const paths=[path.join(outside,'export.json'),`${root}-sibling/export.json`,'relative-output.json'];
    for(const [index,file] of paths.entries()) {
      client.send({type:'command',id:`path-${index}`,command:{type:'workspace.exportFile',path:file}});
      expect(await client.waitFor(message=>message.type==='response'&&message.id===`path-${index}`)).toMatchObject({ok:false,error:expect.stringContaining('审查数据目录')});
      expect(fs.existsSync(file)).toBe(false);
    }
    client.send({type:'command',id:'history',command:{type:'prefs.set',patch:{historyDbPath:path.join(outside,'private.db')}}});
    expect(await client.waitFor(message=>message.type==='response'&&message.id==='history')).toMatchObject({ok:false});expect(workspace.getPrefs().historyDbPath).toBeNull();
    fs.symlinkSync(outside,path.join(root,'link'),'junction');
    client.send({type:'command',id:'junction',command:{type:'workspace.exportFile',path:path.join(root,'link','escaped.json')}});
    expect(await client.waitFor(message=>message.type==='response'&&message.id==='junction')).toMatchObject({ok:false});expect(fs.existsSync(path.join(outside,'escaped.json'))).toBe(false);
  });
  it('retains the ordinary backend prohibition on whole-workspace replacement',async()=>{
    expect(await backend.handleCommand({type:'workspace.apply',workspace:workspace.current})).toMatchObject({ok:false});
  });
  it('rejects unknown message types after authentication',async()=>{
    const client=await connect();client.send({type:'eval_shell',id:'unknown'});
    expect(await client.waitFor(message=>message.type==='response'&&message.id==='unknown')).toMatchObject({ok:false,error:expect.stringContaining('disallowed')});
  });
  it('returns correlated binary columns over the real authenticated socket', async () => {
    workspace.adopt(templateWorkspace(), null);
    manager.start();
    for (let index = 0; index < 2000; index++) manager.cache.applyReadResult('s1::b2', { kind: 'registers', fc: 3, registers: [index, 0, 0, 0] }, 1);
    const client = await connect();
    client.send({ type: 'command', id: 'columns', command: { type: 'data.read', format: 'columns-v1', points: [{ slaveId: 's1', pointId: 'Keep' }], series: [{ slaveId: 's1', pointId: 'Keep', limit: 2000 }] } });
    const message = await client.waitFor(message => message.type === 'response' && message.id === 'columns');
    if (message.type !== 'response' || !message.ok) throw new Error('Missing binary response');
    const response = message.value as ColumnDataReadResult;
    expect(response.series['s1::Keep']!.columns.values).toEqual(new Float64Array(Array.from({ length: 2000 }, (_, index) => index)));
    expect(response.points['s1::Keep']!.engNumber).toBe(1999);
    expect(client.binaryFrames).toHaveLength(1);
    expect(client.binaryFrames[0]).toBeLessThan(51000);
    expect(response.sampleBytes).toBe(48000);
  });
});
