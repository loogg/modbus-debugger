import path from 'node:path';
import fs from 'node:fs';
import { browser, $, expect } from '@wdio/globals';
import type { ModbusApi } from '../../src/shared/preload-api';
import type { Command } from '../../src/shared/commands';
import type { MasterScript, ScriptBlock } from '../../src/domain/master-script';
import { readScriptLua } from '../support/script-lua-preview';

const view = () => $('.workbench-view:not([style*="display: none"])');
const snapshot = () => browser.execute(() => (window as unknown as { modbus: ModbusApi }).modbus.getSnapshot());
const command = (cmd: Command) => browser.execute(raw => (window as unknown as { modbus: ModbusApi }).modbus.command(raw), cmd);
const POINT = JSON.stringify(['slave-1', 'pt-speed']);
const ready = () => view().$('.blocklyWorkspace').waitForDisplayed({ timeout: 15000 });

function flow(id: string, name: string, steps: ScriptBlock[]): MasterScript {
  const chain = steps.slice().reverse().reduce<ScriptBlock | undefined>((next, block) => ({ ...block, ...(next ? { next: { block: next } } : {}) }), undefined);
  return { id, name, revision: 0, graph: { blocks: { languageVersion: 0, blocks: [{ id: id + '-entry', type: 'mb_start', x: 36, y: 26, ...(chain ? { next: { block: chain } } : {}) }] } } };
}

async function start(label: string, writes = true) {
  const binding = await snapshot();
  const device = binding.workspace.slaves.find(slave => slave.id === 'slave-1');
  const highRisk = binding.workspace.templates.find(template => template.id === device?.templateId)?.points.find(point => point.id === 'pt-speed')?.highRisk;
  await view().$(`button=${label}`).click();
  await ready();
  await view().$('button=运行').click();
  if (highRisk && writes) await $('button=确认并运行').click();
}

describe('Master scripts in the Blockly workspace', () => {
  it('docks the palette on entry, keeps it open on category clicks, and releases the space when collapsed', async () => {
    await $('nav').waitForDisplayed({ timeout: 20000 });
    await $('//nav//button[normalize-space(.)="主站脚本"]').click();
    await view().$('[aria-label="新建脚本"]').click();
    await ready();
    await browser.electron.execute(electron => electron.BrowserWindow.getAllWindows()[0]?.setSize(1024, 680));
    const category = view().$('.blocklyToolboxCategory*=条件');
    const drawer = view().$('.blocklyToolboxFlyout');
    const scrollbar = view().$('.blocklyToolboxFlyout + .blocklyFlyoutScrollbar');
    await expect(drawer).toBeDisplayed();
    await expect(view().$('[role="treeitem"][aria-selected="true"]')).toHaveText(expect.stringContaining('设备操作'));
    await category.click();
    await drawer.waitForDisplayed();
    await category.click();
    await expect(drawer).toBeDisplayed();
    const horizontal = view().$('.blocklyMainWorkspaceScrollbar.blocklyScrollbarHorizontal');
    const dockedWidth = Number(await horizontal.getAttribute('width'));
    await view().$('[aria-label="收起积木托盘"]').click();
    await drawer.waitForDisplayed({ reverse: true });
    await expect(scrollbar).toHaveAttribute('display', 'none');
    await expect(scrollbar).not.toBeDisplayed();
    await expect(view().$('.blocklyMainWorkspaceScrollbar.blocklyScrollbarVertical')).toBeDisplayed();
    expect(Number(await horizontal.getAttribute('width'))).toBeGreaterThan(dockedWidth + 140);
    await view().$('[aria-label="展开积木托盘"]').click();
    await expect(drawer).toBeDisplayed();
    await expect(view().$('[role="treeitem"][aria-selected="true"]')).toHaveText(expect.stringContaining('条件'));
    const search = view().$('[role="searchbox"][aria-label="搜索积木"]');
    await search.setValue('打印');
    await expect(drawer).toHaveText(expect.stringContaining('记录日志'));
    await search.setValue('no_such_block');
    await expect(drawer).toHaveText(expect.stringContaining('没有匹配的积木'));
    await search.click();
    await browser.keys('Escape');
    await expect(drawer).toHaveText(expect.stringContaining('状态为'));
  });

  it('toggles a condition by pointer and keyboard, persists it, and runs the selected branch', async () => {
    const script = flow('script-switch', '真假拨钮验收', [{
      type: 'mb_if', id: 'toggle-branch', fields: { BOOL_CONDITION: 'FALSE' }, extraState: { elseIfCount: 0, hasElse: true },
      inputs: {
        YES: { block: { type: 'mb_delay', id: 'when-true', fields: { MS: 5 } } },
        NO: { block: { type: 'mb_delay', id: 'when-false', fields: { MS: 10 } } },
      },
    }]);
    expect((await command({ type: 'script.save', script, expectedRevision: null })).ok).toBe(true);
    await view().$('button=真假拨钮验收').click();
    await ready();
    const toggle = view().$('g[data-id="toggle-branch"] [role="switch"]');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await browser.keys('Space');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await browser.keys('Enter');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await view().$('.blocklyToolboxCategory*=条件').click();
    const drag = await browser.execute(() => {
      const editor = document.querySelector('.workbench-view:not([style*="display: none"]) .script-editor')!;
      const label = Array.from(editor.querySelectorAll('.blocklyToolboxFlyout g[data-id] text')).find(el => el.textContent?.trim() === '从站')!;
      const grip = label.getBoundingClientRect();
      const shape = label.closest('g[data-id]')!.querySelector(':scope > .blocklyPath')!.getBoundingClientRect();
      const slot = editor.querySelector('g[data-id="toggle-branch"] .script-bool-literal > .blocklyPath')!.getBoundingClientRect();
      const x = grip.x + grip.width / 2, y = grip.y + grip.height / 2;
      return { from: { x: Math.round(x), y: Math.round(y) },
        to: { x: Math.round(x + slot.left - shape.left), y: Math.round(y + slot.top + slot.height / 2 - shape.top - shape.height / 2) } };
    });
    await browser.action('pointer', { parameters: { pointerType: 'mouse' } })
      .move(drag.from).down({ button: 0 }).move({ ...drag.to, duration: 400 }).up({ button: 0 }).perform();
    await expect(view().$('g[data-id="toggle-branch"]')).toHaveText(expect.stringContaining('从站'));
    await expect(view().$('.blocklyToolboxFlyout')).toBeDisplayed();
    await browser.keys(['Control', 'z']);
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await view().$('button=运行').click();
    await browser.waitUntil(async () => {
      const report = (await snapshot()).scriptRun;
      return report?.scriptId === script.id && report.state === 'passed';
    });
    const state = await snapshot();
    const saved = state.workspace.masterScripts!.find(item => item.id === script.id)!;
    expect(saved.graph.blocks!.blocks[0]!.next!.block.fields?.BOOL_CONDITION).toBe('TRUE');
    expect(state.scriptRun?.entries.map(entry => entry.blockId)).toEqual(['toggle-branch', 'when-true']);
  });

  it('runs a saved Blockly plan, shows generated Lua, and stops before a delayed write', async () => {
    await $('nav').waitForDisplayed({ timeout: 20000 });
    await browser.waitUntil(async () => (await snapshot()).slaveStates?.['slave-1']?.state === 'online', { timeout: 15000 });
    const write: ScriptBlock = { type: 'mb_write', id: 'set-speed', fields: { POINT, VALUE: '1677' } };
    const read: ScriptBlock = { type: 'mb_read', id: 'read-speed', fields: { POINT, TIMEOUT: 4000 } };
    const assert: ScriptBlock = { type: 'mb_assert', id: 'check-speed', fields: { TIMEOUT: 4000 }, inputs: {
      CONDITION: { block: { type: 'mb_range', id: 'range', fields: { POINT, MIN: 1676, MAX: 1678 } } },
    } };
    const pass = flow('script-pass', '转速验收回归', [write, read, assert]);
    const stop = flow('script-stop', '停止流程回归', [
      { type: 'mb_delay', id: 'delay-then-write', fields: { MS: 60000 } },
      { ...write, id: 'blocked-write', fields: { POINT, VALUE: '800' } },
    ]);
    const fail = flow('script-fail', '断言失败回归', [{
      type: 'mb_assert', id: 'fails-at-value', fields: { TIMEOUT: 4000 },
      inputs: { CONDITION: { block: { type: 'mb_compare', id: 'wrong-value', fields: { POINT, OP: 'eq', VALUE: '9500' } } } },
    }]);
    for (const script of [pass, stop, fail]) {
      expect((await command({ type: 'script.save', script, expectedRevision: null })).ok).toBe(true);
    }
    await $('//nav//button[normalize-space(.)="主站脚本"]').click();
    await start('转速验收回归');
    await browser.waitUntil(async () => (await snapshot()).scriptRun?.state === 'passed', { timeout: 15000 });
    expect((await snapshot()).points['slave-1::pt-speed']?.engNumber).toBe(1677);
    await expect(view().$('[aria-label="步骤结果"]')).toHaveText(expect.stringContaining('写入应答成功'));
    expect(await readScriptLua()).toContain('modbus.write("slave-1", "pt-speed", "1677")');
    await browser.electron.execute(electron => electron.BrowserWindow.getAllWindows()[0]?.setSize(1024, 680));
    const geometry = await browser.execute(() => {
      const node = document.querySelector('.workbench-view:not([style*="display: none"]) [aria-label="Blockly 积木工作区"]');
      const bounds = node?.getBoundingClientRect();
      return { width: bounds?.width ?? 0, height: bounds?.height ?? 0 };
    });
    expect(geometry.width).toBeGreaterThan(600);
    expect(geometry.height).toBeGreaterThan(120);
    const evidenceDir = path.resolve('out/test-temp/master-scripts-evidence');
    fs.mkdirSync(evidenceDir, { recursive: true });
    await browser.saveScreenshot(path.join(evidenceDir, 'packaged-compact.png'));
    await view().$('button=收起检查器').click();
    await start('停止流程回归');
    await expect(view().$('button=停止')).toBeDisplayed();
    await view().$('button=停止').click();
    await browser.waitUntil(async () => (await snapshot()).scriptRun?.state === 'stopped');
    expect((await snapshot()).points['slave-1::pt-speed']?.engNumber).toBe(1677);
    await start('断言失败回归', false);
    await browser.waitUntil(async () => (await snapshot()).scriptRun?.state === 'failed');
    expect((await snapshot()).scriptRun?.entries[0]?.blockId).toBe('fails-at-value');
    await expect(view().$('[aria-label="步骤结果"]')).toHaveText(expect.stringContaining('当前值 1677'));
  });

  it('uses an actual editor dropdown and retains a saved workflow across reload', async () => {
    await view().$('button=转速验收回归').click();
    await ready();
    await view().$('g[data-id="set-speed"] .blocklyField:has(.blocklyDropdownText)').click();
    await $('.blocklyDropDownDiv').waitForDisplayed();
    const choices = await $('.blocklyDropDownDiv').getText();
    expect(choices).toContain('目标转速');
    await browser.keys('Escape');
    await $('.blocklyDropDownDiv').waitForDisplayed({ reverse: true });
    const name = await view().$('input[aria-label="流程名称"]');
    await name.click();
    await browser.keys(['Control', 'a']);
    await browser.keys('Backspace');
    await name.addValue('转速验收已保存');
    await expect(name).toHaveValue('转速验收已保存');
    const save = view().$('button=保存');
    await expect(save).toBeEnabled();
    await save.click();
    await browser.waitUntil(async () => (await snapshot()).workspace.masterScripts?.find(script => script.id === 'script-pass')?.name === '转速验收已保存');
    await browser.refresh();
    await $('//nav//button[normalize-space(.)="主站脚本"]').click();
    await view().$('button=转速验收已保存').click();
    await ready();
    await expect(view().$('g[data-id="set-speed"]')).toBeDisplayed();
  });

  it('keeps the workspace and point selector available in a detached native view', async () => {
    const main = await browser.getWindowHandle();
    await $('[aria-label="弹出当前页面"]').click();
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 2);
    const child = (await browser.getWindowHandles()).find(handle => handle !== main)!;
    await browser.switchToWindow(child);
    await $('button=回入主窗口').waitForDisplayed();
    const luaLine = $('[aria-label="生成的 Lua"] [data-block-id="set-speed"]');
    if (!await luaLine.isDisplayed()) await $('button=Lua / 变量').click();
    await luaLine.click();
    await expect($('g.script-selected[data-id="set-speed"]')).toBeDisplayed();
    const field = $('g[data-id="set-speed"] .blocklyField:has(.blocklyDropdownText)');
    await field.waitForDisplayed({ timeout: 12000 });
    await field.click();
    await $('.blocklyDropDownDiv').waitForDisplayed();
    expect(await $('.blocklyDropDownDiv').getText()).toContain('目标转速');
    await browser.keys('Escape');
    await $('button=回入主窗口').click();
    await browser.switchToWindow(main);
    await ready();
  });

  it('creates a new flow and imports a portable script through the editor', async () => {
    const count = (await snapshot()).workspace.masterScripts?.length ?? 0;
    await view().$('[aria-label="新建脚本"]').click();
    await browser.waitUntil(async () => ((await snapshot()).workspace.masterScripts?.length ?? 0) === count + 1);
    const newest = (await snapshot()).workspace.masterScripts?.at(-1);
    expect(newest?.graph.blocks?.blocks[0]?.type).toBe('mb_start');
    await ready();

    const imported = flow('portable-source', '导入回归', [{ id: 'portable-delay', type: 'mb_delay', fields: { MS: 100 } }]);
    const file = path.join(process.env.MODBUS_TEST_RUN_DIR!, 'portable.modbus-script.json');
    fs.writeFileSync(file, JSON.stringify({ format: 'modbus-master-script', version: 1, name: imported.name, graph: imported.graph }), 'utf8');
    await view().$('input[type="file"]').addValue(file);
    await view().$('button=导入回归').waitForDisplayed();
    await view().$('button=导入回归').click();
    await ready();
    expect(await readScriptLua()).toBe('modbus.delay(100)');
  });

  it('shows the selected loop and paused child together, steps the outline, and locates an invalid draft', async () => {
    await $('nav').waitForDisplayed({ timeout: 20000 });
    await browser.electron.execute(electron => electron.BrowserWindow.getAllWindows()[0]?.setSize(1440, 960));
    await $('//nav//button[normalize-space(.)="主站脚本"]').click();
    await browser.waitUntil(async () => (await snapshot()).slaveStates?.['slave-1']?.state === 'online');
    const branch: ScriptBlock = { type: 'mb_if', id: 'check-device', extraState: { elseIfCount: 0, hasElse: true }, inputs: {
      CONDITION: { block: { type: 'mb_state', id: 'online', fields: { SLAVE: 'slave-1', STATE: 'online' } } },
      YES: { block: { type: 'mb_log', id: 'sample-log', fields: { TEXT: '采样转速' }, inputs: {
        OPERAND: { block: { type: 'mb_point_value', id: 'rpm', fields: { POINT } } } } } },
      NO: { block: { type: 'mb_log', id: 'offline-log', fields: { TEXT: '设备离线' } } },
    }, next: { block: { type: 'mb_delay', id: 'period', fields: { MS: 150 } } } };
    const script = flow('linked-selection', '循环采样与反馈', [{ type: 'mb_log', id: 'begin', fields: { TEXT: '开始采样' } },
      { type: 'mb_repeat', id: 'cycle', fields: { COUNT: 3 }, inputs: { BODY: { block: branch } } }]);
    script.graph.breakpoints = ['sample-log'];
    expect((await command({ type: 'script.save', script, expectedRevision: null })).ok).toBe(true);
    await view().$(`button=${script.name}`).click();
    await ready();
    await readScriptLua();
    if (await view().$('[aria-label="收起积木托盘"]').isDisplayed()) await view().$('[aria-label="收起积木托盘"]').click();
    await view().$('[aria-label="缩小积木"]').click();
    await expect(view().$('[aria-label="画布缩放"]')).toHaveText('83%');
    await view().$('[aria-label="检查器宽度"]').click();
    await browser.keys(['ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft']);
    await view().$('.script-lua-line[data-block-id="cycle"]').click();
    await view().$('button*=校验').click();
    await expect(view().$('.script-validation')).toHaveText(expect.stringContaining('静态校验通过'));
    await view().$('button=调试').click();
    await expect(view().$('[aria-label="调试暂停"]')).toHaveText(expect.stringContaining('调试起点'));
    await view().$('button=继续').waitForEnabled();
    await view().$('button=继续').click();
    await browser.waitUntil(async () => (await snapshot()).scriptRun?.current?.blockId === 'sample-log');
    const current = view().$('.script-lua-line[data-block-id="sample-log"]');
    await expect(current).toHaveAttribute('data-current', 'true');
    await expect(view().$('g.script-selected[data-id="cycle"] > .script-block-outline')).toBeDisplayed();
    await expect(view().$('g.script-current[data-id="sample-log"] > .script-block-outline')).toBeDisplayed();
    await expect(view().$('.script-range-label')).toHaveText('选中第 2–9 行');
    const evidence = path.resolve('out/test-temp/master-script-debug-evidence');
    fs.mkdirSync(evidence, { recursive: true });
    await browser.saveScreenshot(path.join(evidence, 'selection-and-current.png'));
    await current.click();
    await expect(view().$('g.script-selected.script-current[data-id="sample-log"] > .script-block-outline > .outline-core')).toBeDisplayed();
    await view().$('button=单步').click();
    await expect(view().$('.script-lua-line[data-block-id="period"]')).toHaveAttribute('data-current', 'true');
    await browser.electron.execute(electron => electron.BrowserWindow.getAllWindows()[0]?.setSize(1024, 680));
    await view().$('.script-split.is-compact').waitForDisplayed();
    await readScriptLua();
    const currentGeometry = () => browser.execute(() => {
      const active = document.querySelector('.workbench-view:not([style*="display: none"]) .script-lua-line[data-current]');
      const list = active?.closest('[role="listbox"]');
      if (!list || !active) return null;
      const row = active.getBoundingClientRect();
      const bounds = list.getBoundingClientRect();
      return { top: row.top - bounds.top, bottom: row.bottom - bounds.top, height: list.clientHeight };
    });
    await browser.waitUntil(async () => {
      const row = await currentGeometry();
      return !!row && row.top >= -1 && row.bottom <= row.height + 1;
    }).catch(async error => {
      await browser.saveScreenshot(path.join(evidence, 'compact-line-failure.png'));
      throw new Error(`${error} · 当前行位置 ${JSON.stringify(await currentGeometry())}`);
    });
    await view().$('button=停止').click();
    await view().$('button=运行').waitForDisplayed();
    await view().$('[aria-label="新建脚本"]').click();
    await ready();
    if (!await view().$('[aria-label="脚本检查器"]').isDisplayed()) await view().$('button=Lua / 变量').click();
    await view().$('button*=校验').click();
    await expect(view().$('.script-validation')).toHaveText(expect.stringContaining('至少一个步骤'));
    await view().$('button=定位积木').click();
    await expect(view().$('g.script-selected')).toHaveText(expect.stringContaining('开始'));
  });
});
