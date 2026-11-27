import fs from 'node:fs';
import path from 'node:path';
import { $, browser, expect } from '@wdio/globals';
import type { MasterScript } from '../../src/domain/master-script';
import { serializeScriptFile } from '../../src/domain/master-script';
import type { ModbusApi } from '../../src/shared/preload-api';
import { pointChangeScript, slaveStateScript } from '../support/equipment-event-fixture';
import { simulatorRegister } from '../support/tcp-simulator-register';
import { activeView as view } from '../support/workbench-controls';
import { readScriptLua } from '../support/script-lua-preview';

const snapshot = () => browser.execute(() => (window as unknown as { modbus: ModbusApi }).modbus.getSnapshot());
const evidence = path.resolve('out/test-temp/device-events');
async function openScript(script: MasterScript) {
  await $('nav').waitForDisplayed({timeout:20000});
  await $('//nav//button[normalize-space(.)="主站脚本"]').click();
  const file = path.join(process.env.MODBUS_TEST_RUN_DIR!, script.id + '.modbus-script.json');
  fs.writeFileSync(file, serializeScriptFile(script));
  await view().$('input[type=file]').addValue(file);
  await view().$(`.script-file[aria-label="${script.name}"]`).click();
  fs.mkdirSync(evidence, {recursive:true});
  return (await snapshot()).workspace.masterScripts!.find(s => s.name === script.name)!.id;
}
async function nextRead(value: number) {
  const key = 'slave-1::blk-ctrl', before = (await snapshot()).blocks[key]?.lastUpdateUtc;
  await browser.waitUntil(async () => {
    const s = await snapshot();
    return s.points['slave-1::pt-speed']?.engNumber === value && !!s.blocks[key]?.lastUpdateUtc && s.blocks[key]!.lastUpdateUtc !== before;
  }, {timeout:10000});
}

it('reacts exactly twice to 0,0,1,1,0 from an independent TCP slave in the packaged editor', async () => {
  const original = simulatorRegister();
  let id: string | undefined;
  try {
    simulatorRegister(0);
    id = await openScript(pointChangeScript());
    expect(await readScriptLua()).toContain('event = "value_changed"');
    await expect(view().$('g[data-id="point-event"]')).toHaveText(expect.stringContaining('目标转速'));
    await browser.waitUntil(() => browser.execute(() => {
      const page = document.querySelector('.workbench-view:not([style*="display: none"])');
      const hat = page?.querySelector('g[data-id="point-event"] > .blocklyPath')?.getBoundingClientRect();
      const palette = page?.querySelector('.blocklyToolboxFlyout .blocklyFlyoutBackground')?.getBoundingClientRect();
      return !!hat && !!palette && hat.left >= palette.right - 1;
    }), { timeoutMsg:'The point event hat remained behind the toolbox' });
    await view().$('button=运行').click();
    await nextRead(0);
    for (const value of [0, 1, 1, 0]) { simulatorRegister(value); await nextRead(value); }
    const report = async () => (await snapshot()).scriptRuns?.[id!];
    await browser.waitUntil(async () => (await report())?.completed === 4);
    expect((await report())!.entries.map(row => row.detail)).toEqual(['上次 0','本次 1','上次 1','本次 0']);
    await expect(view().$('[aria-label="运行结果"]')).toHaveText(expect.stringContaining('1 → 0'));
    await browser.saveScreenshot(path.join(evidence,'point-change-desktop.png'));
  } finally {
    if (id) {
      const run = (await snapshot()).scriptRuns?.[id];
      if (run) await browser.execute(runId => (window as unknown as {modbus:ModbusApi}).modbus.command({type:'script.stop',runId}),run.id);
    }
    simulatorRegister(original);
  }
});

it('waits for actual Unit 1 offline and online transitions across a native disconnect and reconnect', async () => {
  const id = await openScript(slaveStateScript());
  const control = (connect: boolean) => browser.execute(on => (window as unknown as {modbus:ModbusApi}).modbus.command({
    type: on ? 'connection.connect' : 'connection.disconnect', connectionId:'conn-tcp',
  }),connect);
  const report = async () => (await snapshot()).scriptRuns?.[id];
  try {
    await browser.waitUntil(async () => (await snapshot()).slaveStates?.['slave-1']?.state === 'online', {timeout:10000});
    const lua = await readScriptLua();
    expect(lua).toContain('event = "online"'); expect(lua).toContain('event = "offline"');
    await view().$('button=运行').click();
    await browser.waitUntil(async () => (await report())?.state === 'waiting');
    expect((await report())!.completed).toBe(0);
    expect((await control(false)).ok).toBe(true);
    await browser.waitUntil(async () => (await report())?.completed === 2);
    expect((await control(false)).ok).toBe(true);
    expect((await control(true)).ok).toBe(true);
    await browser.waitUntil(async () => (await report())?.completed === 4, {timeout:10000});
    await nextRead((await snapshot()).points['slave-1::pt-speed']!.engNumber!);
    expect((await report())!.entries.map(e=>e.detail)).toEqual(['上次 online','本次 offline','上次 offline','本次 online']);
    await expect(view().$('[aria-label="运行结果"]')).toHaveText(expect.stringContaining('离线 → 在线'));
    await view().$('.script-lua-line[data-block-id="on-offline"]').click();
    await expect(view().$('g.script-selected[data-id="on-offline"]')).toExist();
    await browser.saveScreenshot(path.join(evidence,'slave-status-desktop.png'));
  } finally {
    const run = await report();
    if (run) await browser.execute(runId=>(window as unknown as {modbus:ModbusApi}).modbus.command({type:'script.stop',runId}),run.id);
    await control(true);
  }
});

it('locates a disabled point in the editor before runtime and starts the same saved binding after re-enabling its slave', async () => {
  await $('nav').waitForDisplayed({timeout:20000});
  const model = (await snapshot()).workspace, script = pointChangeScript();
  const disabled = { ...model.slaves.find(s => s.id === 'slave-1')!, enabled:false };
  model.slaves = model.slaves.map(s => s.id === disabled.id ? disabled : s);
  model.masterScripts = [script];
  const imported = await browser.execute((text:string) => (window as unknown as {modbus:ModbusApi}).modbus.command({type:'workspace.importText',text}),JSON.stringify(model));
  expect(imported.ok).toBe(true);
  await $('//nav//button[normalize-space(.)="主站脚本"]').click();
  await view().$(`.script-file[aria-label="${script.name}"]`).click();
  const tabs = view().$('[aria-label="检查内容"]');
  await tabs.$('button*=校验').click();
  const issue = view().$('.script-validation');
  await expect(issue).toHaveText(expect.stringContaining('从站已停用'));
  const expected = await issue.$('p').getText();
  const preflight = await browser.execute(async id => {
    const reply = await (window as unknown as {modbus:ModbusApi}).modbus.command({type:'script.plan',scriptId:id,revision:0});
    return reply.ok ? '' : reply.error;
  }, script.id);
  expect(preflight).toBe(expected);
  await issue.$('button=定位积木').click();
  await expect(view().$('g.script-selected[data-id="point-event"]')).toExist();
  await tabs.$('button*=Lua').click();
  await view().$('button=运行').click();
  await expect(issue).toHaveText(expect.stringContaining(expected));
  expect((await snapshot()).scriptRuns?.[script.id]).toBeUndefined();
  fs.mkdirSync(evidence,{recursive:true});
  await browser.saveScreenshot(path.join(evidence,'disabled-point-validation.png'));
  const enabled = await browser.execute(slave => (window as unknown as {modbus:ModbusApi}).modbus.command({
    type:'slave.upsert',slave:{...slave,enabled:true},expected:slave,
  }), disabled);
  expect(enabled.ok).toBe(true);
  await expect(issue).toHaveText(expect.stringContaining('静态校验通过'));
  await view().$('button=运行').click();
  await browser.waitUntil(async () => (await snapshot()).scriptRuns?.[script.id]?.state === 'waiting');
  expect((await snapshot()).workspace.masterScripts![0]!.revision).toBe(0);
  await view().$('button=停止').click();
});
