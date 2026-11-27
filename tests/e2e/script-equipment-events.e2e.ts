import fs from 'node:fs';
import path from 'node:path';
import { $, browser, expect } from '@wdio/globals';
import type { MasterScript } from '../../src/domain/master-script';
import { serializeScriptFile } from '../../src/domain/master-script';
import type { ModbusApi } from '../../src/shared/preload-api';
import { pointChangeScript } from '../support/equipment-event-fixture';
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
