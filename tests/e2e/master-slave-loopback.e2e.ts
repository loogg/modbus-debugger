import { browser, $, $$, expect } from '@wdio/globals';
import fs from 'node:fs';
import path from 'node:path';
import { loopbackWorkspace, loopVectors } from '../support/loopback-workspace';
import type { ModbusApi } from '../../src/shared/preload-api';
import type { Workspace } from '../../src/domain/model';
import type { DataReadResult } from '../../src/shared/point-data';
import type { Command } from '../../src/shared/commands';
import { activeView } from '../support/workbench-controls';

const snapshot = () => browser.execute(() => (window as unknown as { modbus: ModbusApi }).modbus.getSnapshot());
const command = (command: Command) => browser.execute(command => (window as unknown as { modbus: ModbusApi }).modbus.command(command), command);
async function readHoldingFeedback(transport: 'rtu' | 'tcp') {
  expect((await command({ type: 'device.refresh', slaveId: `${transport}-master-1`, blockId: 'holding' })).ok).toBe(true);
}
const rail = (name: string) => $(`//nav//button[normalize-space(.)="${name}"]`).click();
async function visibleElement(selector: string) {
  for (const element of await $$(selector)) if (await element.isDisplayed()) return element;
  throw new Error(`Visible control not found: ${selector}`);
}
const click = async (name: string) => (await visibleElement(`//button[normalize-space(.)="${name}"]`)).click();
const evidence = path.resolve('out/test-temp/loopback-evidence/native');
const capture = async (name: string) => { fs.mkdirSync(evidence, { recursive: true }); await browser.saveScreenshot(path.join(evidence, name)); };
async function apply(workspace: Workspace) {
  for (const connection of (await snapshot()).workspace.connections) await command({ type: 'connection.disconnect', connectionId: connection.id });
  expect((await command({ type: 'workspace.apply', workspace })).ok).toBe(true);
}
async function selectSlave(name: string) { await rail('实时'); await (await visibleElement(`//button[.//span[normalize-space(.)="${name}"]]`)).click(); }
async function editPoint(name: string, value: string) {
  const search = await activeView().$('input[placeholder="搜索点位"]');
  await search.click();
  await browser.keys(['Control', 'a']);
  await browser.keys('Backspace');
  await search.addValue(name);
  await expect(search).toHaveValue(name);
  const cell = await activeView().$(`.//div[normalize-space(text())="${name}"]/following-sibling::div[2]`);
  await cell.waitForDisplayed();
  await cell.doubleClick();
  const input = await activeView().$('input.w-24'); await input.click();
  // Electron's native text input supports full Unicode and the editor's normal input events.
  await browser.electron.execute(electron => {
    const windows = electron.BrowserWindow.getAllWindows();
    if (windows.length !== 1) throw new Error('Expected one native test window');
    windows[0]!.focus(); windows[0]!.webContents.focus();
  });
  await browser.keys(['Control', 'a']); await browser.keys('Backspace');
  await browser.electron.execute(async (electron, text) => {
    const window = electron.BrowserWindow.getFocusedWindow();
    if (!window) throw new Error('Native editor window is not focused');
    await window.webContents.insertText(text);
  }, value);
  await browser.waitUntil(async () => await input.getValue() === value, { timeoutMsg: 'Native text input did not reach the editor' });
  await browser.keys('Enter');
}

describe('packaged native application tests its own TCP and RTU master/slave together', () => {
  let original: Workspace;
  const transports = process.env.MODBUS_SELF_RTU === '1' ? ['tcp', 'rtu'] as const : ['tcp'] as const;
  before(async () => {
    original = (await snapshot()).workspace;
    const workspace = loopbackWorkspace({ tcpPort: 15030, transports: [...transports] });
    await apply(workspace);
    for (const transport of transports) {
      expect((await command({ type: 'connection.connect', connectionId: `${transport}-server` })).ok).toBe(true);
      await browser.waitUntil(async () => (await snapshot()).connections[`${transport}-master`]?.state !== 'connecting');
      expect((await command({ type: 'connection.connect', connectionId: `${transport}-master` })).ok).toBe(true);
      expect((await command({ type: 'device.refresh', slaveId: `${transport}-master-1` })).ok).toBe(true);
    }
  });
  after(async () => { await browser.keys('Escape'); if (original) await apply(original); });

  for (const transport of transports) {
    it(`${transport.toUpperCase()} confirms every type through packaged Main and native IPC`, async () => {
      for (const vector of loopVectors) {
        const engineering = typeof vector.written === 'number' && !vector.enumMap ? vector.written * (vector.scale ?? 1) + (vector.offset ?? 0) : vector.written;
        const result = await command({ type: 'point.write', slaveId: `${transport}-master-1`, pointId: `${vector.id}-holding`, engineering: typeof engineering === 'number' ? engineering : null, boolValue: typeof engineering === 'boolean' ? engineering : null, stringValue: typeof engineering === 'string' ? engineering : null });
        expect(result.ok && result.value).toMatchObject({ phase: 'confirmed' });
        await readHoldingFeedback(transport);
        const state = await snapshot();
        const master = state.points[`${transport}-master-1::${vector.id}-holding`]!;
        const slave = state.points[`${transport}-server-1::${vector.id}-holding`]!;
        expect([master.rawText, master.engText, master.stringValue, master.boolValue]).toEqual([slave.rawText, slave.engText, slave.stringValue, slave.boolValue]);
      }
      await capture(`${transport}-native-all-types.png`);
    });

    it(`${transport.toUpperCase()} real UI writes UTF-8, rejects byte overflow, and presents the same confirmed value on the server`, async () => {
      await selectSlave(`${transport.toUpperCase()} 主站 Unit 1`);
      await editPoint('UTF8', '闭环🙂');
      await browser.waitUntil(async () => (await snapshot()).points[`${transport}-server-1::UTF8-holding`]?.stringValue === '闭环🙂');
      await readHoldingFeedback(transport);
      expect((await snapshot()).points[`${transport}-master-1::UTF8-holding`]?.stringValue).toBe('闭环🙂');
      await activeView().$('.//div[normalize-space(text())="UTF8"]/following-sibling::div[2]//button[normalize-space(.)="原始数据"]').click();
      await browser.waitUntil(async () => (await $('body').getText()).includes('0x9982'));
      expect(await $('body').getText()).toContain('E9 97 AD E7 8E AF F0 9F 99 82 00 00');
      await capture(`${transport}-complete-string-raw.png`);
      await click('查看最近通信'); await selectSlave(`${transport.toUpperCase()} 主站 Unit 1`);
      const previous = (await snapshot()).points[`${transport}-server-1::UTF8-odd-holding`]?.stringValue;
      await editPoint('UTF8-odd', '中文');
      await browser.waitUntil(async () => (await $('body').getText()).includes('超过配置的 5 字节'));
      expect((await snapshot()).points[`${transport}-server-1::UTF8-odd-holding`]?.stringValue).toBe(previous);
      expect(await $('.spin').isExisting()).toBe(false);
      await capture(`${transport}-string-invalid-keeps-confirmed.png`);
      await selectSlave(`${transport.toUpperCase()} 从站 Unit 1`);
      await browser.waitUntil(async () => {
        for (const button of await $$('//button[normalize-space(.)="编辑从站内存"]')) if (await button.isDisplayed()) return true;
        return false;
      });
      expect(await (await visibleElement('//button[normalize-space(.)="编辑从站内存"]')).isDisplayed()).toBe(true);
      for (const button of await $$('//button[normalize-space(.)="刷新全部"]')) expect(await button.isDisplayed()).toBe(false);
      await capture(`${transport}-server-realtime.png`);
    });

    it(`${transport.toUpperCase()} buffers both ends, opens charts and exports full-precision CSV`, async () => {
      await rail('趋势');
      await $(`//button[contains(.,"${transport.toUpperCase()} 主从四类趋势")]`).click();
      const group = (await snapshot()).workspace.trendGroups.find(item => item.id === `${transport}-trend`)!;
      const refs = group.signals.map(signal => ({ slaveId: signal.pointRef.slaveId, pointId: signal.pointRef.pointId }));
      for (const [pointId, value] of [['Float32-ABCD-holding', 15.25], ['Precision-holding', 2.345678901234], ['Enum-holding', 2], ['UTF8-holding', '记录🙂']] as const) {
        expect((await command({ type: 'point.write', slaveId: `${transport}-master-1`, pointId, engineering: typeof value === 'number' ? value : null, boolValue: null, stringValue: typeof value === 'string' ? value : null })).ok).toBe(true);
      }
      await readHoldingFeedback(transport);
      let data: DataReadResult | null = null;
      await browser.waitUntil(async () => {
        const result = await command({ type: 'data.read', points: [], blocks: [], buffers: refs, series: refs.map(ref => ({ ...ref, limit: 2000 })) });
        if (!result.ok) return false;
        data = result.value as DataReadResult;
        return Object.values(data.series).every(series => series.samples.length > 0);
      });
      await click('图表'); await capture(`${transport}-four-renderer-charts.png`);
      const file = path.join(evidence, `${transport}-samples.csv`);
      expect((await command({ type: 'buffer.export', points: refs, path: file })).ok).toBe(true);
      const csv = fs.readFileSync(file, 'utf8');
      expect(csv).toContain('15.25'); expect(csv).toContain('2.345678901234'); expect(csv).toContain('记录🙂');
      await capture(`${transport}-buffers.png`);
      fs.writeFileSync(path.join(evidence, `${transport}-buffers.json`), JSON.stringify(data, null, 2));
    });
  }
});
