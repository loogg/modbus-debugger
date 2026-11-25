import fs from 'node:fs';
import path from 'node:path';
import { $, browser, expect } from '@wdio/globals';
import type { ModbusApi } from '../../src/shared/preload-api';
import { activeView as view } from '../support/workbench-controls';
import { readScriptLua } from '../support/script-lua-preview';
import { scriptIsActive } from '../../src/shared/script-run';

const state = () => browser.execute(() => (window as unknown as { modbus: ModbusApi }).modbus.getSnapshot());
const folder = path.resolve('out/test-temp/master-events-035');

afterEach(async () => {
  const run = (await state()).scriptRun;
  if (!run || !scriptIsActive(run)) return;
  await browser.execute(id => (window as unknown as { modbus: ModbusApi }).modbus.command({ type: 'script.stop', runId: id }), run.id);
  await browser.waitUntil(async () => !scriptIsActive((await state()).scriptRun));
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
