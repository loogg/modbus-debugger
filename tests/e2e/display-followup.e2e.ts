import { browser, $, $$, expect } from '@wdio/globals';
import fs from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../../src/domain/model';
import type { ModbusApi } from '../../src/shared/preload-api';
const snap = () => browser.execute(() => (window as unknown as {modbus:ModbusApi}).modbus.getSnapshot());
const click = (name:string) => $(`//button[normalize-space(.)="${name}"]`).click();
const rail = async (name:string) => { await $(`//nav//button[contains(.,"${name}")]`).click(); };
const fill = async (selector:string,value:string) => { const el=await $(selector); await el.click(); await browser.keys(['Control','a']); await browser.keys('Backspace'); await el.addValue(value); };
const waitText = (value:string) => browser.waitUntil(async()=> (await $('body').getText()).includes(value),{timeout:15000});
const filters = ['成功','超时','Modbus 异常','其他错误'];
const toggle = (name:string) => $(`//label[normalize-space(.)="${name}"]//button[@role="checkbox"]`).click();
const resultCells = () => $$('tbody tr td:nth-child(7)').map(el=>el.getText());
const timezone = async (label:string) => {
  await rail('设置'); await $('//div[text()="时区"]/following-sibling::button[1]').click();
  await $(`//*[@role="option"][normalize-space(.)="${label}"]`).click();
};

describe('字符串、结果筛选、时区与多信号专项回归',()=>{
  before(async()=>{ fs.mkdirSync('out/audit/followup-shots',{recursive:true}); });
  afterEach(async()=>{
    await browser.execute(async()=> (window as unknown as {modbus:ModbusApi}).modbus.command({type:'prefs.set',patch:{timezone:'local'}}));
  });
  beforeEach(async()=>{
    const ws:Workspace=JSON.parse(fs.readFileSync('tools/e2e/demo.workspace.json','utf8'));
    ws.connections[0]!.timeoutMs=100; ws.connections[0]!.retries=0;
    ws.trendGroups[0]!.signals=ws.templates[0]!.points.map((p,i)=>({id:`many-${i}`,pointRef:{connectionId:'conn-tcp',slaveId:'slave-1',pointId:p.id},visible:true}));
    expect((await browser.execute(workspace=>(window as unknown as {modbus:ModbusApi}).modbus.command({type:'workspace.apply',workspace}),ws)).ok).toBe(true);
    await browser.pause(350);
    await rail('通信'); await click('报文');
    for(const name of filters) {
      const checkbox=await $(`//label[normalize-space(.)="${name}"]//button[@role="checkbox"]`);
      if(await checkbox.getAttribute('data-state')==='unchecked') await checkbox.click();
    }
  });
  it('真实成功/超时/异常报文分别由对应侧栏筛选控制',async()=>{
    await rail('设备'); await $('//button[text()="临时读取"]').click();
    await fill('input[aria-label="起始地址"]','128'); await click('读取'); await waitText('设备返回异常');
    await fill('input[aria-label="起始地址"]','0'); await fill('input[aria-label="从站"]','247'); await click('读取'); await waitText('读取超时');
    await fill('input[aria-label="从站"]','1'); await click('读取'); await waitText('读取成功');
    await rail('通信'); await click('暂停');
    const initial=await resultCells(); expect(initial).toContain('成功'); expect(initial).toContain('超时'); expect(initial).toContain('异常');
    for(const name of filters) await toggle(name);
    expect(await resultCells()).toHaveLength(0);
    for(const [name,result] of [['成功','成功'],['超时','超时'],['Modbus 异常','异常']]) {
      await toggle(name!); const values=await resultCells(); expect(values).toContain(result); expect(values.every(v=>v===result || v==='已发送')).toBe(true); await toggle(name!);
    }
    await toggle('其他错误'); expect(await resultCells()).toHaveLength(0);
    for(const name of filters.slice(0,3)) await toggle(name);
    await browser.saveScreenshot(path.resolve('out/audit/followup-shots/results.png'));
  });
  it('同一报文在 UTC 与上海时区显示不同时间，原始时间戳不变',async()=>{
    await browser.waitUntil(async()=> (await snap()).transactions.length>0);
    const tx=(await snap()).transactions.at(-1)!;
    const expected=(zone:string)=>new Intl.DateTimeFormat('en-GB',{timeZone:zone,hourCycle:'h23',hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3}).format(new Date(tx.startUtc));
    for(const [choice,zone] of [['UTC','UTC'],['Asia/Shanghai（UTC+8）','Asia/Shanghai']]) {
      await timezone(choice!); await rail('通信');
      await fill('input[placeholder*="搜索"]',tx.traceId);
      await browser.waitUntil(async()=> (await $$('tbody tr')).length===(tx.responseAduHex?2:1));
      expect(await $('//tbody/tr[td[4][normalize-space(.)="TX"]]/td[1]').getText()).toBe(expected(zone!));
      expect((await snap()).transactions.find(t=>t.traceId===tx.traceId)?.startUtc).toBe(tx.startUtc);
    }
    await timezone('跟随系统');
  });
  it('9个混合信号包含6条数值曲线，跨5种单位完整显示，历史字符串不重复叠字',async()=>{
    await rail('趋势'); await click('图表');
    const charts = () => browser.execute(()=>[...document.querySelectorAll('[data-chart-units]')].map(el=>({units:JSON.parse(el.getAttribute('data-chart-units')!),count:Number(el.getAttribute('data-series-count'))})));
    await browser.waitUntil(async()=> (await charts()).reduce((sum,c)=>sum+c.count,0)===6,{timeout:15000});
    expect(await charts()).toHaveLength(5);
    expect((await charts()).find(c=>c.units[0]==='V')?.count).toBe(2);
    await browser.saveScreenshot(path.resolve('out/audit/followup-shots/many-signals.png'));
    const enumTrack = await $('[data-state-track="enum"]');
    await enumTrack.waitForDisplayed({ timeout: 15000 });
    expect(await enumTrack.getAttribute('aria-label')).toContain('模式');
    await enumTrack.$('svg rect').waitForExist({ timeout: 15000 });
    await enumTrack.scrollIntoView();
    fs.mkdirSync('out/audit/figma-current',{recursive:true});
    await browser.saveScreenshot(path.resolve('out/audit/figma-current/11-trend-chart-enum-track.png'));
    await enumTrack.saveScreenshot(path.resolve('out/audit/figma-current/11-enum-track-detail.png'));
    await click('信号');
    for(const name of ['电机电流','目标转速','状态字']) await $(`//tbody/tr[.//*[text()="${name}"]]//button[@title="隐藏图表"]`).click();
    await click('图表');
    await browser.waitUntil(async()=> (await charts()).length===1);
    expect((await charts())[0]).toEqual({units:['V','°C'],count:3});
    await click('● 开始记录'); await browser.pause(1300); await click('■ 停止记录');
    await rail('历史'); await click('状态与事件'); await waitText('固件版本');
    const track=await $('[data-state-track="string"]');
    expect(await track.$$('[data-string-label]')).toHaveLength(1);
    expect(await track.$('[data-string-label]').getText()).toBe('V2.4.0');
    const bounds=await browser.execute(()=>{
      const track=document.querySelector('[data-state-track="string"]')!;
      const svg=track.querySelector('svg')!;
      return {width:svg.clientWidth,labels:[...track.querySelectorAll<SVGTextElement>('[data-string-label],[data-string-time]')].map(t=>{const b=t.getBBox();return {left:b.x,right:b.x+b.width};})};
    });
    expect(bounds.labels.every(b=>b.left>=150 && b.right<=bounds.width-16)).toBe(true);
    await track.saveScreenshot(path.resolve('out/audit/followup-shots/string-track.png'));
    const session=(await snap()).sessions[0]!; expect(session.signalCount).toBe(9);
  });
});
