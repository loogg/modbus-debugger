import { browser, $, $$, expect } from '@wdio/globals';
import fs from 'node:fs';
import path from 'node:path';
import type { ModbusApi } from '../../src/shared/preload-api';
import type { Workspace } from '../../src/domain/model';

const rail = (name: string) => $(`//nav//button[normalize-space(.)="${name}"]`).click();
const click = (name: string) => $(`//button[normalize-space(.)="${name}"]`).click();
const snapshot = () => browser.execute(() => (window as unknown as { modbus: ModbusApi }).modbus.getSnapshot());
const body = () => $('body').getText();
const runDir = process.env.MODBUS_TEST_RUN_DIR;

describe('桌面菜单与设置实际操作', () => {
  let originalClipboard = '';

  before(async () => {
    if (!runDir) throw new Error('Settings E2E requires isolated test directory');
    fs.mkdirSync('out/audit/settings-v0.11.3', { recursive: true });
    originalClipboard = await browser.electron.execute(electron => electron.clipboard.readText());
  });
  after(async () => {
    await browser.electron.execute((electron, value) => electron.clipboard.writeText(value), originalClipboard);
  });
  afterEach(async function () {
    if (this.currentTest?.state === 'failed') {
      await browser.saveScreenshot(path.resolve('out/audit/settings-v0.11.3/failure.png'));
      fs.writeFileSync(path.resolve('out/audit/settings-v0.11.3/failure.txt'), await body());
    }
    await browser.electron.restoreAllMocks();
  });

  it('removes the default desktop menu while retaining text editing shortcuts', async () => {
    expect(await browser.electron.execute(electron => electron.Menu.getApplicationMenu() === null)).toBe(true);
    await browser.saveScreenshot(path.resolve('out/audit/settings-v0.11.3/native-no-menu.png'));
    await rail('设备');
    await click('添加连接');
    const name = await $('//div[normalize-space(.)="连接名称"]/following-sibling::input');
    await name.setValue('Shortcut probe');
    await name.click();
    await browser.keys(['Control', 'a']);
    await browser.keys(['Control', 'c']);
    expect(await browser.electron.execute(electron => electron.clipboard.readText())).toBe('Shortcut probe');
    await name.setValue('');
    await name.click();
    await browser.keys(['Control', 'v']);
    expect(await name.getValue()).toBe('Shortcut probe');
    await click('取消');
  });

  it('saves, exports and imports a workspace through visible controls and preserves the current one on failure', async () => {
    await rail('设置');
    await browser.saveScreenshot(path.resolve('out/audit/settings-v0.11.3/settings-1440.png'));
    const savedPath = path.join(runDir!, 'settings-saved.workspace.json');
    const saveDialog = await browser.electron.mock('dialog', 'showSaveDialog');
    await saveDialog.mockResolvedValue({ canceled: false, filePath: savedPath });
    await click('另存为');
    await browser.waitUntil(() => fs.existsSync(savedPath), { timeout: 10000 });
    expect((await snapshot()).workspacePath).toBe(savedPath);
    expect(JSON.parse(fs.readFileSync(savedPath, 'utf8')).schemaVersion).toBe(1);
    expect(await body()).toContain('工作区已另存为');
    await browser.electron.restoreAllMocks();

    const exportPath = path.join(runDir!, 'settings-export.workspace.json');
    const exportDialog = await browser.electron.mock('dialog', 'showSaveDialog');
    await exportDialog.mockResolvedValue({ canceled: false, filePath: exportPath });
    await click('导出工作区');
    await browser.waitUntil(() => fs.existsSync(exportPath), { timeout: 10000 });
    const exported = JSON.parse(fs.readFileSync(exportPath, 'utf8')) as Workspace;
    expect(exported.name).toBe((await snapshot()).workspace.name);
    expect((await snapshot()).workspacePath).toBe(savedPath);
    expect(await body()).toContain('工作区文件已导出');
    await browser.electron.restoreAllMocks();

    const importedPath = path.join(runDir!, 'settings-import.workspace.json');
    fs.writeFileSync(importedPath, JSON.stringify({ ...exported, name: '设置导入验证' }));
    const openDialog = await browser.electron.mock('dialog', 'showOpenDialog');
    await openDialog.mockResolvedValue({ canceled: false, filePaths: [importedPath] });
    await click('导入工作区');
    await browser.waitUntil(async () => (await snapshot()).workspace.name === '设置导入验证', { timeout: 10000 });
    expect((await snapshot()).workspacePath).toBe(importedPath);
    expect(await body()).toContain('工作区已导入');
    await browser.electron.restoreAllMocks();

    const invalidPath = path.join(runDir!, 'settings-invalid.workspace.json');
    fs.writeFileSync(invalidPath, '{invalid');
    const invalidDialog = await browser.electron.mock('dialog', 'showOpenDialog');
    await invalidDialog.mockResolvedValue({ canceled: false, filePaths: [invalidPath] });
    await click('导入工作区');
    await browser.waitUntil(async () => (await body()).includes('导入工作区失败'), { timeout: 10000 });
    expect((await snapshot()).workspace.name).toBe('设置导入验证');
    expect((await snapshot()).workspacePath).toBe(importedPath);
  });

  it('persists real preferences and clears diagnostics only after confirmation', async () => {
    await rail('设置');
    expect(await $$('button[role="checkbox"]').then(items => items.length)).toBe(1);
    expect(await body()).toContain('正常写入路径 · 不可关闭');
    const checkbox = await $('button[role="checkbox"]');
    await checkbox.click();
    await browser.waitUntil(async () => (await snapshot()).prefs.persistRawComm === true, { timeout: 10000 });
    const prefsPath = path.join(runDir!, 'data', 'prefs.json');
    expect(JSON.parse(fs.readFileSync(prefsPath, 'utf8')).persistRawComm).toBe(true);

    const timezone = await $('//div[normalize-space(.)="时区"]/following-sibling::button[1]');
    await timezone.click();
    await browser.waitUntil(async () => (await timezone.getAttribute('data-state')) === 'open', { timeout: 5000, timeoutMsg: 'timezone list did not open' });
    await $('//*[@role="option"][normalize-space(.)="UTC"]').click();
    await browser.waitUntil(async () => (await snapshot()).prefs.timezone === 'UTC', { timeout: 10000 });
    expect(JSON.parse(fs.readFileSync(prefsPath, 'utf8')).timezone).toBe('UTC');

    const before = (await snapshot()).diagRev;
    await click('清空通信诊断');
    await click('取消');
    expect((await snapshot()).diagRev).toBe(before);
    await click('清空通信诊断');
    await click('清空');
    await browser.waitUntil(async () => (await snapshot()).diagRev > before, { timeout: 10000 });
    expect(await body()).toContain('通信诊断已清空');

    await checkbox.click();
    await browser.waitUntil(async () => (await snapshot()).prefs.persistRawComm === false, { timeout: 10000 });
    await timezone.click();
    await browser.waitUntil(async () => (await timezone.getAttribute('data-state')) === 'open', { timeout: 5000, timeoutMsg: 'timezone list did not reopen' });
    await $('//*[@role="option"][normalize-space(.)="跟随系统"]').click();
    await browser.waitUntil(async () => (await snapshot()).prefs.timezone === 'local', { timeout: 10000 });
  });
});
