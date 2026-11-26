import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { $, browser, expect } from '@wdio/globals';
import type { Workspace } from '../../src/domain/model';
import type { Command } from '../../src/shared/commands';
import type { ModbusApi } from '../../src/shared/preload-api';
import type { ScriptRunEntry } from '../../src/shared/script-run';
import { readScriptLua } from '../support/script-lua-preview';

const scope = () => $('.workbench-view:not([style*="display: none"])');
const state = () => browser.execute(() => (window as unknown as { modbus: ModbusApi }).modbus.getSnapshot());
const command = (cmd: Command) => browser.execute(raw => (window as unknown as { modbus: ModbusApi }).modbus.command(raw), cmd);

it('imports and runs the consecutive temperature alarm against independent FC04 samples', async () => {
  await $('nav').waitForDisplayed({ timeout: 20000 });
  const previous = (await state()).workspacePath;
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const sim = spawn('python', ['-u', path.resolve('tools/simulator/modbus_sim.py'), '--port', String(port),
    '--units', '1', '--static', '--temperature-cycle'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  sim.stdout.on('data', data => { output += String(data); });
  sim.stderr.on('data', data => { output += String(data); });
  try {
    await browser.waitUntil(() => output.includes('"event": "ready"'), { timeout: 15000, timeoutMsg: '温度模拟器未就绪' });
    const ws: Workspace = JSON.parse(fs.readFileSync('docs/examples/demo.workspace.json', 'utf8'));
    ws.connections[0]!.tcp!.port = port;
    ws.templates[0]!.blocks.find(block => block.id === 'blk-tel')!.periodMs = 180;
    const file = path.join(process.env.MODBUS_TEST_RUN_DIR!, 'temperature.workspace.json');
    fs.writeFileSync(file, JSON.stringify(ws));
    expect((await command({ type: 'workspace.open', path: file })).ok).toBe(true);
    await $('//nav//button[normalize-space(.)="主站脚本"]').click();
    await scope().$('input[type="file"]').addValue(path.resolve('docs/examples/consecutive-temperature.modbus-script.json'));
    await scope().$('button=连续三次温度超限告警').click();
    await scope().$('.blocklyWorkspace').waitForDisplayed();
    const lua = await readScriptLua();
    expect(lua).toContain('over_limit_count = _ops.add(_ops.read(over_limit_count, "over_limit_count"), 1)');
    expect(lua).toMatch(/local function exceeds_limit\(temperature, threshold\)\s+return _ops\.gt\(_ops\.read\(temperature, "temperature"\), _ops\.read\(threshold, "threshold"\)\)\s+end/);
    expect(lua).toContain('if exceeds_limit(_ops.read(current_temperature, "current_temperature"), 70) then');
    expect(lua).toContain('log_overheat(_ops.read(current_temperature, "current_temperature"), 70)');
    const watch = scope().$('[role="tab"]*=变量');
    const watchEvidence = path.resolve('out/test-temp/script-variables-review');
    fs.mkdirSync(watchEvidence, { recursive: true });
    const mainWatch = scope().$('.script-watch section[aria-label="主流程"]');
    await watch.click();
    await expect(mainWatch.$('[data-variable="over_limit_count"] dd')).toHaveText('未赋值');
    await scope().$('.blocklyToolboxCategory*=变量').click();
    await expect(scope().$('.blocklyToolboxFlyout')).toHaveText(expect.stringContaining('current_temperature'));
    await browser.saveScreenshot(path.join(watchEvidence, 'variables-ready.png'));
    await scope().$('[role="tab"]*=Lua').click();
    await scope().$('.script-lua-line[data-block-id="over-limit"][aria-label$="，end"] .script-lua-gutter').click();
    await browser.keys('ArrowDown');
    await expect(scope().$('g.script-selected[data-id="record-alarm"]')).toBeDisplayed();
    await watch.click();
    await scope().$('button=运行').click();
    await expect(mainWatch.$('[data-variable="current_temperature"] dd[data-assigned]')).toBeDisplayed();
    await browser.waitUntil(async () => ((await state()).scriptRun?.entries.filter(row => row.log).length ?? 0) >= 4,
      { timeout: 18000, interval: 150, timeoutMsg: '未收到四段超限告警' });
    await scope().$('button=停止').click();
    await browser.waitUntil(async () => (await state()).scriptRun?.state === 'stopped');
    await expect(mainWatch.$('header')).toHaveText(expect.stringContaining('已停止'));
    const result = await state();
    expect(result.transactions.some(tx => tx.functionCode === 4 && tx.result === 'ok')).toBe(true);
    expect(result.transactions.some(tx => tx.sourceKind === 'write')).toBe(false);
    const samples: { temperature: number; rows: ScriptRunEntry[] }[] = [];
    for (const row of result.scriptRun!.entries) {
      if (row.blockId === 'capture-temperature' && row.result === 'ok') {
        samples.push({ temperature: Number(row.detail.split(' = ')[1]), rows: [] });
      } else samples.at(-1)?.rows.push(row);
    }
    let consecutive = 0;
    let alarms = 0;
    let interrupted = false;
    let sustained = false;
    for (const { temperature, rows } of samples.slice(0, -1)) {
      expect(Number.isFinite(temperature)).toBe(true);
      if (temperature === 70 && consecutive === 2) interrupted = true;
      consecutive = temperature > 70 ? consecutive + 1 : 0;
      if (consecutive > 3) sustained = true;
      const assign = rows.find(row => row.blockId === (consecutive ? 'increment' : 'reset-count'));
      expect(assign?.detail).toBe('变量「over_limit_count」 = ' + consecutive);
      const logs = rows.filter(row => row.log);
      expect(logs).toHaveLength(consecutive === 3 ? 1 : 0);
      if (logs.length) {
        alarms++;
        expect(rows).toContainEqual(expect.objectContaining({ blockId: 'report-temperature', result: 'ok' }));
        expect(logs[0]!.detail).toBe('温度连续三次超限，超出阈值（°C） ' + (temperature - 70));
      }
    }
    expect(alarms).toBeGreaterThanOrEqual(3);
    expect(interrupted).toBe(true);
    expect(sustained).toBe(true);
    const logRow = scope().$('[aria-label="步骤结果"]').$('button*=温度连续三次超限');
    await logRow.click();
    await expect(scope().$('g.script-selected[data-id="alarm"]')).toBeDisplayed();
    const folder = path.resolve('out/test-temp/lua-native-review');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'confirmed-temperature-run.json'), JSON.stringify(samples, null, 2));
    await browser.saveScreenshot(path.join(folder, 'temperature-alarm.png'));
    const callLine = scope().$('.script-lua-line[data-block-id="report-temperature"]');
    await callLine.click();
    await scope().$('button=定位函数定义').click();
    await expect(scope().$('g.script-selected[data-id="record-alarm"]')).toBeDisplayed();
    await callLine.click();
    await scope().$('button=设置断点').click();
    await scope().$('button=运行').click();
    await browser.waitUntil(async () => (await state()).scriptRun?.pause?.reason === 'breakpoint', { timeout: 12000 });
    expect((await state()).scriptRun?.current?.blockId).toBe('report-temperature');
    await scope().$('button=单步').click();
    await browser.waitUntil(async () => (await state()).scriptRun?.current?.blockId === 'alarm');
    expect((await state()).scriptRun?.pause?.variables).toContainEqual({ name: 'threshold', value: '70' });
    await expect(scope().$('.script-lua-line[data-current][data-block-id="alarm"]')).toBeDisplayed();
    await watch.click();
    const callWatch = scope().$('.script-watch section[aria-label="log_overheat"]');
    await expect(callWatch.$('header')).toHaveText(expect.stringContaining('本次调用'));
    await expect(callWatch.$('[data-variable="threshold"] dd')).toHaveText('70');
    await expect(mainWatch.$('[data-variable="over_limit_count"] dd')).toHaveText('3');
    await callWatch.$('button=threshold').click();
    await expect(scope().$('g.script-selected[data-id="record-alarm"]')).toBeDisplayed();
    await expect(scope().$('g.script-current[data-id="alarm"]')).toBeDisplayed();
    expect(await browser.execute(() => {
      const current = document.querySelector('.workbench-view:not([style*="display: none"]) .script-current > .script-location-arrow')!;
      const frame = document.querySelector('.workbench-view:not([style*="display: none"]) g[data-id="record-alarm"] > .blocklyPath')!;
      return current.getBoundingClientRect().right < frame.getBoundingClientRect().left;
    })).toBe(true);
    await browser.saveScreenshot(path.join(watchEvidence, 'variables-at-breakpoint.png'));
    await scope().$('[role="tab"]*=Lua').click();
    await scope().$('.blocklyToolboxCategory*=函数').click();
    await scope().$('[aria-label="调试暂停"] summary').click();
    await browser.saveScreenshot(path.join(folder, 'function-step.png'));
    await browser.electron.execute(electron => electron.BrowserWindow.getAllWindows()[0]?.setSize(1024, 680));
    await scope().$('.script-split.is-compact').waitForDisplayed();
    await readScriptLua();
    await browser.waitUntil(() => browser.execute(() => {
      const rail = document.querySelector<HTMLElement>('.workbench-view:not([style*="display: none"]) .blocklyToolbox')!;
      const list = rail.querySelector<HTMLElement>('.blocklyToolboxCategoryGroup')!;
      const item = rail.querySelector('.blocklyToolboxSelected')!.getBoundingClientRect();
      const bounds = list.getBoundingClientRect();
      const toggle = rail.querySelector('button')!.getBoundingClientRect();
      return list.scrollWidth <= list.clientWidth + 1 && item.top >= bounds.top - 1 && item.bottom <= bounds.bottom + 1 && bounds.bottom <= toggle.top + 1;
    }));
    await watch.click();
    await browser.waitUntil(() => browser.execute(() => {
      const panel = document.querySelector('.workbench-view:not([style*="display: none"]) .script-watch-body');
      if (!panel) return false;
      const bounds = panel.getBoundingClientRect();
      const rows = [...panel.querySelectorAll('dd')];
      return rows.length === 6 && rows.every(row => row.getBoundingClientRect().bottom <= bounds.bottom + 1);
    }));
    await browser.saveScreenshot(path.join(watchEvidence, 'variables-compact.png'));
    await scope().$('button=停止').click();
  } finally {
    try { if (previous) await command({ type: 'workspace.open', path: previous }); }
    finally { sim.kill(); }
  }
});
