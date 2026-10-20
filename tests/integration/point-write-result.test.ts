import path from 'node:path';
import {expect,it} from 'vitest';
import {RuntimeManager} from '../../src/main/runtime/manager';
import {WorkspaceService} from '../../src/main/services/workspace';
import {HistoryStore} from '../../src/main/services/history';
import {emptyWorkspace} from '../../src/domain/model';
import {buildTcpAdu,encodeResponsePdu} from '../../src/domain/protocol';
import {FakeTransport} from '../support/fake';
import {createScratch} from '../../tools/test-paths.mjs';

async function harness() {
  const root=createScratch('write-result-'),workspace=new WorkspaceService(path.join(root,'data'));
  workspace.adopt({...emptyWorkspace(),connections:[{id:'c',name:'c',transport:'tcp',tcp:{host:'127.0.0.1',port:5020},timeoutMs:50,retries:0,reconnect:'manual',interFrameMs:0,rtsControl:'none',logLevel:'info'}],
    slaves:[{id:'s',name:'s',connectionId:'c',unitId:1,templateId:'t',enabled:true}],templates:[{id:'t',name:'t',version:'1',description:'',blocks:[{id:'b',name:'b',area:3,start:0,length:4,periodMs:60000}],
      points:[{id:'p',name:'Enable',blockId:'b',mapping:{rawType:'Bool',offset:0,registerCount:1,wordOrder:'ABCD',byteSelector:'low',bitOffset:0,bitWidth:1,stringLength:0,stringEncoding:'ascii'},scale:1,offset:0,unit:'',access:'rw',displayFormat:'auto',enumMap:{},highRisk:false,description:''}]}]},null);
  const transport=new FakeTransport('tcp');let mode:'ok'|'exception'|'timeout'|'transport'|'readback-timeout'='ok',register=17;
  transport.onResponse(request=>{
    const tid=request[0]!*256+request[1]!;
    if(request[7]===6){register=request[10]!*256+request[11]!;return [buildTcpAdu(tid,1,encodeResponsePdu({kind:'writeAck',fc:6,address:0,extra:register}))];}
    const quantity=request[10]!*256+request[11]!;
    if(mode==='readback-timeout'&&quantity===4)return null;
    if(mode==='exception')return [buildTcpAdu(tid,1,encodeResponsePdu({kind:'exception',fc:3,code:2}))];
    if(mode==='timeout')return null;
    if(mode==='transport'){transport.drop();return null;}
    return [buildTcpAdu(tid,1,encodeResponsePdu({kind:'registers',fc:3,registers:[register,0,0,0].slice(0,quantity)}))];
  });
  const manager=new RuntimeManager(workspace,await HistoryStore.open(path.join(root,'history.db')),{transportFactory:()=>transport});manager.start();
  const deadline=Date.now()+2000;
  while(!manager.buildSnapshot().points['s::p']?.hasValue){if(Date.now()>deadline)throw new Error('initial poll missing');await new Promise(resolve=>setTimeout(resolve,5));}
  return {manager,transport,setMode:(value:typeof mode)=>{mode=value;}};
}
const write={type:'point.write',slaveId:'s',pointId:'p',engineering:null,boolValue:false,stringValue:null} as const;
it.each(['exception','timeout','transport'] as const)('returns a not-sent terminal result for %s, then permits a successful corrected attempt',async mode=>{
  const h=await harness();try{
    h.setMode(mode);
    expect(await h.manager.handleCommand(write)).toMatchObject({ok:true,value:{phase:'not-sent',result:mode,exceptionCode:mode==='exception'?2:null}});
    expect(h.transport.sent.some(request=>request[7]===6)).toBe(false);
    expect(h.manager.buildSnapshot().points['s::p']?.boolValue).toBe(true);
    h.setMode('ok');if(mode==='transport')await h.manager.handleCommand({type:'connection.connect',connectionId:'c'});
    expect(await h.manager.handleCommand(write)).toMatchObject({ok:true,value:{phase:'confirmed',result:'ok'}});
    expect(h.manager.buildSnapshot().points['s::p']?.boolValue).toBe(false);
    const memory=h.manager.cache.get('s::b')?.memory;expect(memory?.kind==='registers'&&memory.registers[0]).toBe(16);
  }finally{await h.manager.stop();}
});
it('returns unknown when a sent write cannot be confirmed, preserving the previous confirmed value',async()=>{
  const h=await harness();try{
    h.setMode('readback-timeout');
    expect(await h.manager.handleCommand(write)).toMatchObject({ok:true,value:{phase:'unknown',result:'ok'}});
    expect(h.transport.sent.filter(request=>request[7]===6)).toHaveLength(1);
    expect(h.manager.buildSnapshot().points['s::p']?.boolValue).toBe(true);
  }finally{await h.manager.stop();}
});
