import { browser, $, expect } from '@wdio/globals';
import fs from 'node:fs';
import path from 'node:path';
import type { ModbusApi } from '../../src/shared/preload-api';

describe('packaged app first use', () => {
  it('opens a real empty workspace and offers the Figma first-use path', async () => {
    const state = await browser.execute(() => (window as unknown as { modbus: ModbusApi }).modbus.getSnapshot());
    expect(state.workspace.connections).toHaveLength(0);
    expect(state.workspace.slaves).toHaveLength(0);
    const text = await $('body').getText();
    expect(text).toContain('开始配置 Modbus 调试环境');
    expect(text).toContain('推荐流程');
    expect(text).toContain('在趋势组中观察信号并按需开始记录');
    const screenshot = path.resolve('out/audit/figma-current/15-empty-first-use.png');
    fs.mkdirSync(path.dirname(screenshot), { recursive: true });
    await browser.saveScreenshot(screenshot);
    await $('//button[normalize-space(.)="＋ 添加第一个连接"]').click();
    expect(await $('[role="dialog"] h2').getText()).toBe('添加连接');
  });
});
