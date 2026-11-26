import fs from 'node:fs';
import path from 'node:path';
import { $, browser, expect } from '@wdio/globals';
import type { ModbusApi } from '../../src/shared/preload-api';
import { activeView as view } from '../support/workbench-controls';
import { readScriptLua } from '../support/script-lua-preview';
import { scriptIsActive } from '../../src/shared/script-run';
import { parallelScript } from '../support/parallel-script-fixture';

const state = () => browser.execute(() => (window as unknown as { modbus: ModbusApi }).modbus.getSnapshot());
const folder = path.resolve('out/test-temp/master-events-035');

afterEach(async () => {
  for (const run of Object.values((await state()).scriptRuns ?? {})) if (scriptIsActive(run))
    await browser.execute(id => (window as unknown as { modbus: ModbusApi }).modbus.command({ type: 'script.stop', runId: id }), run.id);
  await browser.waitUntil(async () => !Object.values((await state()).scriptRuns ?? {}).some(scriptIsActive));
});

it('dispatches a host cycle inside a running startup loop and inspects it in the packaged editor', async () => {
  fs.mkdirSync(folder, { recursive: true });
  await $('nav').waitForDisplayed({ timeout: 20000 });
  await $('//nav//button[normalize-space(.)="主站脚本"]').click();
  await view().$('[aria-label="新建脚本"]').click();
  await expect(view().$('.blocklyBlockCanvas')).toHaveText(expect.stringContaining('on_start'));
  await expect(view().$('.blocklyBlockCanvas')).toHaveText(expect.stringContaining('接入步骤后启用'));
  await view().$('input[type=file]').addValue(path.resolve('docs/examples/independent-on-run.modbus-script.json'));
  await view().$('button=启动循环与独立周期回调').click();
  const lua = await readScriptLua();
  expect(lua).toContain('local function on_run()');
  expect(lua).toContain('coroutine.yield()');
  expect(lua).not.toContain('start_timer');
  fs.writeFileSync(path.join(folder, 'on-run.lua'), lua);
  await view().$('.script-lua-line[data-block-id="tick"] .script-lua-gutter').click();
  await view().$('button=设置断点').click();
  await view().$('button=运行').click();
  await browser.waitUntil(async () => (await state()).scriptRun?.state === 'paused');
  let current = (await state()).scriptRun!;
  expect(current.current).toMatchObject({ blockId: 'tick', source: 'on_run' });
  expect(current.events).toMatchObject({ onRun: { periodMs: 100, calls: 1 }, timers: [] });
  expect(Number(current.pause?.variables.find(v => v.name === 'work_count')?.value)).toBeGreaterThan(0);
  await expect(view().$('.script-lua-line[data-current][data-block-id="tick"]')).toBeDisplayed();
  await view().$('[role="tablist"][aria-label="检查内容"]').$('button*=变量').click();
  await expect(view().$('.script-watch [data-variable="heartbeat_count"] dd')).toHaveText('0');
  await view().$('button=单步').click();
  await browser.waitUntil(async () => (await state()).scriptRun?.pause?.reason === 'step');
  await expect(view().$('.script-watch [data-variable="heartbeat_count"] dd')).toHaveText('1');
  await view().$('button=移除断点').click();
  await view().$('.blocklyToolboxCategory*=事件').click();
  await browser.saveScreenshot(path.join(folder, 'cycle-paused.png'));
  await view().$('button=继续').click();
  await browser.waitUntil(async () => (await state()).scriptRun?.state === 'passed');
  current = (await state()).scriptRun!;
  expect(current.events?.onRun?.calls).toBe(3);
  await view().$('button=只看日志').click();
  expect(current.eventLog?.filter(e => e.log && e.source === 'on_run')).toHaveLength(3);
  await expect(view().$('.script-watch [data-variable="heartbeat_count"] dd')).toHaveText('3');
  await expect(view().$('[aria-label="步骤结果"]')).toHaveText(expect.stringContaining('启动循环结束，心跳总数 3'));
  await browser.waitUntil(async () => (await view().$$('[aria-label="步骤结果"] li')).length === 4);
  await view().$('[aria-label="收起积木托盘"]').click();
  await view().$('[aria-label="居中积木"]').click();
  await browser.saveScreenshot(path.join(folder, 'cycle-completed.png'));
});

it('runs a three-shot timer without on_run using confirmed samples from the independent simulator', async () => {
  const point = JSON.stringify(['slave-1', 'pt-temp']);
  const file = path.join(process.env.MODBUS_TEST_RUN_DIR!, 'timer-sample.json');
  fs.writeFileSync(file, JSON.stringify({ format: 'modbus-master-script', version: 1, name: '定时温度读数',
    graph: { blocks: { languageVersion: 0, blocks: [
      { id: 'entry', type: 'mb_start', x: 25, y: 25, next: { block: { id: 'arm', type: 'mb_timer_start', fields: { TIMER: '0', PERIOD: 400, MODE: 'count', COUNT: 3 } } } },
      { id: 'timer', type: 'mb_on_timer', fields: { TIMER: '0' }, x: 25, y: 190, next: { block: {
        id: 'reading', type: 'mb_log', fields: { TEXT: '定时采样' }, inputs: { OPERAND: { block: { id: 'temp', type: 'mb_point_value', fields: { POINT: point } } } },
      } } },
    ] } } }));
  await view().$('input[type=file]').addValue(file);
  await view().$('button=定时温度读数').click();
  const lua = await readScriptLua();
  expect(lua).toContain('rt.start_timer(0, 400, 3)');
  expect(lua).toContain('local function on_timer(_timer_id)');
  fs.writeFileSync(path.join(folder, 'timer.lua'), lua);
  await view().$('.blocklyToolboxCategory*=定时器').click();
  await expect(view().$('.blocklyToolboxFlyout')).toHaveText(expect.stringContaining('正在运行'));
  await view().$('button=运行').click();
  await expect(view().$('[aria-label="运行结果"]')).toHaveText(expect.stringContaining('等待事件'));
  await browser.waitUntil(async () => (await state()).scriptRun?.state === 'passed', { timeout: 10000 });
  const snapshot = await state();
  const logs = snapshot.scriptRun!.entries.filter(e => e.log);
  expect(logs).toHaveLength(3);
  for (const entry of logs) { expect(entry.source).toBe('T0'); expect(entry.detail).toMatch(/定时采样 -?\d/); }
  expect(snapshot.scriptRun?.events?.onRun).toBe(null);
  expect(snapshot.transactions.some(tx => tx.functionCode === 4 && tx.result === 'ok')).toBe(true);
  await browser.saveScreenshot(path.join(folder, 'timer-completed.png'));
});

it('operates two running script sheets independently across desktop windows', async () => {
  await $('nav').waitForDisplayed({ timeout: 20000 });
  await $('//nav//button[normalize-space(.)="主站脚本"]').click();
  const folder = path.resolve('out/test-temp/master-multi-036');
  fs.mkdirSync(folder, { recursive: true });
  const station = parallelScript('a', '温度采样', 100, 0);
  const monitor = parallelScript('b', '周期监测', 190, 300);
  const reports = async () => Object.values((await state()).scriptRuns ?? {});
  const main = await browser.getWindowHandle();
  const original = await $('.workbench-tab.is-active [role=tab]').getAttribute('id');
  try {
    for (const script of [station, monitor]) {
      const file = path.join(process.env.MODBUS_TEST_RUN_DIR!, script.id + '.modbus-script.json');
      fs.writeFileSync(file, JSON.stringify({ format: 'modbus-master-script', version: 1, name: script.name, graph: script.graph }));
      await view().$('input[type=file]').addValue(file);
      await view().$(`.script-file[aria-label="${script.name}"]`).click();
      await view().$('button=运行').click();
      await browser.waitUntil(async () => (await reports()).some(r => r.scriptName === script.name && r.eventLog?.some(e => e.log && e.source === 'T0')));
    }
    await expect(view().$$('.script-file-status')).toBeElementsArrayOfSize(2);
    await $('[aria-label="打开当前页面副本"]').click();
    await view().$(`.script-file[aria-label="${station.name}"]`).click();
    await $('[aria-label="弹出当前页面"]').click();
    await browser.waitUntil(async () => (await browser.getWindowHandles()).some(id => id !== main));
    const popup = (await browser.getWindowHandles()).find(id => id !== main)!;
    await browser.switchToWindow(popup);
    const stopPosition = await view().$('button=停止').getLocation();
    await expect(view().$('button=单步')).toBeDisabled();
    await view().$('button=暂停').click();
    await expect(view().$('button=继续')).toBeDisplayed();
    expect(await view().$('button=停止').getLocation()).toEqual(stopPosition);
    await expect(view().$$('.script-file-status')).toBeElementsArrayOfSize(2);
    await browser.saveScreenshot(path.join(folder, 'detached-paused.png'));
    await browser.switchToWindow(main);
    await $(`[id="${original}"]`).click();
    await expect(view().$(`.script-file[aria-label="${station.name}"] .script-file-status`)).toHaveText('已暂停');
    const paused = (await reports()).find(r => r.scriptName === station.name)!;
    const before = (await reports()).find(r => r.scriptName === monitor.name)!.events!.onRun!.calls;
    await browser.waitUntil(async () => (await reports()).find(r => r.scriptName === monitor.name)!.events!.onRun!.calls > before + 2);
    expect((await reports()).find(r => r.id === paused.id)?.completed).toEqual(paused.completed);
    await browser.saveScreenshot(path.join(folder, 'desktop-simultaneous.png'));
    await view().$('button=停止').click();
    await browser.waitUntil(async () => (await reports()).find(r => r.scriptName === monitor.name)?.state === 'stopped');
    await browser.switchToWindow(popup);
    await view().$('button=继续').click();
    await view().$('button=停止').click();
    await expect(view().$('[aria-label="运行结果"]')).toHaveText(expect.stringContaining('已停止'));
  } finally {
    await browser.switchToWindow(main);
    const detached = await $('//button[@role="tab" and starts-with(normalize-space(.), "↗")]');
    if (await detached.isExisting()) { await detached.click(); await $('[aria-label="回入主窗口"]').click(); }
  }
});

it('edits a flow watchdog, preserves a live budget and applies the saved value when debugging again', async () => {
  await $('nav').waitForDisplayed({ timeout: 20000 });
  await $('//nav//button[normalize-space(.)="主站脚本"]').click();
  const script = parallelScript('custom-watchdog', '看门狗周期验收', 120, 0);
  const file = path.join(process.env.MODBUS_TEST_RUN_DIR!, 'legacy-watchdog.modbus-script.json');
  fs.writeFileSync(file, JSON.stringify({ format: 'modbus-master-script', version: 1, name: script.name, graph: script.graph }));
  await view().$('input[type=file]').addValue(file);
  await view().$(`.script-file[aria-label="${script.name}"]`).click();
  const field = view().$('input[aria-label="主回调超时（毫秒）"]');
  const enterTimeout = async (value: string) => {
    // An input event on deletion keeps React's controlled value in sync with ChromeDriver.
    await field.click();
    await browser.keys(['Control', 'a']);
    await browser.keys('Backspace');
    await field.addValue(value);
    await expect(field).toHaveValue(value);
  };
  await expect(field).toHaveValue('1000');
  await enterTimeout('0');
  await expect(view().$('[role="alert"]')).toHaveText(expect.stringContaining('10–10000 ms'));
  await expect(view().$('button=运行')).toBeDisabled();
  await enterTimeout('2400');
  await view().$('button=运行').click();
  const report = async () => Object.values((await state()).scriptRuns ?? {}).find(r => r.scriptName === script.name);
  await browser.waitUntil(async () => (await report())?.callbackTimeoutMs === 2400);
  await enterTimeout('80');
  await view().$('button=保存').click();
  await browser.waitUntil(async () => (await state()).workspace.masterScripts?.find(s => s.name === script.name)?.callbackTimeoutMs === 80);
  expect((await report())!.callbackTimeoutMs).toBe(2400);
  await expect(view().$('[aria-label="运行结果"]')).toHaveText(expect.stringContaining('本次主回调超时 2400 ms'));
  const evidence = path.resolve('out/test-temp/script-watchdog-037');
  fs.mkdirSync(evidence, { recursive: true });
  await browser.saveScreenshot(path.join(evidence, 'desktop-active-budget.png'));
  await view().$('button=停止').click();
  await view().$('button=调试').click();
  await browser.waitUntil(async () => { const run = await report(); return run?.state === 'paused' && run.callbackTimeoutMs === 80; });
});
