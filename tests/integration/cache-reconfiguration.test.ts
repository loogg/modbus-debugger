import { afterEach, expect, it } from 'vitest';
import { ConnectionRuntime } from '../../src/main/runtime/connection-runtime';
import { BlockCache } from '../../src/main/runtime/block-cache';
import { DiagnosticsStore } from '../../src/main/runtime/diagnostics';
import { buildTcpAdu, encodeResponsePdu } from '../../src/domain/protocol';
import { FakeTransport } from '../support/fake';
import type { BlockDef, ConnectionDef, SlaveDef } from '../../src/domain/model';

const config: ConnectionDef = { id: 'c', name: 'c', transport: 'tcp', tcp: {host:'127.0.0.1',port:5020}, timeoutMs:100, retries:0, reconnect:'manual', interFrameMs:0, rtsControl:'none', logLevel:'info' };
const block: BlockDef = {id:'b',name:'b',area:3,start:0,length:4,periodMs:60000};
const slave: SlaveDef = {id:'s',name:'s',connectionId:'c',unitId:1,templateId:'t',enabled:true};
const runtimes: ConnectionRuntime[] = [];
const tid = (request: Uint8Array) => request[0]! * 256 + request[1]!;
const reply = (request: Uint8Array, values = [1234,0,0,0]) => buildTcpAdu(tid(request),request[6]!,encodeResponsePdu({kind:'registers',fc:request[7] as 3 | 4,registers:values}));
async function waitFor(check:()=>boolean) {
  const deadline = Date.now()+2000;
  while(!check()) { if(Date.now()>deadline) throw new Error('request did not settle'); await new Promise(resolve=>setTimeout(resolve,5)); }
}
function harness(cache = new BlockCache(), connection = config) {
  const transport = new FakeTransport('tcp');
  const diagnostics = new DiagnosticsStore();
  const runtime = new ConnectionRuntime({config:connection,transport,cache,diagnostics,hooks:{onChange(){},onState(){}}});
  runtimes.push(runtime);
  runtime.configure([{slave,block}]);
  return {runtime,transport,cache,diagnostics};
}
afterEach(async()=>{for(const runtime of runtimes.splice(0)) await runtime.stop();});

it.each(['address','length','area','unit','remove-recreate','ABA'] as const)('does not confirm an old response after %s changes',async change=>{
  const h = harness();
  await h.runtime.start();
  await waitFor(()=>h.transport.sent.length===1);
  const old = h.transport.sent[0]!;
  let nextBlock = block;
  let nextSlave = slave;
  if(change==='address'||change==='ABA') nextBlock={...block,start:100};
  if(change==='length') nextBlock={...block,length:8};
  if(change==='area') nextBlock={...block,area:4};
  if(change==='unit') nextSlave={...slave,unitId:2};
  if(change==='remove-recreate') { h.runtime.configure([]); h.cache.remove('s','b'); }
  h.runtime.configure([{slave:nextSlave,block:nextBlock}]);
  if(change==='ABA') h.runtime.configure([{slave,block}]);
  h.transport.inject(reply(old));
  await waitFor(()=>h.diagnostics.recentTransactions(10).length===1);
  expect(h.cache.get('s::b')).toMatchObject({status:'idle',lastUpdateUtc:null});
  h.transport.onResponse(request=>[reply(request,new Array(h.cache.get('s::b')!.block.length).fill(222))]);
  await h.runtime.refresh('s');
  expect(h.cache.get('s::b')).toMatchObject({status:'ok'});
  const memory=h.cache.get('s::b')!.memory;
  expect(memory.kind==='registers'&&memory.registers[0]).toBe(222);
});

it('does not apply an old timeout to the replacement target',async()=>{
  const h=harness();await h.runtime.start();await waitFor(()=>h.transport.sent.length===1);
  h.runtime.configure([{slave,block:{...block,start:100}}]);
  await waitFor(()=>h.diagnostics.recentTransactions(10).length===1);
  expect(h.cache.get('s::b')).toMatchObject({status:'idle',consecutiveErrors:0,lastUpdateUtc:null});
});

it('invalidates old cache ownership when another Runtime takes over the same key',async()=>{
  const old=harness();await old.runtime.start();await waitFor(()=>old.transport.sent.length===1);
  const replacement=harness(old.cache);
  old.transport.inject(reply(old.transport.sent[0]!));
  await waitFor(()=>old.diagnostics.recentTransactions(10).length===1);
  expect(replacement.cache.get('s::b')).toMatchObject({status:'idle',lastUpdateUtc:null});
});

it('keeps a valid response when only the display name changes',async()=>{
  const h=harness();await h.runtime.start();await waitFor(()=>h.transport.sent.length===1);
  h.runtime.configure([{slave:{...slave,name:'Renamed'},block:{...block,name:'Renamed block'}}]);
  h.transport.inject(reply(h.transport.sent[0]!));
  await waitFor(()=>h.cache.get('s::b')?.status==='ok');
  expect(h.cache.get('s::b')?.block.name).toBe('Renamed block');
});

const mapping={rawType:'Bool',offset:0,registerCount:1,wordOrder:'ABCD',byteSelector:'low',bitOffset:0,bitWidth:1,stringLength:0,stringEncoding:'ascii'} as const;
it('rechecks the binding after the asynchronous inter-frame wait before sending a write',async()=>{
  const h=harness(new BlockCache(),{...config,interFrameMs:80});
  h.transport.onResponse(request=>[reply(request)]);await h.runtime.start();await waitFor(()=>h.cache.get('s::b')?.status==='ok');
  const pending=h.runtime.writePoint({slave,block,mapping:{...mapping,rawType:'UInt16',bitWidth:16},rawValue:42,pointId:'p',readBackRange:{start:0,length:4}}).catch(error=>String(error));
  await new Promise(resolve=>setTimeout(resolve,20));
  h.runtime.configure([{slave,block:{...block,start:100}}]);
  expect(await pending).toMatch(/配置.*改变|configuration.*changed/i);
  expect(h.transport.sent.some(request=>request[7]===6)).toBe(false);
});
it('cancels a queued write when its target changes before execution',async()=>{
  const h=harness();await h.runtime.start();await waitFor(()=>h.transport.sent.length===1);
  const pending=h.runtime.writePoint({slave,block,mapping,rawValue:false,pointId:'p',readBackRange:{start:0,length:4}}).catch(error=>String(error));
  h.runtime.configure([{slave:{...slave,unitId:2},block}]);
  h.transport.inject(reply(h.transport.sent[0]!));
  expect(await pending).toMatch(/配置.*改变|configuration.*changed/i);
  expect(h.transport.sent).toHaveLength(1);
});

it('does not send a write after configuration changes during its latest-register read',async()=>{
  const h=harness();h.transport.onResponse(request=>[reply(request)]);await h.runtime.start();await waitFor(()=>h.cache.get('s::b')?.status==='ok');
  h.transport.onResponse(()=>null);
  const pending=h.runtime.writePoint({slave,block,mapping,rawValue:false,pointId:'p',readBackRange:{start:0,length:4}}).catch(error=>String(error));
  await waitFor(()=>h.transport.sent.length===2);
  h.runtime.configure([{slave,block:{...block,start:100}}]);
  h.transport.inject(reply(h.transport.sent[1]!,[17]));
  expect(await pending).toMatch(/配置.*改变|configuration.*changed/i);
  expect(h.transport.sent.some(request=>request[7]===6)).toBe(false);
});

it('does not apply an old write read-back to a replacement block',async()=>{
  const h=harness();h.transport.onResponse(request=>[reply(request)]);await h.runtime.start();await waitFor(()=>h.cache.get('s::b')?.status==='ok');
  h.transport.onResponse(request=>request[7]===6?[buildTcpAdu(tid(request),1,encodeResponsePdu({kind:'writeAck',fc:6,address:0,extra:42}))]:null);
  const pending=h.runtime.writePoint({slave,block,mapping:{...mapping,rawType:'UInt16',bitWidth:16},rawValue:42,pointId:'p',readBackRange:{start:0,length:4}}).catch(error=>String(error));
  await waitFor(()=>h.transport.sent.length===3);
  h.runtime.configure([{slave,block:{...block,start:100}}]);
  h.transport.inject(reply(h.transport.sent[2]!,[42,0,0,0]));
  await pending;
  expect(h.cache.get('s::b')).toMatchObject({status:'idle',lastUpdateUtc:null});
});
