import { browser, $, expect } from '@wdio/globals';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ModbusApi } from '../../src/shared/preload-api';
const bytes=Buffer.from('PK\x03\x04 E2E verified update');
const name='modbus-debugger-99.0.0-win-x64.zip';
const latest={tag_name:'v99.0.0',draft:false,prerelease:false,published_at:'2026-09-15T00:00:00Z',body:'测试更新说明：多个修复。',assets:[{name,size:bytes.length,state:'uploaded',digest:`sha256:${createHash('sha256').update(bytes).digest('hex')}`,browser_download_url:`https://github.com/loogg/modbus-debugger/releases/download/v99.0.0/${name}`}]};
interface Fixture { latest:typeof latest; bytes:number[]; mode:'ok'|'error'|'slow'|'corrupt'; requests:string[]; revealed:string|null; opened:string|null }
const state=async()=> (await browser.execute(async()=>({update:(await (window as unknown as {modbus:ModbusApi}).modbus.getSnapshot()).update!}))).update;
const click=(label:string)=>$(`//button[normalize-space(.)="${label}"]`).click();
const waitText=(text:string)=>browser.waitUntil(async()=> (await $('body').getText()).includes(text));
const waitPhase=(phase:string)=>browser.waitUntil(async()=>(await state()).phase===phase,{timeout:25000});
async function fixture(mode:Fixture['mode']='ok') {
  fs.rmSync(path.join(process.env.MODBUS_TEST_RUN_DIR!,'data','updates',name),{force:true});
  await browser.electron.execute((electron,value)=>{ void electron; (globalThis as unknown as {updateFixture:Fixture}).updateFixture=value; },{latest,bytes:[...bytes],mode,requests:[],revealed:null,opened:null});
  // Stub only the HTTP boundary. Native Response streams cannot be serialized by mock call-history tracking.
  await browser.electron.execute((electron)=>{
    const ctx=globalThis as unknown as {updateFixture:Fixture; originalUpdateFetch?:typeof electron.net.fetch};
    ctx.originalUpdateFetch ??= electron.net.fetch;
    electron.net.fetch=(url,init)=>{
      const f=ctx.updateFixture; const address=String(url); f.requests.push(address);
      if(address==='https://api.github.com/repos/loogg/modbus-debugger/releases/latest') return Promise.resolve(f.mode==='error'?new Response(null,{status:429}):Response.json(f.latest));
      if(address!==f.latest.assets[0]!.browser_download_url) return ctx.originalUpdateFetch!.call(electron.net,url,init);
      if(f.mode==='slow') return Promise.resolve(new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(f.bytes.slice(0,4)));}})));
      return Promise.resolve(new Response(new Uint8Array(f.mode==='corrupt'?f.bytes.map(()=>0):f.bytes)));
    };
  });
  const reveal=await browser.electron.mock('shell','showItemInFolder'); await reveal.mockImplementation((file)=>{(globalThis as unknown as {updateFixture:Fixture}).updateFixture.revealed=file;});
  const external=await browser.electron.mock('shell','openExternal'); await external.mockImplementation(async(url)=>{(globalThis as unknown as {updateFixture:Fixture}).updateFixture.opened=url;});
}
async function check() {
  await browser.waitUntil(async()=>await $('//button[normalize-space(.)="重新检查"]').isExisting() || await $('//button[normalize-space(.)="检查更新"]').isExisting());
  await click(await $('//button[normalize-space(.)="重新检查"]').isExisting()?'重新检查':'检查更新');
}
describe('关于与 GitHub 更新（真实 UI / Main / 文件 I/O）',()=>{
  before(async()=>{ fs.mkdirSync('out/audit/update-shots',{recursive:true}); await $('//nav//button[contains(.,"关于")]').click(); });
  afterEach(async()=>{
    await browser.execute(async()=>({result:await (window as unknown as {modbus:ModbusApi}).modbus.command({type:'update.cancel'})}));
    await browser.waitUntil(async()=>!['checking','downloading','verifying'].includes((await state()).phase));
    await browser.electron.execute((electron)=>{ const ctx=globalThis as unknown as {originalUpdateFetch?:typeof electron.net.fetch}; if(ctx.originalUpdateFetch){electron.net.fetch=ctx.originalUpdateFetch;delete ctx.originalUpdateFetch;} });
    await browser.electron.restoreAllMocks();
  });
  it('displays the actual application version and checks the real GitHub Releases endpoint',async()=>{
    const versions=await browser.execute(()=>(window as unknown as {modbus:ModbusApi}).modbus.versions());
    expect(await $('[data-testid="app-version"]').getText()).toBe(`v${versions.app}`);
    await check(); await browser.waitUntil(async()=>!['idle','checking'].includes((await state()).phase),{timeout:25000});
    const update=await state(); expect(['current','available']).toContain(update.phase); expect(update.latest?.url).toContain('https://github.com/loogg/modbus-debugger/releases/tag/');
    const asset=update.latest?.asset;
    expect(asset).not.toBeNull();
    const probe=await browser.electron.execute(async(electron,url)=>{
      const response=await electron.net.fetch(url,{redirect:'follow',credentials:'omit'}); const target=response.url;
      const reader=response.body!.getReader(); const prefix:number[]=[];
      while(prefix.length<4){const chunk=await reader.read(); if(chunk.done)break; prefix.push(...chunk.value.slice(0,4-prefix.length));}
      await reader.cancel().catch(()=>{}); return {status:response.status,host:target?new URL(target).hostname:null,prefix};
    },asset!.url);
    expect(probe.status).toBe(200); expect(probe.prefix.slice(0,2)).toEqual([80,75]);
    if(probe.host) expect(['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com']).toContain(probe.host);
    await browser.saveScreenshot(path.resolve('out/audit/update-shots/current.png'));
  });
  it('checks and downloads from release metadata, verifies bytes, and opens the exact downloaded file location',async()=>{
    await fixture(); await check(); await waitPhase('available');
    await waitText('测试更新说明'); await click('下载 v99.0.0'); await waitPhase('downloaded');
    const file=(await state()).downloadPath!; expect(fs.readFileSync(file)).toEqual(bytes); expect(file).toContain(path.join('data','updates'));
    await click('打开下载目录'); expect(await browser.electron.execute((electron)=>{void electron; return (globalThis as unknown as {updateFixture:Fixture}).updateFixture.revealed;})).toBe(file);
    await click('更新日志'); expect(await browser.electron.execute((electron)=>{void electron; return (globalThis as unknown as {updateFixture:Fixture}).updateFixture.opened;})).toBe('https://github.com/loogg/modbus-debugger/releases/tag/v99.0.0');
    await browser.saveScreenshot(path.resolve('out/audit/update-shots/downloaded.png'));
    fs.unlinkSync(file); // Fixture cleanup only, never delete a user-selected path.
  });
  it('continues across page switches and cancels a partial download through the button',async()=>{
    await fixture('slow'); await check(); await waitPhase('available'); await click('下载 v99.0.0');
    await browser.waitUntil(async()=>(await state()).receivedBytes>0);
    const txBefore=await browser.execute(async()=> (await (window as unknown as {modbus:ModbusApi}).modbus.getSnapshot()).transactions.at(-1)?.traceId);
    await browser.pause(650);
    const txAfter=await browser.execute(async()=> (await (window as unknown as {modbus:ModbusApi}).modbus.getSnapshot()).transactions.at(-1)?.traceId);
    expect(txAfter).not.toBe(txBefore);
    await $('//nav//button[contains(.,"设备")]').click(); await $('//nav//button[contains(.,"关于")]').click();
    expect(Number(await $('progress').getAttribute('value'))).toBeGreaterThan(0); await browser.saveScreenshot(path.resolve('out/audit/update-shots/progress.png')); await click('取消'); await waitPhase('available');
    const folder=path.join(process.env.MODBUS_TEST_RUN_DIR!,'temp','updates'); expect(fs.readdirSync(folder).some(file=>file.endsWith('.part'))).toBe(false);
  });
  it('shows rate-limit and checksum errors and allows a subsequent check to recover',async()=>{
    await fixture('error'); await check(); await waitPhase('error'); await waitText('GitHub 请求受限');
    await browser.electron.execute((electron)=>{void electron; (globalThis as unknown as {updateFixture:Fixture}).updateFixture.mode='corrupt';});
    await check(); await waitPhase('available'); await click('下载 v99.0.0'); await waitPhase('error'); await waitText('校验失败');
    const folder=path.join(process.env.MODBUS_TEST_RUN_DIR!,'data','updates'); expect(fs.readdirSync(folder)).toHaveLength(0);
  });
  it('keeps About and all update actions visible at the compact window size',async()=>{
    await fixture(); await check(); await waitPhase('available');
    const pp=await (browser as unknown as {getPuppeteer():Promise<{targets():Array<{type():string;page():Promise<{createCDPSession():Promise<{send(method:string,params:unknown):Promise<unknown>}>}>}>}>}).getPuppeteer();
    const page=await pp.targets().find(t=>t.type()==='page')!.page(); const cdp=await page.createCDPSession();
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1024,height:680,deviceScaleFactor:1,mobile:false});
    const visible=await browser.execute(()=>['关于','下载 v99.0.0'].every(text=>{
      const el=[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()===text); if(!el)return false;
      const r=el.getBoundingClientRect();return r.width>0&&r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth;
    }));
    expect(visible).toBe(true);
    const widths=await browser.execute(()=>{const main=document.querySelector('main')!;return {client:main.clientWidth,scroll:main.scrollWidth};});
    expect(widths.scroll).toBeLessThanOrEqual(widths.client+1);
    await browser.saveScreenshot(path.resolve('out/audit/update-shots/compact.png'));
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:1,mobile:false});
  });

});
