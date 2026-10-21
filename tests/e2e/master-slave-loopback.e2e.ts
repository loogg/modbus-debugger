import { browser, $, expect } from '@wdio/globals';
import fs from 'node:fs';
import path from 'node:path';
import { loopbackWorkspace, loopVectors } from '../support/loopback-workspace';
import type { ModbusApi } from '../../src/shared/preload-api';
import type { Workspace } from '../../src/domain/model';
import type { Command } from '../../src/shared/commands';

const snapshot = () => browser.execute(() => (window as unknown as { modbus: ModbusApi }).modbus.getSnapshot());
const command = (command: Command) => browser.execute(command => (window as unknown as { modbus: ModbusApi }).modbus.command(command), command);
const rail = (name: string) => $(`//nav//button[normalize-space(.)="${name}"]`).click();
const click = (name: string) => $(`//button[normalize-space(.)="${name}"]`).click();
const evidence = path.resolve('out/test-temp/loopback-evidence/native');
const capture = async (name: string) => { fs.mkdirSync(evidence, { recursive: true }); await browser.saveScreenshot(path.join(evidence, name)); };
async function apply(workspace: Workspace) {
  for (const connection of (await snapshot()).workspace.connections) await command({ type: 'connection.disconnect', connectionId: connection.id });
  expect((await command({ type: 'workspace.apply', workspace })).ok).toBe(true);
}
async function selectSlave(name: string) { await rail('实时'); await $(`//button[.//span[normalize-space(.)="${name}"]]`).click(); }
async function editPoint(name: string, value: string) {
  const search = await $('//input[@placeholder="搜索点位"]');
  await search.setValue(name);
  const cell = await $(`//div[normalize-space(text())="${name}"]/following-sibling::div[2]`);
  await cell.doubleClick();
  const input = await $('input.w-24'); await input.click();
  // ChromeDriver's sendKeys supports BMP only; a real clipboard paste also covers emoji.
  await browser.electron.execute((electron, text) => electron.clipboard.writeText(text), value);
  await browser.keys(['Control', 'a']); await browser.keys(['Control', 'v']); await browser.keys('Enter');
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
      expect((await snapshot()).points[`${transport}-master-1::UTF8-holding`]?.stringValue).toBe('闭环🙂');
      await $('//div[normalize-space(text())="UTF8"]/following-sibling::div[2]//button[normalize-space(.)="原始数据"]').click();
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
      expect(await $('//button[normalize-space(.)="编辑从站内存"]').isDisplayed()).toBe(true);
      expect(await $('//button[normalize-space(.)="刷新全部"]').isExisting()).toBe(false);
      await capture(`${transport}-server-realtime.png`);
    });

    it(`${transport.toUpperCase()} records both ends, opens charts/history/replay and exports full-precision CSV`, async () => {
      expect((await command({ type: 'prefs.set', patch: { persistRawComm: true } })).ok).toBe(true);
      await rail('趋势');
      await $(`//button[contains(.,"${transport.toUpperCase()} 主从四类趋势")]`).click();
      await click('● 开始记录');
      await browser.waitUntil(async () => (await snapshot()).recording?.groupId === `${transport}-trend`);
      const sessionId = (await snapshot()).recording!.sessionId;
      for (const [pointId, value] of [['Float32-ABCD-holding', 15.25], ['Enum-holding', 2], ['UTF8-holding', '记录🙂']] as const) {
        expect((await command({ type: 'point.write', slaveId: `${transport}-master-1`, pointId, engineering: typeof value === 'number' ? value : null, boolValue: null, stringValue: typeof value === 'string' ? value : null })).ok).toBe(true);
      }
      await browser.waitUntil(async () => (await snapshot()).recording!.sampleCount >= 4);
      await click('图表'); await capture(`${transport}-four-renderer-charts.png`);
      await click('■ 停止记录');
      await rail('历史');
      await $(`//button[contains(.,"${transport.toUpperCase()} 主从四类趋势")]`).click();
      await browser.waitUntil(async () => (await $('body').getText()).includes('导出 CSV'));
      await click('导出 CSV');
      const csv = await browser.execute(() => navigator.clipboard.readText());
      expect(csv).toContain('15.25'); expect(csv).toContain('2.345678901234'); expect(csv).toContain('记录🙂');
      await capture(`${transport}-history.png`);
      await click('回放'); await capture(`${transport}-replay.png`);
      const data = await command({ type: 'history.sessionData', sessionId });
      expect(data.ok).toBe(true);
      fs.writeFileSync(path.join(evidence, `${transport}-session.json`), JSON.stringify(data, null, 2));
    });
  }
});
