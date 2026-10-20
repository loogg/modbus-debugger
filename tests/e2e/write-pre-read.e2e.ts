import {browser,$,expect} from '@wdio/globals';
import {spawn,type ChildProcess} from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import type {ModbusApi} from '../../src/shared/preload-api';
import type {Workspace} from '../../src/domain/model';

const snapshot=()=>browser.execute(()=>(window as unknown as {modbus:ModbusApi}).modbus.getSnapshot());
const evidence=path.resolve('out/test-temp/audit-fixes-20261020/native');
async function freePort(){const server=net.createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address() as net.AddressInfo;await new Promise<void>(resolve=>server.close(()=>resolve()));return address.port;}
async function apply(port:number){
  const workspace=JSON.parse(fs.readFileSync('tools/e2e/demo.workspace.json','utf8')) as Workspace;
  workspace.connections=workspace.connections.filter(connection=>connection.transport==='tcp');
  workspace.connections[0]!.tcp!.port=port;workspace.connections[0]!.timeoutMs=150;workspace.connections[0]!.retries=0;
  workspace.slaves=workspace.slaves.filter(slave=>slave.connectionId==='conn-tcp');
  const result=await browser.execute(workspace=>(window as unknown as {modbus:ModbusApi}).modbus.command({type:'workspace.apply',workspace}),workspace);
  expect(result.ok).toBe(true);
  await browser.waitUntil(async()=>(await snapshot()).points['slave-1::pt-enable']?.boolValue===true,{timeout:15000});
}
async function submitOff(){
  await $('//div[text()="使能"]/following-sibling::div[2]').doubleClick();
  const input=await $('input.w-24');await input.setValue('OFF');await input.click();await browser.keys('Enter');
}
describe('写前读取失败的实际桌面终态与恢复',()=>{
  let simulator:ChildProcess|null=null;
  afterEach(async()=>{simulator?.kill();simulator=null;});
  for(const fault of ['exception','timeout'] as const)it(`${fault} ends the spinner without a write and a corrected attempt confirms the device`,async()=>{
    fs.mkdirSync(evidence,{recursive:true});
    const port=await freePort();
    simulator=spawn('python',[path.resolve('tools/simulator/modbus_sim.py'),'--port',String(port),'--fault',fault,'--fault-fc','3','--fault-quantity','1','--exception-code','2'],{stdio:['ignore','pipe','pipe']});
    await new Promise<void>((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error(output||'fault simulator start timeout')),10000);
      simulator!.stdout!.on('data',chunk=>{output+=String(chunk);if(output.includes('"event": "ready"')){clearTimeout(timer);resolve();}});
      simulator!.stderr!.on('data',chunk=>{output+=String(chunk);});simulator!.once('error',error=>{clearTimeout(timer);reject(error);});
    });
    await apply(port);
    await $('//nav//button[normalize-space(.)="实时"]').click();
    const previousTraces=new Set((await snapshot()).transactions.map(tx=>tx.traceId));
    await submitOff();
    const status=await $('span[role="status"]');await status.waitForDisplayed();
    expect(await status.getText()).toBe('未发送');expect(await status.getAttribute('title')).toContain(fault==='exception'?'0x02':'超时');
    expect(await $('.spin').isExisting()).toBe(false);
    const state=await snapshot();
    const transactions=state.transactions.filter(tx=>!previousTraces.has(tx.traceId));
    expect(state.points['slave-1::pt-enable']?.boolValue).toBe(true);
    expect(transactions.some(tx=>tx.sourceKind==='rmw-read'&&tx.sourceId==='pt-enable'&&tx.result===fault)).toBe(true);
    expect(transactions.some(tx=>tx.sourceKind==='write'&&tx.sourceId==='pt-enable')).toBe(false);
    fs.writeFileSync(path.join(evidence,`${fault}.json`),JSON.stringify({version:await browser.execute(()=>(window as unknown as {modbus:ModbusApi}).modbus.versions()),transactions:transactions.filter(tx=>tx.sourceId==='pt-enable'),point:state.points['slave-1::pt-enable']},null,2));
    await browser.saveScreenshot(path.join(evidence,`${fault}-not-sent.png`));
    // Main commands prepare the corrected fixture; the retry being verified is still submitted through UI.
    await apply(50520);await submitOff();
    await browser.waitUntil(async()=>(await snapshot()).points['slave-1::pt-enable']?.boolValue===false,{timeout:15000});
    await browser.waitUntil(async()=>!(await $('.spin').isExisting()));
    const recovered=await snapshot();expect(recovered.transactions.some(tx=>tx.sourceKind==='readback'&&tx.sourceId==='pt-enable'&&tx.result==='ok')).toBe(true);
    await browser.saveScreenshot(path.join(evidence,`${fault}-recovered.png`));
    // Restore the shared simulator so the next failure case starts at confirmed ON.
    await $('//div[text()="使能"]/following-sibling::div[2]').doubleClick();await $('input.w-24').setValue('ON');await browser.keys('Enter');
    await browser.waitUntil(async()=>(await snapshot()).points['slave-1::pt-enable']?.boolValue===true);
  });
});
