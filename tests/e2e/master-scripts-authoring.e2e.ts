import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { $, browser, expect } from '@wdio/globals';
import type { ScriptBlock } from '../../src/domain/master-script';
import type { ModbusApi } from '../../src/shared/preload-api';
import { readScriptLua } from '../support/script-lua-preview';

const viewSelector = '.workbench-view:not([style*="display: none"])';
const view = () => $(viewSelector);
const snapshot = () => browser.execute(() => (window as unknown as { modbus: ModbusApi }).modbus.getSnapshot());
const targetValue = 1683;
const evidenceDir = path.resolve('out/test-temp/master-script-palette-evidence');
const hex = (value: string | null | undefined) => (value ?? '').replace(/\s/g, '').toLowerCase();

function simulatorRegister(restore?: number): number {
  // A separate client reads the disposable simulator's holding register over TCP.
  const source = [
    'import sys',
    'from pymodbus.client import ModbusTcpClient',
    'with ModbusTcpClient("127.0.0.1", port=50520, timeout=2) as client:',
    '    if len(sys.argv) > 1:',
    '        result = client.write_register(6, int(sys.argv[1]), device_id=1)',
    '        assert not result.isError(), result',
    '    result = client.read_holding_registers(6, count=1, device_id=1)',
    '    assert not result.isError(), result',
    '    print(result.registers[0])',
  ].join('\n');
  return Number(execFileSync('python', ['-c', source, ...(restore === undefined ? [] : [String(restore)])], { encoding: 'utf8', timeout: 6000 }).trim());
}

async function blockBounds(label: string, flyout = false) {
  const bounds = await browser.execute(({ selector, label, flyout }) => {
    const root = document.querySelector(selector);
    const surface = root?.querySelector(flyout ? '.blocklyToolboxFlyout' : '.blocklySvg');
    const title = Array.from(surface?.querySelectorAll('g[data-id] text') ?? []).find(text => text.textContent === label);
    const block = title?.closest('g[data-id]');
    const rect = block?.querySelector(':scope > .blocklyPath')?.getBoundingClientRect();
    const grip = title?.getBoundingClientRect();
    return rect && grip ? {
      id: block!.getAttribute('data-id')!, x: rect.x, y: rect.y, height: rect.height,
      gripX: grip.x + grip.width / 2, gripY: grip.y + grip.height / 2,
    } : null;
  }, { selector: viewSelector, label, flyout });
  if (!bounds) throw new Error(`Unable to find the visible block ${label}`);
  return bounds;
}

async function drag(from: { x: number; y: number }, to: { x: number; y: number }) {
  await browser.action('pointer', { parameters: { pointerType: 'mouse' } })
    .move({ x: Math.round(from.x), y: Math.round(from.y) })
    .down({ button: 0 })
    .move({ x: Math.round(to.x), y: Math.round(to.y), duration: 450 })
    .up({ button: 0 })
    .perform();
}

async function appendAction(label: string, precedingLabel: string) {
  await view().$('.blocklyToolboxCategory*=设备操作').click();
  await view().$('.blocklyToolboxFlyout').waitForDisplayed();
  const block = await blockBounds(label, true);
  const preceding = await blockBounds(precedingLabel);
  const from = { x: block.gripX, y: block.gripY };
  await drag(from, {
    x: preceding.x + from.x - block.x,
    y: preceding.y + preceding.height + from.y - block.y - 4,
  });
  await expect(view().$('.blocklyToolboxFlyout')).toBeDisplayed();
  const added = await blockBounds(label);
  const escaped = await browser.execute(id => CSS.escape(id), added.id);
  // These device actions have no point yet. Follow the draft diagnostic to
  // the actual block before editing fields in the split workspace.
  await view().$('button=定位积木').click();
  return view().$(`g[data-id=${escaped}]`);
}

describe('Author and execute a master script in the packaged editor', () => {
  it('captures, writes, and reads the real TCP simulator from UI-authored Blockly steps and previews the same Lua', async () => {
    await $('nav').waitForDisplayed({ timeout: 20000 });
    await browser.waitUntil(async () => (await snapshot()).slaveStates?.['slave-1']?.state === 'online', { timeout: 15000 });
    const initial = await snapshot();
    expect(initial.workspace.connections.find(connection => connection.id === 'conn-tcp')?.tcp).toEqual({ host: '127.0.0.1', port: 50520 });
    const before = simulatorRegister();
    expect(Number.isInteger(before)).toBe(true);
    expect(before).not.toBe(targetValue);

    await $('//nav//button[normalize-space(.)="主站脚本"]').click();
    await view().$('[aria-label="新建脚本"]').click();
    await view().$('.blocklyWorkspace').waitForDisplayed({ timeout: 15000 });
    await view().$('[aria-label="居中积木"]').click();
    await view().$('.blocklyCanvasTransitioning').waitForExist({ reverse: true });

    const capture = await appendAction('读取到变量', '开始');
    await expect(capture).not.toHaveText(expect.stringContaining('超时'));
    await capture.$('.blocklyInputField').click();
    const input = $('input.blocklyHtmlInput');
    await input.waitForDisplayed();
    await input.setValue('起始转速');
    await browser.keys('Enter');
    const captureBinding = capture.$('.blocklyField:has(.blocklyDropdownText)');
    await captureBinding.click();
    const dropdown = $('.blocklyDropDownDiv');
    await dropdown.waitForDisplayed();
    await dropdown.$('.blocklyMenuItem*=目标转速').click();
    await expect(captureBinding).toHaveText(expect.stringContaining('目标转速'));

    const write = await appendAction('写入点位', '读取到变量');
    const writeBinding = write.$('.blocklyField:has(.blocklyDropdownText)');
    await writeBinding.click();
    await dropdown.waitForDisplayed();
    await dropdown.$('.blocklyMenuItem*=目标转速').click();
    await expect(writeBinding).toHaveText(expect.stringContaining('目标转速'));
    await write.$('.blocklyInputField').click();
    await input.waitForDisplayed();
    await input.setValue(String(targetValue));
    await browser.keys('Enter');

    const read = await appendAction('等待新采样', '写入点位');
    const name = '界面搭建主站联动';
    const nameInput = view().$('input[aria-label="流程名称"]');
    await nameInput.click();
    await browser.keys(['Control', 'a']);
    await browser.keys('Backspace');
    await nameInput.addValue(name);
    await expect(nameInput).toHaveValue(name);
    const readBinding = read.$('.blocklyField:has(.blocklyDropdownText)');
    await readBinding.click();
    await dropdown.waitForDisplayed();
    await dropdown.$('.blocklyMenuItem*=目标转速').click();
    await expect(readBinding).toHaveText(expect.stringContaining('目标转速'));

    const captureId = await capture.getAttribute('data-id');
    const selectedWriteId = await write.getAttribute('data-id');
    const selectedReadId = await read.getAttribute('data-id');
    await view().$('button=保存').click();
    await browser.waitUntil(async () => (await snapshot()).workspace.masterScripts?.some(script => script.name === name) ?? false);
    const saved = (await snapshot()).workspace.masterScripts!.find(script => script.name === name)!;
    const blocks = saved.graph.blocks?.blocks ?? [];
    expect(blocks.map(block => block.type).sort()).toEqual(['mb_on_run', 'mb_start']);
    const dormantCycle = blocks.find(block => block.type === 'mb_on_run');
    expect(dormantCycle?.fields?.PERIOD).toBe(100);
    expect(dormantCycle?.next).toBeUndefined();
    const captureStep = blocks.find(block => block.type === 'mb_start')?.next?.block;
    const writeStep = captureStep?.next?.block;
    const readStep = writeStep?.next?.block;
    expect(captureStep).toMatchObject({ id: captureId, type: 'mb_read_var', fields: { POINT: '["slave-1","pt-speed"]', VARIABLE: '起始转速' } });
    expect(captureStep?.fields?.TIMEOUT).toBeUndefined();
    expect(writeStep).toMatchObject({ id: selectedWriteId, type: 'mb_write', fields: { POINT: '["slave-1","pt-speed"]', VALUE: String(targetValue) } });
    expect(readStep).toMatchObject({ id: selectedReadId, type: 'mb_read', fields: { POINT: '["slave-1","pt-speed"]' } });
    expect(readStep?.next).toBeUndefined();

    fs.mkdirSync(evidenceDir, { recursive: true });
    const expectedLua = [
      'local value = modbus.value("slave-1", "pt-speed")',
      `modbus.write("slave-1", "pt-speed", "${targetValue}")`,
      'modbus.read("slave-1", "pt-speed", 5000)',
    ].join('\n');
    expect(await readScriptLua()).toBe(expectedLua);
    await browser.saveScreenshot(path.join(evidenceDir, 'lua-preview.png'));
    expect(simulatorRegister()).toBe(before);

    try {
      await view().$('button=运行').click();
      await browser.waitUntil(async () => {
        const run = (await snapshot()).scriptRun;
        return run?.scriptId === saved.id && run.state === 'passed';
      }, { timeout: 15000 });
      const actual = await snapshot();
      const run = actual.scriptRun!;
      expect(run.entries).toMatchObject([
        { blockId: captureId, result: 'ok', detail: `变量「起始转速」 = ${before}` },
        { blockId: writeStep!.id, result: 'ok', detail: `写入应答成功 · ${targetValue}` },
        { blockId: readStep!.id, result: 'ok', detail: String(targetValue) },
      ]);
      expect(actual.points['slave-1::pt-speed']?.engNumber).toBe(targetValue);
      expect(simulatorRegister()).toBe(targetValue);
      const wire = actual.transactions.find(item =>
        item.connectionId === 'conn-tcp' && item.unitId === 1 && item.sourceKind === 'write'
        && item.sourceId === 'pt-speed' && item.functionCode === 6 && item.result === 'ok');
      expect(wire).toBeDefined();
      expect(hex(wire?.requestAduHex)).toMatch(/010600060693$/);
      expect(hex(wire?.responseAduHex)).toBe(hex(wire?.requestAduHex));
      const report = { before, after: simulatorRegister(), sampled: actual.points['slave-1::pt-speed']?.engNumber, lua: expectedLua, run, write: wire };
      fs.writeFileSync(path.join(evidenceDir, 'run.json'), JSON.stringify(report, null, 2), 'utf8');
      await browser.saveScreenshot(path.join(evidenceDir, 'run-result.png'));
    } finally {
      simulatorRegister(before);
    }
  });

  it('persists a breakpoint, steps exactly one TCP write, and locates a timestamped print from the run results', async () => {
    await $('nav').waitForDisplayed({ timeout: 20000 });
    await browser.waitUntil(async () => (await snapshot()).slaveStates?.['slave-1']?.state === 'online');
    const before = simulatorRegister();
    const target = before === 1649 ? 1650 : 1649;
    const POINT = '["slave-1","pt-speed"]';
    const name = '断点写入验收';
    const steps: ScriptBlock[] = [
      { id: 'dbg-capture', type: 'mb_read_var', fields: { POINT, VARIABLE: '写前转速' } },
      { id: 'dbg-write', type: 'mb_write', fields: { POINT, VALUE: String(target) } },
      { id: 'dbg-read', type: 'mb_read', fields: { POINT, TIMEOUT: 3000 } },
      { id: 'dbg-log', type: 'mb_log', fields: { TEXT: '反馈转速' }, inputs: { OPERAND: { block: { id: 'dbg-value', type: 'mb_point_value', fields: { POINT } } } } },
    ];
    const first = steps.reduceRight<ScriptBlock | undefined>((next, step) => ({ ...step, ...(next ? { next: { block: next } } : {}) }), undefined)!;
    const graph = { blocks: { languageVersion: 0, blocks: [{ id: 'dbg-start', type: 'mb_start', x: 36, y: 18, next: { block: first } }] } };
    const file = path.join(process.env.MODBUS_TEST_RUN_DIR!, 'debug-log.modbus-script.json');
    fs.writeFileSync(file, JSON.stringify({ format: 'modbus-master-script', version: 1, name, graph }));
    const evidence = path.resolve('out/test-temp/master-script-debug-evidence');
    fs.mkdirSync(evidence, { recursive: true });
    const writeFrames = async () => (await snapshot()).transactions.filter(row => row.connectionId === 'conn-tcp' && row.sourceKind === 'write'
      && hex(row.requestPduHex ?? null) === '060006' + target.toString(16).padStart(4, '0'));
    try {
      await $('//nav//button[normalize-space(.)="主站脚本"]').click();
      await view().$('input[type="file"]').addValue(file);
      await view().$(`button=${name}`).click();
      const writeLabel = view().$('g[data-id="dbg-write"] > .blocklyLabelField');
      await writeLabel.waitForDisplayed();
      await writeLabel.click({ button: 'right' });
      await $('.blocklyMenuItem*=设置断点').click();
      await expect(view().$('g[data-id="dbg-write"] > .script-breakpoint-dot')).toBeDisplayed();
      await view().$('button=保存').click();
      await browser.waitUntil(async () => (await snapshot()).workspace.masterScripts?.find(item => item.name === name)?.graph.breakpoints?.includes('dbg-write') === true);
      await browser.refresh();
      await $('//nav//button[normalize-space(.)="主站脚本"]').click();
      await view().$(`button=${name}`).click();
      await expect(view().$('g[data-id="dbg-write"] > .script-breakpoint-dot')).toBeDisplayed();
      expect(await readScriptLua()).toContain('print("反馈转速", modbus.value("slave-1", "pt-speed"))');
      await view().$('button=调试').click();
      const pause = view().$('[aria-label="调试暂停"]');
      await expect(pause).toHaveText(expect.stringContaining('调试起点'));
      await view().$('button=继续').click();
      await expect(pause).toHaveText(expect.stringContaining('命中断点'));
      await expect(view().$('.script-lua-line[data-current][data-block-id="dbg-write"]')).toBeDisplayed();
      await view().$('.script-lua-line[data-block-id="dbg-read"]').click();
      await expect(view().$('g.script-selected[data-id="dbg-read"]')).toBeDisplayed();
      await expect(view().$('g[data-id="dbg-write"] > .script-location-arrow')).toBeDisplayed();
      await expect(pause).toHaveText(expect.stringContaining(String(target)));
      const logLabel = view().$('g[data-id="dbg-log"] > .blocklyLabelField');
      await logLabel.click({ button: 'right' });
      await $('.blocklyMenuItem*=设置断点').click();
      await browser.waitUntil(async () => (await snapshot()).scriptRun!.breakpoints.includes('dbg-log'));
      await view().$('button=保存').click();
      await browser.waitUntil(async () => (await snapshot()).workspace.masterScripts?.find(item => item.name === name)?.graph.breakpoints?.includes('dbg-log') === true);
      await logLabel.click({ button: 'right' });
      await $('.blocklyMenuItem*=移除断点').click();
      await browser.waitUntil(async () => !(await snapshot()).scriptRun!.breakpoints.includes('dbg-log'));
      await view().$('button=保存').click();
      await browser.waitUntil(async () => !(await snapshot()).workspace.masterScripts?.find(item => item.name === name)?.graph.breakpoints?.includes('dbg-log'));
      // Re-enter after breakpoint-only saves have advanced the workspace revision.
      await browser.refresh();
      await $('//nav//button[normalize-space(.)="主站脚本"]').click();
      await view().$(`button=${name}`).click();
      await expect(view().$('.script-lua-line[data-current][data-block-id="dbg-write"]')).toBeDisplayed();
      await pause.$('summary').click();
      await expect(pause).toHaveText(expect.stringContaining('写前转速'));
      expect(simulatorRegister()).toBe(before);
      expect(await writeFrames()).toHaveLength(0);
      const pollIds = new Set((await snapshot()).transactions.filter(t => t.connectionId === 'conn-tcp' && t.functionCode === 3).map(t => t.traceId));
      await browser.waitUntil(async () => (await snapshot()).transactions.some(t => t.connectionId === 'conn-tcp' && t.functionCode === 3 && !pollIds.has(t.traceId)));
      await $('[aria-label="关闭提示"]').waitForExist({ reverse: true, timeout: 7000 });
      await browser.saveScreenshot(path.join(evidence, 'breakpoint.png'));
      await view().$('button=单步').click();
      await browser.waitUntil(async () => (await snapshot()).scriptRun?.pause?.reason === 'step');
      expect((await snapshot()).scriptRun?.current?.blockId).toBe('dbg-read');
      await expect(view().$('.script-lua-line[data-current][data-block-id="dbg-read"]')).toBeDisplayed();
      expect(simulatorRegister()).toBe(target);
      expect(await writeFrames()).toHaveLength(1);
      await view().$('button=继续').click();
      await browser.waitUntil(async () => (await snapshot()).scriptRun?.state === 'passed');
      const row = view().$('[aria-label="步骤结果"]').$('button*=反馈转速');
      await expect(row).toHaveText(expect.stringContaining('反馈转速 ' + target));
      expect(await row.$('time').getText()).toMatch(/^\d\d:\d\d:\d\d\.\d{3}$/);
      await row.click();
      await expect(view().$('g.script-selected[data-id="dbg-log"]')).toBeDisplayed();
      await expect(view().$('.script-lua-line[data-selected][data-block-id="dbg-log"]')).toBeDisplayed();
      await browser.electron.execute(electron => electron.BrowserWindow.getAllWindows()[0]?.setSize(1024, 680));
      await browser.waitUntil(() => browser.execute(() => {
        const host = document.querySelector('.workbench-view:not([style*="display: none"]) .script-editor')!;
        const block = host.querySelector('g[data-id="dbg-log"] > .blocklyPath')!.getBoundingClientRect();
        const pane = host.querySelector('.blocklyToolboxFlyout .blocklyFlyoutBackground')!.getBoundingClientRect();
        const bounds = host.getBoundingClientRect();
        return window.innerWidth <= 1024 && block.left >= pane.right && block.right <= bounds.right && block.bottom <= bounds.bottom;
      }));
      await browser.saveScreenshot(path.join(evidence, 'log-compact.png'));
      await view().$('button=运行').click();
      await expect(pause).toHaveText(expect.stringContaining('命中断点'));
      await view().$('button=停止').click();
      await browser.waitUntil(async () => (await snapshot()).scriptRun?.state === 'stopped');
      expect(await writeFrames()).toHaveLength(1);
    } finally {
      simulatorRegister(before);
      await browser.electron.execute(electron => electron.BrowserWindow.getAllWindows()[0]?.setSize(1440, 960));
    }
  });

  const rtuTest = process.env.MODBUS_RTU_SLAVE_PORT === 'COM2' && process.env.MODBUS_E2E_TCP_ONLY !== '1' ? it : it.skip;
  rtuTest('runs an imported flow with nested conditions and captured values over the isolated COM1–COM2 virtual RTU link', async () => {
    await $('nav').waitForDisplayed({ timeout: 20000 });
    await browser.waitUntil(async () => (await snapshot()).slaveStates?.['slave-rtu-1']?.state === 'online', { timeout: 15000 });
    const initial = await snapshot();
    expect(initial.workspace.connections.find(item => item.id === 'conn-rtu')?.rtu?.port).toBe('COM1');
    const before = initial.points['slave-rtu-1::pt-flow-setpoint']?.rawNumber;
    expect(before).toBe(17);

    const POINT = '["slave-rtu-1","pt-flow-setpoint"]';
    const VARIABLE = '初值';
    const online: ScriptBlock = { id: 'rtu-online', type: 'mb_state', fields: { SLAVE: 'slave-rtu-1', STATE: 'online' } };
    const offline: ScriptBlock = { id: 'rtu-offline', type: 'mb_state', fields: { SLAVE: 'slave-rtu-1', STATE: 'offline' } };
    const equal: ScriptBlock = { id: 'rtu-equal', type: 'mb_compare_var', fields: { POINT, OP: 'eq', VARIABLE } };
    const range: ScriptBlock = { id: 'rtu-range', type: 'mb_range', fields: { POINT, MIN: 25.3, MAX: 25.5 } };
    const either: ScriptBlock = { id: 'rtu-or', type: 'mb_or', inputs: { A: { block: { ...equal, id: 'rtu-equal-again' } }, B: { block: offline } } };
    const changedAndOnline: ScriptBlock = { id: 'rtu-not', type: 'mb_not', inputs: { CONDITION: { block: either } } };
    const name = 'RTU 主站脚本联动';
    const steps: ScriptBlock[] = [
      { id: 'rtu-entry', type: 'mb_start', x: 36, y: 26 },
      { id: 'rtu-ready', type: 'mb_wait', fields: { TIMEOUT: 5000 }, inputs: {
        CONDITION: { block: online },
      } },
      { id: 'rtu-capture', type: 'mb_read_var', fields: { POINT, TIMEOUT: 5000, VARIABLE } },
      { id: 'rtu-loop', type: 'mb_repeat', fields: { COUNT: 2 }, inputs: {
        BODY: { block: { id: 'rtu-branch', type: 'mb_if', fields: { TIMEOUT: 5000 }, inputs: {
          CONDITION: { block: { id: 'rtu-initial', type: 'mb_and', inputs: { A: { block: { ...online, id: 'rtu-still-online' } }, B: { block: equal } } } },
          YES: { block: {
            id: 'rtu-set', type: 'mb_write', fields: { POINT, VALUE: '25.4' },
            next: { block: { id: 'rtu-after-write', type: 'mb_read', fields: { POINT, TIMEOUT: 5000 } } },
          } },
          NO: { block: { id: 'rtu-delay', type: 'mb_delay', fields: { MS: 25 } } },
        } } },
      } },
      { id: 'rtu-target', type: 'mb_wait', fields: { TIMEOUT: 5000 }, inputs: {
        CONDITION: { block: { id: 'rtu-verify', type: 'mb_and', inputs: { A: { block: range }, B: { block: changedAndOnline } } } },
      } },
      { id: 'rtu-read', type: 'mb_read', fields: { POINT, TIMEOUT: 5000 } },
    ];
    const start = steps.slice().reverse().reduce<ScriptBlock | undefined>((next, block) =>
      ({ ...block, ...(next ? { next: { block: next } } : {}) }), undefined)!;
    const portable = {
      format: 'modbus-master-script', version: 1, name,
      graph: { blocks: { languageVersion: 0, blocks: [start] } },
    };
    const file = path.join(process.env.MODBUS_TEST_RUN_DIR!, 'rtu-live.modbus-script.json');
    fs.writeFileSync(file, JSON.stringify(portable), 'utf8');
    fs.mkdirSync(evidenceDir, { recursive: true });
    await $('//nav//button[normalize-space(.)="主站脚本"]').click();
    await view().$('button=导入脚本').waitForDisplayed();
    await view().$('input[type="file"]').addValue(file);
    await view().$(`button=${name}`).waitForDisplayed();
    await view().$(`button=${name}`).click();
    await view().$('.blocklyWorkspace').waitForDisplayed({ timeout: 15000 });
    await view().$('.blocklyToolboxCategory*=条件').click();
    await view().$('.blocklyToolboxFlyout').waitForDisplayed();
    for (const label of ['确认值', '与', '或', '非', '本次错误是']) await blockBounds(label, true);
    await browser.saveScreenshot(path.join(evidenceDir, 'condition-toolbox.png'));
    await view().$('[aria-label="收起积木托盘"]').click();
    await view().$('.blocklyToolboxFlyout').waitForDisplayed({ reverse: true });
    const lua = await readScriptLua();
    expect(lua).toContain('for _step = 1, 2 do');
    const testOnline = 'function() return modbus.state("slave-rtu-1", "online") end';
    const testOffline = 'function() return modbus.state("slave-rtu-1", "offline") end';
    const testInitial = 'function() return modbus.compare("slave-rtu-1", "pt-flow-setpoint", "eq", value) end';
    const testRange = 'function() return modbus.in_range("slave-rtu-1", "pt-flow-setpoint", 25.3, 25.5) end';
    expect(lua).toContain('return modbus.all(\n');
    const normalizedLua = lua.replace(/\s+/g, ' ').replaceAll('( ', '(').replaceAll(' )', ')');
    expect(normalizedLua).toBe([
      `modbus.wait(${testOnline}, 5000)`,
      'local value = modbus.value("slave-rtu-1", "pt-flow-setpoint")',
      'for _step = 1, 2 do',
      `if modbus.check(function() return modbus.all(${testOnline}, ${testInitial}) end) then`,
      'modbus.write("slave-rtu-1", "pt-flow-setpoint", "25.4")',
      'modbus.read("slave-rtu-1", "pt-flow-setpoint", 5000)',
      'else',
      'modbus.delay(25)',
      'end',
      'end',
      `modbus.wait(function() return modbus.all(${testRange}, function() return modbus.negate(function() return modbus.any(${testInitial}, ${testOffline}) end) end) end, 5000)`,
      'modbus.read("slave-rtu-1", "pt-flow-setpoint", 5000)',
    ].join(' '));
    await browser.saveScreenshot(path.join(evidenceDir, 'rtu-lua-preview.png'));
    await view().$('button=运行').click();
    await browser.waitUntil(async () => {
      const run = (await snapshot()).scriptRun;
      return run?.scriptName === name && run.state === 'passed';
    }, { timeout: 15000 });
    const actual = await snapshot();
    const run = actual.scriptRun!;
    expect(run.entries.map(entry => entry.blockId)).toEqual([
      'rtu-ready', 'rtu-capture', 'rtu-loop', 'rtu-branch', 'rtu-set', 'rtu-after-write', 'rtu-branch', 'rtu-delay', 'rtu-target', 'rtu-read',
    ]);
    expect(run.entries.every(entry => entry.result === 'ok')).toBe(true);
    expect(run.entries.find(entry => entry.blockId === 'rtu-capture')?.detail).toBe('变量「初值」 = 1.7');
    expect(run.entries.filter(entry => entry.blockId === 'rtu-branch').map(entry => entry.detail)).toEqual([
      expect.stringContaining('当前值 1.7，预期等于变量「初值」（1.7）'),
      expect.stringContaining('当前值 25.4，预期等于变量「初值」（1.7）'),
    ]);
    expect(run.entries.find(entry => entry.blockId === 'rtu-set')?.detail).toBe('写入应答成功 · 25.4');
    expect(run.entries.find(entry => entry.blockId === 'rtu-after-write')?.detail).toBe('25.4');
    expect(run.entries.at(-1)?.detail).toBe('25.4');
    expect(actual.points['slave-rtu-1::pt-flow-setpoint']?.rawNumber).toBe(254);
    const relevant = actual.transactions.filter(item => item.connectionId === 'conn-rtu' && item.unitId === 1 && item.result === 'ok');
    const writes = relevant.filter(item => item.sourceKind === 'write' && item.sourceId === 'pt-flow-setpoint' && item.functionCode === 6);
    expect(writes).toHaveLength(1);
    const write = writes[0];
    expect(hex(write?.requestAduHex)).toMatch(/^0106000400fe[0-9a-f]{4}$/);
    expect(hex(write?.responseAduHex)).toBe(hex(write?.requestAduHex));
    const read = relevant.find(item => {
      if (item.functionCode !== 3 || !hex(item.requestAduHex).startsWith('010300000008')) return false;
      const response = Buffer.from(hex(item.responseAduHex), 'hex');
      return response.length >= 13 && response.readUInt16BE(11) === 254;
    });
    expect(read).toBeDefined();
    fs.writeFileSync(path.join(evidenceDir, 'rtu-run.json'), JSON.stringify({ before, after: 254, lua, run, write, read }, null, 2), 'utf8');
    await browser.saveScreenshot(path.join(evidenceDir, 'rtu-run-result.png'));
  });

  it('restores a real TCP value from a variable after a handled failure and exits the main loop', async () => {
    await $('nav').waitForDisplayed({ timeout: 20000 });
    const before = simulatorRegister();
    const POINT = '["slave-1","pt-speed"]';
    const variable: ScriptBlock = { type:'mb_variable', id:'saved-rpm', fields:{ VARIABLE:'初始转速' } };
    const chain = (...blocks: ScriptBlock[]) => {
      let next: ScriptBlock | undefined;
      for (const block of blocks.reverse()) next = { ...block, ...(next ? { next:{ block:next } } : {}) };
      return { block:next! };
    };
    const main: ScriptBlock = { type:'mb_forever', id:'cycle', inputs:{ BODY:{ block:{
      type:'mb_try', id:'attempt', inputs:{
        BODY:chain({ id:'set', type:'mb_write', fields:{ POINT, VALUE:'1694' } },
          { id:'feedback', type:'mb_read', fields:{ POINT, TIMEOUT:3000 } },
          { id:'trip', type:'mb_assert', fields:{ BOOL_CONDITION:'FALSE' } },
          { id:'skipped', type:'mb_write', fields:{ POINT, VALUE:'1' } }),
        ERROR:{ block:{ id:'choose', type:'mb_if', fields:{ BOOL_CONDITION:'FALSE' }, extraState:{ elseIfCount:1, hasElse:true },
          inputs:{ YES:{block:{type:'mb_stop',id:'wrong'}}, COND1:{ block:{ id:'fault', type:'mb_error_is', fields:{CODE:'evaluation'} } },
            YES1:chain({ type:'mb_write', id:'restore', fields:{ POINT, VALUE:'0' }, inputs:{ OPERAND:{block:variable} } },
              { type:'mb_read', id:'read-back', fields:{ POINT,TIMEOUT:3000 } }, {type:'mb_break',id:'exit'}),
            NO:{block:{type:'mb_stop',id:'unexpected'}} } } },
      },
    } } } };
    const name = '主循环异常恢复';
    const file = path.join(process.env.MODBUS_TEST_RUN_DIR!, 'restore.modbus-script.json');
    const root = chain({ id:'start',type:'mb_start',x:30,y:25 },{type:'mb_read_var',id:'initial',fields:{POINT,VARIABLE:'初始转速'}},main,
      {type:'mb_assert',id:'verify',inputs:{CONDITION:{block:{type:'mb_compare',id:'restored',fields:{POINT,OP:'eq',VALUE:'0'},
        inputs:{OPERAND:{block:{...variable,id:'expected-rpm'}}}}}}}).block;
    fs.writeFileSync(file, JSON.stringify({format:'modbus-master-script',version:1,name,graph:{blocks:{languageVersion:0,blocks:[root]}}}));
    await $('//nav//button[normalize-space(.)="主站脚本"]').click();
    await view().$('input[type="file"]').addValue(file);
    await view().$(`button=${name}`).waitForDisplayed();
    await view().$(`button=${name}`).click();
    await view().$('.blocklyWorkspace').waitForDisplayed();
    try {
      await view().$('button=运行').click();
      await browser.waitUntil(async () => { const run=(await snapshot()).scriptRun; return run?.scriptName===name && run.state==='passed'; },{timeout:15000});
      const run = (await snapshot()).scriptRun!;
      expect(run.entries.map(entry=>entry.blockId)).toEqual(['initial','cycle','attempt','set','feedback','trip','choose','restore','read-back','exit','verify']);
      expect(run.entries.find(entry=>entry.blockId==='trip')).toMatchObject({result:'failed',handled:true});
      expect(run.judgments.restored).toMatchObject({matched:true,samples:[{timeMs:expect.any(Number)},{timeMs:expect.any(Number)}]});
      expect(simulatorRegister()).toBe(before);
      const lua = await readScriptLua();
      expect(lua).toContain('modbus.attempt(function()');
      expect(lua).toContain('modbus.write("slave-1", "pt-speed", value)');
      expect(lua).toContain('modbus.yield_io()');
      fs.mkdirSync(evidenceDir,{recursive:true});
      fs.writeFileSync(path.join(evidenceDir,'handled-restore.json'),JSON.stringify({before,after:simulatorRegister(),run,lua},null,2));
    } finally { simulatorRegister(before); }
  });

  rtuTest('shows the actual value of a high-risk variable write before sending it to the RTU simulator', async () => {
    await $('nav').waitForDisplayed({ timeout:20000 });
    await browser.waitUntil(async () => (await snapshot()).points['slave-rtu-1::pt-flow-reset']?.hasValue === true);
    const POINT = '["slave-rtu-1","pt-flow-reset"]';
    const name = '高风险实际值确认';
    const value = (await snapshot()).points['slave-rtu-1::pt-flow-reset']!.engNumber!;
    const root: ScriptBlock = { id:'start',type:'mb_start',x:32,y:24,next:{block:{
      id:'original',type:'mb_read_var',fields:{POINT,VARIABLE:'寄存器原值'},next:{block:{
        id:'send',type:'mb_write',fields:{POINT,VALUE:'0'},inputs:{ OPERAND:{block:{id:'var',type:'mb_variable',fields:{VARIABLE:'寄存器原值'}}} },
      }},
    }} };
    const file = path.join(process.env.MODBUS_TEST_RUN_DIR!, 'approve-value.modbus-script.json');
    fs.writeFileSync(file,JSON.stringify({format:'modbus-master-script',version:1,name,graph:{blocks:{languageVersion:0,blocks:[root]}}}));
    await $('//nav//button[normalize-space(.)="主站脚本"]').click();
    await view().$('input[type="file"]').addValue(file);
    await view().$(`button=${name}`).waitForDisplayed();
    await view().$(`button=${name}`).click();
    await view().$('.blocklyWorkspace').waitForDisplayed();
    await view().$('button=运行').click();
    await $('button=确认并运行').click();
    const pending = view().$('[aria-label="待确认写入"]');
    await pending.waitForDisplayed();
    await expect(pending).toHaveText(expect.stringContaining('→ '+String(value)));
    const writes = async () => (await snapshot()).transactions.filter(t=>t.connectionId==='conn-rtu' && t.sourceKind==='write' && t.sourceId==='pt-flow-reset');
    expect(await writes()).toHaveLength(0);
    await pending.$('button=确认下发').click();
    await browser.waitUntil(async ()=>(await snapshot()).scriptRun?.state==='passed');
    expect(await writes()).toHaveLength(1);
  });
});
