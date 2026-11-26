import fs from 'node:fs';
import path from 'node:path';
import { $, browser, expect } from '@wdio/globals';
import { LuaFactory } from 'wasmoon';
import type { ModbusApi } from '../../src/shared/preload-api';
import type { MasterScript, ScriptBlock } from '../../src/domain/master-script';
import { activeView as view } from '../support/workbench-controls';
import { readScriptLua } from '../support/script-lua-preview';

const folder = path.resolve('out/test-temp/master-script-portability-evidence');
const scratch = () => process.env.MODBUS_TEST_RUN_DIR!;
const scripts = () => browser.execute(async () => {
  const snapshot = await (window as unknown as { modbus: ModbusApi }).modbus.getSnapshot();
  return snapshot.workspace.masterScripts?.map(({ id, name, revision }) => ({ id, name, revision })) ?? [];
});
const runFor = (id: string) => browser.execute(async (id: string) =>
  (await (window as unknown as { modbus: ModbusApi }).modbus.getSnapshot()).scriptRuns?.[id], id);
const chain = (...blocks: ScriptBlock[]) => blocks.reduceRight<ScriptBlock | undefined>((next, block) => next ? { ...block, next: { block: next } } : block, undefined)!;

async function importFile(name: string, blocks: ScriptBlock[]) {
  const file = path.join(scratch(), name + '.json');
  fs.writeFileSync(file, JSON.stringify({ format: 'modbus-master-script', version: 1, name, graph: { blocks: { languageVersion: 0, blocks } } }));
  await view().$('input[type=file]').addValue(file);
  await view().$(`.script-file[aria-label="${name}"]`).click();
  return (await scripts()).find(s => s.name === name)!.id;
}
before(async () => {
  fs.mkdirSync(folder, { recursive: true });
  await $('nav').waitForDisplayed({ timeout: 20000 });
  await $('//nav//button[normalize-space(.)="主站脚本"]').click();
});

it('executes the actual Windows clipboard program with the same branch as the desktop VM', async () => {
  const variable: ScriptBlock = { id: 'var', type: 'mb_variable', fields: { VARIABLE: 'value' } };
  const id = await importFile('精确整数分支', [chain({ id: 'start', type: 'mb_start' }, { id: 'assign', type: 'mb_set_var', fields: { VARIABLE: 'value' },
    inputs: { OPERAND: { block: { id: 'sum', type: 'mb_arithmetic', fields: { A: 9007199254740991, B: 2, OP: 'add' } } } } },
    { id: 'if', type: 'mb_if', extraState: { elseIfCount: 0, hasElse: true }, inputs: {
      CONDITION: { block: { id: 'gt', type: 'mb_compare_values', fields: { OP: 'gt', B: 9007199254740992 }, inputs: { A: { block: variable } } } },
      YES: { block: { id: 'alarm', type: 'mb_log', fields: { TEXT: 'ALARM' } } }, NO: { block: { id: 'normal', type: 'mb_log', fields: { TEXT: 'NORMAL' } } },
    } })]);
  const source = await readScriptLua();
  await view().$('[aria-label="复制 Lua"]').click();
  await browser.waitUntil(() => browser.electron.execute((electron, text) => electron.clipboard.readText().replace(/\r/g, '') === text, source));
  const clipboard = await browser.electron.execute(electron => electron.clipboard.readText());
  expect(clipboard.replace(/\r/g, '')).toBe(source);
  fs.writeFileSync(path.join(folder, 'native-integer.lua'), clipboard);
  const engine = await new LuaFactory().createEngine();
  let printed = '';
  try { engine.global.set('print', (value: string) => { printed = value; }); engine.doStringSync(clipboard); }
  finally { engine.global.close(); }
  await view().$('button=运行').click();
  await browser.waitUntil(async () => (await runFor(id))?.state === 'passed');
  expect(printed).toBe('ALARM');
  expect((await runFor(id))!.entries.filter(e => e.log).map(e => e.detail)).toEqual([printed]);
  await view().$('[role=tablist][aria-label="检查内容"]').$('button*=变量').click();
  await expect(view().$('.script-watch [data-variable="value"] dd')).toHaveText('9007199254740993');
  await browser.saveScreenshot(path.join(folder, 'native-exact-integer.png'));
});

it('keeps the channel and places an unpositioned root away from the existing stack after editing and rereading', async () => {
  for (const channel of [7, '7']) {
    const name = 'T7-' + typeof channel;
    const id = await importFile(name, [
      chain({ id: 'start', type: 'mb_start', x: 26, y: 32 }, { id: 'arm', type: 'mb_timer_start', fields: { TIMER: channel, PERIOD: 30, MODE: 'count', COUNT: 2 } }),
      chain({ id: 'timer', type: 'mb_on_timer', fields: { TIMER: channel } }, { id: 'log', type: 'mb_log', fields: { TEXT: 'sample' } }),
    ]);
    expect(await readScriptLua()).toContain('rt.start_timer(7, 30, 2)');
    const separated = await browser.execute(() => {
      const canvas = document.querySelector('.workbench-view:not([style*="display: none"]) .blocklyBlockCanvas')!;
      const rect = (id: string) => canvas.querySelector(`g[data-id="${id}"]`)!.getBoundingClientRect();
      const a = rect('start'), b = rect('timer');
      return a.bottom <= b.top || b.bottom <= a.top || a.right <= b.left || b.right <= a.left;
    });
    expect(separated).toBe(true);
    await view().$('button=运行').click();
    await browser.waitUntil(async () => (await runFor(id))?.state === 'passed');
    const first = (await runFor(id))!;
    expect(first.entries.filter(e => e.log).map(e => e.source)).toEqual(['T7','T7']);
    await view().$('.script-lua-line[data-block-id="log"]').click();
    await view().$('g[data-id="log"] .blocklyInputField').click();
    const input = $('input.blocklyHtmlInput');
    await input.waitForDisplayed(); await input.click(); await browser.keys(['Control','a']); await browser.keys('Backspace');
    await input.addValue('edited'); await browser.keys('Enter');
    await view().$('button=保存').click();
    await browser.waitUntil(async () => (await scripts()).find(s => s.id === id)!.revision > first.scriptRevision);
    await view().$('button=运行').click();
    await browser.waitUntil(async () => { const r = await runFor(id); return r?.state === 'passed' && r.id !== first.id; });
    expect((await runFor(id))!.entries.filter(e => e.log).map(e => [e.source, e.detail])).toEqual([['T7','edited'],['T7','edited']]);
    if (typeof channel === 'number') await browser.saveScreenshot(path.join(folder, 'native-t7.png'));
  }
});

it('imports the old indented 181-block file and reimports its new native export', async () => {
  const name = '文件往返验收';
  const graph = { blocks: { languageVersion: 0, blocks: [chain({ id: 'start', type: 'mb_start' },
    ...Array.from({ length: 180 }, (_, i): ScriptBlock => ({ id: 'log-' + i, type: 'mb_log', fields: { TEXT: '测'.repeat(1000) } })))] } };
  const original = path.join(scratch(), 'legacy-large.json'), exported = path.join(scratch(), 'export-large.json');
  fs.writeFileSync(original, JSON.stringify({ format: 'modbus-master-script', version: 1, name, graph }, null, 2));
  expect(fs.statSync(original).size).toBeGreaterThan(1_000_000);
  await view().$('input[type=file]').addValue(original);
  await browser.waitUntil(async () => (await scripts()).some(s => s.name === name));
  const id = (await scripts()).find(s => s.name === name)!.id;
  const result = await browser.execute((id, file) => (window as unknown as { modbus: ModbusApi }).modbus.command({
    type: 'script.exportFile', scriptId: id, path: file,
  }), id, exported);
  expect(result.ok).toBe(true);
  expect(fs.statSync(exported).size).toBeLessThan(fs.statSync(original).size);
  await view().$('input[type=file]').addValue(exported);
  await browser.waitUntil(async () => (await scripts()).filter(s => s.name === name).length === 2);
  const docs = await browser.execute(async (name: string) => (await (window as unknown as { modbus: ModbusApi }).modbus.getSnapshot())
    .workspace.masterScripts?.filter(s => s.name === name).map((s: MasterScript) => JSON.stringify(s.graph)), name);
  expect(docs![0]).toBe(docs![1]);
});
