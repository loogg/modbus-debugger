import { browser, $, $$, expect } from '@wdio/globals';
import fs from 'node:fs';
import path from 'node:path';
import { templateWorkspace } from '../support/template-workspace';
import type { ModbusApi } from '../../src/shared/preload-api';
const snap=()=>browser.execute(()=>(window as unknown as {modbus:ModbusApi}).modbus.getSnapshot());
const click=async(text:string)=>{const button=$(`//button[normalize-space(.)="${text}"]`);await button.waitForEnabled();await button.click();};
const fill=async(selector:string,value:string)=>{await $(selector).click();await browser.keys(['Control','a']);await browser.keys('Backspace');await $(selector).addValue(value);};
const block=(name:string)=>$(`//nav[@aria-label="设备模板树"]//button[contains(.,"${name}")]`);
const shot=async(name:string)=>{fs.mkdirSync('out/audit/template-shots',{recursive:true});await browser.saveScreenshot(path.resolve(`out/audit/template-shots/${name}.png`));};

describe('模板与数据块实际交互',()=>{
  beforeEach(async()=>{
    const ws=templateWorkspace();ws.connections=[];ws.slaves=[];ws.trendGroups=[];
    const result=await browser.execute(async text=>(window as unknown as {modbus:ModbusApi}).modbus.command({type:'workspace.importText',text}),JSON.stringify(ws));expect(result.ok).toBe(true);
    await $('//nav//button[normalize-space(.)="模板"]').click();
  });
  afterEach(async function(){
    if(this.currentTest?.state==='failed'){await shot('failure');fs.writeFileSync('out/audit/template-failure.txt',await $('body').getText());}
    const cancel=$('//button[normalize-space(.)="取消"]');if(await cancel.isExisting())await cancel.click();
    await browser.electron.restoreAllMocks();
  });
  it('树形导航、离线映射、新增点位实时映射及无文件框保存',async()=>{
    const fileDialog=await browser.electron.mock('dialog','showSaveDialog');await fileDialog.mockResolvedValue({canceled:true,filePath:undefined});
    await block('控制寄存器').click();await click('内存布局');
    expect(await $('[data-testid="memory-offset-0"]').getText()).toContain('Ia');expect(await $('[data-testid="memory-offset-1"]').getText()).toContain('Ia');
    expect(await $('[data-testid="memory-offset-2"]').getText()).toContain('Ib');expect(await $('[data-testid="memory-offset-3"]').getText()).toContain('Ib');
    expect(Object.keys((await snap()).blocks)).toHaveLength(0);await shot('memory-standard');
    await click('下一页');expect(await $('[data-testid="memory-offset-34"]').getText()).toContain('Late');await $('[data-testid="memory-offset-34"] button').click();
    await click('＋ 添加点位');await fill('//div[@role="group"][div[text()="名称"]]//input','新增点');await fill('//div[@role="group"][div[text()="寄存器偏移"]]//input','8');await click('保存点位');
    await browser.waitUntil(async()=>(await snap()).workspace.templates[0]!.points.some(p=>p.name==='新增点'));
    await click('内存布局');expect(await $('[data-testid="memory-offset-8"]').getText()).toContain('新增点');
    await click('保存');await browser.waitUntil(async()=>Boolean((await snap()).workspacePath));
    const state=await snap();expect(state.workspacePath!.startsWith(path.join(process.env.MODBUS_TEST_RUN_DIR!,'data','workspaces'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(state.workspacePath!,'utf8')).templates[0].points.some((p:{name:string})=>p.name==='新增点')).toBe(true);
    await browser.electron.execute(()=>true);expect(fileDialog.mock.calls).toHaveLength(0);
    await $('//button[contains(.,"返回设备模板：")]').click();expect(await $('//label[span[text()="模板名称"]]//input').getValue()).toBe('模板 A');
    await block('状态寄存器').click();expect(await $('h1').getText()).toBe('状态寄存器');await block('模板 B').click();expect(await $('//label[span[text()="模板名称"]]//input').getValue()).toBe('模板 B');
    await block('控制寄存器').click();await click('内存布局');await browser.electron.execute(electron=>electron.BrowserWindow.getAllWindows()[0]!.setSize(1024,680));
    await browser.waitUntil(async()=>await browser.execute(()=>innerWidth<=1024));expect(await browser.execute(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await shot('memory-compact');
  });
  it('模板改名、取消删除及确认删除只影响目标模板数据块，并持久化',async()=>{
    await block('模板 A').click();await fill('//label[span[text()="模板名称"]]//input','已修改模板');await click('保存模板名称');
    await browser.waitUntil(async()=>(await snap()).workspace.templates[0]!.name==='已修改模板');await block('已修改模板').waitForExist();
    await (await $$('//button[normalize-space(.)="删除数据块"]'))[0]!.click();await click('取消');expect((await snap()).workspace.templates[0]!.blocks).toHaveLength(2);
    await (await $$('//button[normalize-space(.)="删除数据块"]'))[0]!.click();await $('//*[@role="dialog"]//button[normalize-space(.)="删除数据块"]').click();
    await browser.waitUntil(async()=>(await snap()).workspace.templates[0]!.blocks.length===1);
    const state=await snap();expect(state.workspace.templates[0]!.points.map(p=>p.id)).toEqual(['Keep']);expect(state.workspace.templates[1]!.blocks[0]!.id).toBe('b1');
    await browser.waitUntil(async()=>JSON.parse(fs.readFileSync(state.workspacePath!,'utf8')).templates[0].blocks.length===1);
    const saved=JSON.parse(fs.readFileSync(state.workspacePath!,'utf8'));expect(saved.templates[0].name).toBe('已修改模板');expect(saved.templates[1].points[0].id).toBe('Other');await browser.electron.execute(electron=>electron.BrowserWindow.getAllWindows()[0]!.setSize(1440,960));await browser.waitUntil(async()=>await browser.execute(()=>innerWidth>1024));await shot('template-overview');
  });
});
