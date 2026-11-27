import fs from 'node:fs';
import path from 'node:path';
import { $, browser, expect } from '@wdio/globals';
import type { ModbusApi } from '../../src/shared/preload-api';
import { canvasScriptFixture, heldButtonFixture } from '../support/canvas-script-fixture';
import { activeView as view } from '../support/workbench-controls';

const state = () => browser.execute(() => (window as unknown as { modbus: ModbusApi }).modbus.getSnapshot());
const report = async (id: string) => (await state()).scriptRuns?.[id];
const file = (name: string) => view().$(`.script-file[aria-label="${name}"]`);
const widget = (id: string) => view().$(`[data-widget-id="${id}"]`);
const folder = path.resolve('out/test-temp/canvas-script-evidence');

it('creates a workspace variable, publishes a script variable, and links two windows to real Lua event handlers', async () => {
  fs.mkdirSync(folder, { recursive: true });
  await $('nav').waitForDisplayed({ timeout: 20000 });
  const model = canvasScriptFixture();
  model.masterScripts![0]!.publishedVariables = [];
  const result = await browser.execute((text: string) => (window as unknown as { modbus: ModbusApi }).modbus.command({ type:'workspace.importText', text }), JSON.stringify(model));
  expect(result.ok).toBe(true);
  await $('//nav//button[normalize-space(.)="主站脚本"]').click();
  await file('采样逻辑').click();
  await view().$('[aria-label="检查内容"]').$('button*=变量').click();
  await view().$('button*=新建变量').click();
  await view().$('[aria-label="工作区变量名"]').setValue('alarm_threshold');
  const initial = view().$('[aria-label="变量初值"]');
  await initial.click(); await browser.keys(['Control','a']); await browser.keys('Backspace'); await initial.addValue('42');
  await view().$('button=保存变量').click();
  await browser.waitUntil(async () => (await state()).workspace.variables?.some(v => v.name === 'alarm_threshold' && v.initial === 42) ?? false);
  await view().$('[aria-label="公开 last_count 到画布"]').click();
  await view().$('button=保存').click();
  await browser.waitUntil(async () => (await state()).workspace.masterScripts?.[0]?.publishedVariables?.includes('last_count') ?? false);
  for (const [id, name] of [['capture','采样逻辑'],['observe','变更记录']] as const) {
    await file(name).click();
    await view().$('button=运行').click();
    await browser.waitUntil(async () => (await report(id))?.state === 'waiting');
  }
  await $('//nav//button[normalize-space(.)="组态画布"]').click();
  await widget('sample').$('button').waitForEnabled();
  const main = await browser.getWindowHandle();
  await $('[aria-label="打开当前页面副本"]').click();
  await $('[aria-label="弹出当前页面"]').click();
  await browser.waitUntil(async () => (await browser.getWindowHandles()).some(id => id !== main));
  const popup = (await browser.getWindowHandles()).find(id => id !== main)!;
  try {
    await browser.switchToWindow(popup);
    await widget('sample').$('button').click();
    await expect(widget('total').$('.canvas-value')).toHaveText('1');
    await expect(widget('last').$('.canvas-value')).toHaveText('1');
    await widget('enabled').$('[role=switch]').click();
    await widget('note').$('input').setValue('已采样');
    await widget('note').$('button=提交').click();
    await expect(widget('note')).toHaveText(expect.stringContaining('当前值：已采样'));
    await browser.saveScreenshot(path.join(folder, 'canvas-window.png'));
    await browser.switchToWindow(main);
    await $('//button[@role="tab" and contains(normalize-space(.),"组态画布") and not(starts-with(normalize-space(.),"↗"))]').click();
    await expect(widget('total').$('.canvas-value')).toHaveText('1');
    await expect(widget('enabled').$('[role=switch]')).toHaveAttribute('aria-checked','true');
    await expect(widget('note')).toHaveText(expect.stringContaining('已采样'));
    expect((await report('capture'))!.entries.filter(e => e.log).map(e => e.detail)).toEqual(['按下 true','松开 false','点击 true','开关 true','备注 已采样']);
    expect((await report('observe'))!.entries.filter(e => e.log).map(e => e.detail)).toEqual(['计数 1']);
  } finally {
    await browser.switchToWindow(main);
    const detached = await $('//button[@role="tab" and starts-with(normalize-space(.),"↗")]');
    if (await detached.isExisting()) { await detached.click(); await $('[aria-label="回入主窗口"]').click(); }
  }
  await $('//nav//button[normalize-space(.)="主站脚本"]').click();
  await file('采样逻辑').click();
  const row = view().$('[aria-label="步骤结果"]').$('li*=点击 true');
  await row.$('button=定位源控件').click();
  await expect(widget('sample')).toHaveAttribute('data-located','true');
  await view().$('button=编辑').click();
  await widget('sample').click();
  await view().$('button*=定位事件积木 · 采样逻辑 · 点击').click();
  await expect(view().$('g.script-selected[data-id="on-click"]')).toExist();
  await view().$('button=停止').click();
  await browser.waitUntil(async () => (await report('capture'))?.state === 'stopped');
  await expect(view().$('[aria-label="运行结果"]')).toHaveText(expect.stringContaining('已停止'));
  await browser.saveScreenshot(path.join(folder, 'script-log.png'));
});

it('configures a button in the inspector and cancels a pointer released outside without clicking', async () => {
  const model = canvasScriptFixture();
  model.canvases![0]!.widgets[0]!.binding = null;
  const imported = await browser.execute((text: string) => (window as unknown as { modbus: ModbusApi }).modbus.command({ type:'workspace.importText', text }), JSON.stringify(model));
  expect(imported.ok).toBe(true);
  await $('//nav//button[normalize-space(.)="组态画布"]').click();
  await view().$('button=编辑').click();
  await widget('sample').click();
  await view().$('[aria-label="操作方式"]').selectByVisibleText('触发脚本事件');
  const name = view().$('[aria-label="控件名称"]');
  await name.click(); await browser.keys(['Control','a']); await browser.keys('Backspace'); await name.addValue('采样触发器');
  await view().$('button=保存画布').click();
  await browser.waitUntil(async () => (await state()).workspace.canvases?.[0]?.widgets[0]?.label === '采样触发器');
  await view().$('button=运行').click();
  await expect(widget('sample').$('button')).toBeDisabled();
  await $('//nav//button[normalize-space(.)="主站脚本"]').click();
  await file('采样逻辑').click();
  await view().$('button=运行').click();
  await browser.waitUntil(async () => (await report('capture'))?.state === 'waiting');
  await $('//nav//button[normalize-space(.)="组态画布"]').click();
  const button = widget('sample').$('button');
  await button.waitForEnabled();
  const { x, y } = await button.getLocation(), { width, height } = await button.getSize();
  await browser.performActions([{ type:'pointer', id:'sample-pointer', parameters:{pointerType:'mouse'}, actions:[
    {type:'pointerMove',duration:0,x:Math.round(x+width/2),y:Math.round(y+height/2)},
    {type:'pointerDown',button:0},
    {type:'pointerMove',duration:100,x:Math.round(x+width+15),y:Math.round(y+height/2)},
    {type:'pointerUp',button:0},
  ] }]);
  await browser.releaseActions();
  await browser.waitUntil(async () => (await report('capture'))?.entries.some(e => e.log && e.blockId === 'cancelled') ?? false);
  expect((await report('capture'))!.entries.filter(e => e.log).map(e => e.detail)).toEqual(['按下 true','取消 false']);
  expect((await state()).canvasSignals!.variables.count).toBe(0);
  await button.click();
  await expect(widget('total').$('.canvas-value')).toHaveText('1');
  expect((await report('capture'))!.entries.at(-1)?.trigger?.label).toContain('采样触发器');
});

it('balances a native popup press across a main-window save and cancels a second press on native close', async () => {
  await $('nav').waitForDisplayed({ timeout: 20000 });
  const imported = await browser.execute((text: string) => (window as unknown as { modbus: ModbusApi }).modbus.command({
    type: 'workspace.importText', text,
  }), JSON.stringify(heldButtonFixture()));
  expect(imported.ok).toBe(true);
  await $('//nav//button[normalize-space(.)="主站脚本"]').click();
  await file('采样逻辑').click(); await view().$('button=运行').click();
  await browser.waitUntil(async () => (await report('capture'))?.state === 'waiting');
  await $('//nav//button[normalize-space(.)="组态画布"]').click();
  const main = await browser.getWindowHandle(), original = await $('.workbench-tab.is-active [role=tab]').getAttribute('id');
  await $('[aria-label="打开当前页面副本"]').click(); await $('[aria-label="弹出当前页面"]').click();
  await browser.waitUntil(async () => (await browser.getWindowHandles()).some(h => h !== main));
  const popup = (await browser.getWindowHandles()).find(h => h !== main)!;
  const pointer = 'held-canvas-button';
  const press = async () => {
    const target = widget('sample').$('button');
    await target.waitForEnabled();
    const {x,y} = await target.getLocation(), {width,height} = await target.getSize();
    await browser.performActions([{type:'pointer',id:pointer,parameters:{pointerType:'mouse'},actions:[
      {type:'pointerMove',duration:0,x:Math.round(x + width / 2),y:Math.round(y + height / 2)}, {type:'pointerDown',button:0},
    ]}]);
    await expect(widget('held-value').$('.canvas-value')).toHaveText('true');
  };
  try {
    await browser.switchToWindow(main); await $(`[id="${original}"]`).click();
    await view().$('button=编辑').click();
    const name = view().$('[aria-label="画布名称"]');
    await name.click(); await browser.keys(['Control','a']); await browser.keys('Backspace'); await name.addValue('异窗保存后的画布');
    await view().$('button=保存画布').waitForEnabled();
    // Complete the other editor's real Save action without stealing the popup's pointer capture.
    await browser.execute(() => {
      const pane = document.querySelector('.workbench-view:not([style*="display: none"])')!;
      const save = Array.from(pane.querySelectorAll('button')).find(el => el.textContent?.trim() === '保存画布')!;
      const api = (window as unknown as {modbus:ModbusApi}).modbus;
      void (async () => {
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          if ((await api.getSnapshot()).canvasSignals?.variables.held === true) { save.click(); return; }
          await new Promise(resolve => setTimeout(resolve, 35));
        }
      })();
    });
    await browser.switchToWindow(popup); await press();
    await browser.waitUntil(async () => (await view().getText()).includes('异窗保存后的画布'), {timeout:12000});
    await browser.performActions([{type:'pointer',id:pointer,parameters:{pointerType:'mouse'},actions:[{type:'pointerUp',button:0}]}]);
    await browser.releaseActions();
    await expect(widget('held-value').$('.canvas-value')).toHaveText('false');
    await expect(widget('total').$('.canvas-value')).toHaveText('1');
    await press();
    await browser.electron.execute(electron => { electron.BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('viewHost='))?.close(); });
    await browser.switchToWindow(main);
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 1);
    await browser.waitUntil(async () => (await state()).canvasSignals?.variables.held === false);
    expect((await report('capture'))?.entries.filter(e => e.log).map(e => e.detail)).toEqual(['按下 true','松开 false','点击 true','按下 true','取消 false']);
  } finally {
    await browser.switchToWindow(main);
    await browser.releaseActions();
    const detached = await $('//button[@role="tab" and starts-with(normalize-space(.),"↗")]');
    if (await detached.isExisting()) { await detached.click(); await $('[aria-label="回入主窗口"]').click(); }
    const run = await report('capture');
    if (run) await browser.execute(id => (window as unknown as {modbus:ModbusApi}).modbus.command({type:'script.stop',runId:id}),run.id);
  }
});
