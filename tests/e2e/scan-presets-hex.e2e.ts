import { browser, $, $$, expect } from '@wdio/globals';
import fs from 'node:fs';
import path from 'node:path';
import type { ModbusApi } from '../../src/shared/preload-api';
import type { Workspace } from '../../src/domain/model';

const snapshot = () => browser.execute(() => (window as unknown as { modbus: ModbusApi }).modbus.getSnapshot());
const click = async (label: string) => { await $(`//button[normalize-space(.)="${label}"]`).click(); };
const rail = async (label: string) => { await $(`//nav//button[normalize-space(.)="${label}"]`).click(); };
const clipboardText = () => browser.electron.execute(electron => electron.clipboard.readText());
const setup = async () => {
  const workspace = JSON.parse(fs.readFileSync('tools/e2e/demo.workspace.json', 'utf8')) as Workspace;
  workspace.connections = workspace.connections.filter(connection => connection.id === 'conn-tcp');
  workspace.slaves = workspace.slaves.filter(slave => slave.connectionId === 'conn-tcp');
  const result = await browser.execute(async value =>
    (window as unknown as { modbus: ModbusApi }).modbus.command({ type: 'workspace.apply', workspace: value }), workspace);
  expect(result.ok).toBe(true);
  await rail('设备');
  await $('//button[contains(.,"生产线 TCP")]').click();
  await browser.waitUntil(async () => (await snapshot()).connections['conn-tcp']?.state === 'online', { timeout: 20000 });
};

describe('扫描预设与 Raw ADU 复制', () => {
  let originalClipboard: string;
  before(async () => { originalClipboard = await clipboardText(); });
  after(async () => { await browser.electron.execute((electron, value) => electron.clipboard.writeText(value), originalClipboard); });
  beforeEach(setup);

  it('常用范围仅预填，开始扫描后才按所选范围和地址实际发包', async () => {
    await click('扫描');
    const scannerCount = () => snapshot().then(state => state.transactions.filter(tx => tx.sourceKind === 'scanner').length);
    const before = await scannerCount();
    for (const [label, end] of [['1~16', '16'], ['1~32', '32'], ['1~64', '64']] as const) {
      await click(label);
      expect(await $('[data-testid="scan-from"]').getValue()).toBe('1');
      expect(await $('[data-testid="scan-to"]').getValue()).toBe(end);
      await browser.pause(200);
      expect(await scannerCount()).toBe(before);
    }
    await click('1~16');
    await click('开始扫描');
    await browser.waitUntil(async () => (await snapshot()).connections['conn-tcp']?.scan?.phase === 'completed', { timeout: 20000 });
    const state = await snapshot();
    expect([state.connections['conn-tcp']?.scan?.from, state.connections['conn-tcp']?.scan?.to]).toEqual([1, 16]);
    expect(state.connections['conn-tcp']?.scan?.checked).toBe(16);
    const sent = state.transactions.filter(tx => tx.sourceKind === 'scanner').slice(before);
    expect(sent.length).toBeGreaterThan(0);
    expect([...new Set(sent.map(tx => tx.unitId))].sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    expect(sent.every(tx => tx.functionCode === 3 && tx.requestPduHex === '0300000001' && tx.unitId >= 1 && tx.unitId <= 16)).toBe(true);
  });

  it('通信诊断两个复制按钮分别写入与记录完全相同的请求和响应 ADU Hex', async () => {
    await click('临时读取');
    await click('读取');
    await browser.waitUntil(async () => (await $('body').getText()).includes('读取成功'), { timeout: 20000 });
    const record = (await snapshot()).transactions.filter(tx => tx.sourceKind === 'temporary-read').at(-1)!;
    expect(record.requestAduHex.length).toBeGreaterThan(0);
    expect(record.responseAduHex).not.toBeNull();

    await rail('通信');
    const search = await $('//input[contains(@placeholder,"搜索地址")]');
    await search.click();
    await browser.keys(['Control', 'a']);
    await search.addValue(record.traceId);
    const rows = await $$('tbody tr');
    expect(rows).toHaveLength(2);
    expect(await rows[0]!.getText()).toContain('RX');
    expect(await rows[1]!.getText()).toContain('TX');
    expect(await rows[0]!.getText()).toContain(`${record.responseAduHex!.length / 2} bytes`);
    expect(await rows[1]!.getText()).toContain(record.summary);
    const screenshot = path.resolve('out/audit/figma-current/13-comm-tx-rx.png');
    fs.mkdirSync(path.dirname(screenshot), { recursive: true });
    await browser.saveScreenshot(screenshot);
    await rows[1]!.click();
    expect(await $('body').getText()).toContain(`地址 ${record.summary}`);
    const copyButtons = await $$('//button[normalize-space(.)="复制 Hex"]');
    expect(copyButtons).toHaveLength(2);
    await copyButtons[0]!.click();
    await browser.waitUntil(async () => await clipboardText() === record.requestAduHex);
    await copyButtons[1]!.click();
    await browser.waitUntil(async () => await clipboardText() === record.responseAduHex);
  });
});
