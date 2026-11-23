import { browser, $, expect } from '@wdio/globals';
import fs from 'node:fs';
import path from 'node:path';
import type { ModbusApi } from '../../src/shared/preload-api';

const rail = (name: string) => $(`//nav//button[normalize-space(.)="${name}"]`).click();
const click = (name: string) => $(`//button[normalize-space(.)="${name}"]`).click();
const snapshot = () => browser.execute(() => (window as unknown as { modbus: ModbusApi }).modbus.getSnapshot());
const text = () => $('body').getText();
const evidence = path.resolve('out/test-temp/history-legacy-evidence');

describe('packaged application reads existing history after Recorder removal', () => {
  before(async () => {
    await browser.waitUntil(async () => (await snapshot()).workspace.connections.length > 0);
    fs.mkdirSync(evidence, { recursive: true });
  });

  it('rejects stale session-control commands and exposes the current snapshot contract', async () => {
    const results = await browser.execute(async () => {
      const api = (window as unknown as { modbus: ModbusApi }).modbus;
      return Promise.all([
        api.command({ type: 'trend.startRecording', groupId: 'g-power' } as never),
        api.command({ type: 'trend.stopRecording' } as never),
        api.command({ type: 'prefs.set', patch: { persistRawComm: true } } as never),
      ]);
    });
    expect(results.every(result => !result.ok)).toBe(true);
    const state = await snapshot();
    expect(Object.keys(state)).not.toContain('recording');
    expect(Object.keys(state.prefs)).not.toContain('persistRawComm');
  });

  it('shows sampling and history settings through the current navigation', async () => {
    await rail('设置');
    await click('采样与历史');
    const body = await text();
    expect(body).toContain('既有历史数据库');
    expect(body).toContain('满后覆盖最旧样本');
    expect(body).not.toContain('记录会话时保存相关原始通信');
    expect(body).not.toContain('记录与存储');
    await browser.saveScreenshot(path.join(evidence, 'settings.png'));
  });

  it('reads old samples, persists a note, exports CSV and replays the existing session', async () => {
    await rail('历史');
    await $('[data-session-id="legacy-g-power"]').click();
    await browser.waitUntil(async () => (await text()).includes('导出 CSV'));
    await click('添加备注');
    await $('input[aria-label="备注内容"]').setValue('legacy "note", 测试');
    await click('保存备注');
    await browser.waitUntil(async () => (await text()).includes('legacy "note", 测试'));
    await click('导出 CSV');
    const csv = await browser.electron.execute(electron => electron.clipboard.readText());
    expect(csv).toContain('15.25');
    expect(csv).toContain('"legacy ""note"", 测试"');
    await click('回放');
    await click('▶ 播放');
    await browser.waitUntil(async () => (await $('input[type="range"]').getValue()) !== '0');
    if ((await text()).includes('暂停')) await click('暂停');
    await browser.saveScreenshot(path.join(evidence, 'replay.png'));
    await click('返回历史');
    const result = await browser.execute(() => (window as unknown as { modbus: ModbusApi }).modbus.command({ type: 'history.sessionData', sessionId: 'legacy-g-power' }));
    expect(result.ok).toBe(true);
    fs.writeFileSync(path.join(evidence, 'session.json'), JSON.stringify(result, null, 2));
  });

  it('labels an unfinished old session without an active recording status', async () => {
    await $('[data-session-id="legacy-unfinished"]').click();
    expect(await $('[data-session-id="legacy-unfinished"]').getText()).toContain('未结束');
    expect(await text()).not.toContain('记录中');
    await browser.saveScreenshot(path.join(evidence, 'unfinished.png'));
  });
});
