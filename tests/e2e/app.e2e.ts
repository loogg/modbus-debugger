import { browser, $, expect } from '@wdio/globals';
import fs from 'node:fs';
import path from 'node:path';

const SHOTS = path.resolve('tests', 'e2e', 'screenshots');

interface PuppeteerBrowser {
  getPuppeteer(): Promise<{ targets(): Array<{ type(): string; page(): Promise<unknown> }> }>;
}

async function setViewport(width: number, height: number): Promise<void> {
  const pp = await (browser as unknown as PuppeteerBrowser).getPuppeteer();
  const pageTarget = pp.targets().find((t) => t.type() === 'page');
  const page = (await pageTarget?.page()) as { createCDPSession(): Promise<{ send(m: string, p: unknown): Promise<unknown> }> } | undefined;
  if (!page) throw new Error('no puppeteer page target');
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
}

async function setNative(selector: string, value: string): Promise<void> {
  await browser.execute((sel, v) => {
    const input = document.querySelector(sel) as HTMLInputElement | null;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, v);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  }, selector, value);
  await browser.pause(200);
}
async function bodyText(): Promise<string> {
  return (await browser.execute(() => document.body.innerText)) as string;
}

async function shot(name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true });
  await browser.saveScreenshot(path.join(SHOTS, `${name}.png`));
}

describe('Modbus Debugger packaged app E2E', () => {
  it('launches with the demo workspace and device topology', async () => {
    await browser.waitUntil(async () => (await bodyText()).includes('Modbus 调试工具'), { timeout: 25000 });
    const text = await bodyText();
    expect(text).toContain('伺服驱动器 A');
    expect(text).toContain('生产线 TCP');
    await setViewport(1440, 960);
    await shot('01-devices-1440');
  });

  it('realtime page shows live confirmed values from the simulator', async () => {
    await $('//button[contains(., "实时")]').click();
    await browser.pause(500);
    await $('//button[contains(., "伺服驱动器 A")]').click();
    await browser.waitUntil(async () => /4[0-9]\.\d+/.test(await bodyText()), {
      timeout: 30000,
      timeoutMsg: 'expected live bus voltage from simulator',
    });
    const text = await bodyText();
    expect(text).toContain('母线电压');
    expect(text).toContain('后台持续刷新');
    await shot('04A-realtime-1440');
  });

  it('writes 目标转速 and confirms via read-back', async () => {
    const res = await browser.execute(async () => {
      const api = (window as unknown as { modbus: { command: (c: unknown) => Promise<{ ok: boolean; value?: unknown }> } }).modbus;
      return api.command({ type: 'point.write', slaveId: 'slave-1', pointId: 'pt-speed', engineering: 1800, boolValue: null, stringValue: null });
    });
    expect(res.ok).toBe(true);
    await browser.waitUntil(async () => (await bodyText()).includes('1800'), {
      timeout: 20000,
      timeoutMsg: 'expected confirmed write value 1800 after read-back',
    });
  });

  it('communication log records real transactions', async () => {
    await $('//button[contains(., "通信")]').click();
    await browser.waitUntil(async () => (await bodyText()).includes('FC03'), { timeout: 20000 });
    const text = await bodyText();
    expect(text).toContain('通信诊断');
    await shot('13-comm-1440');

    // a row click must drive the frame-detail pane (the old data-idx lookup never matched)
    await browser.execute(() => {
      const row = document.querySelectorAll('tbody tr')[1] as HTMLElement | undefined;
      row?.click();
    });
    await browser.pause(500);
    expect(await bodyText()).toContain('帧详情');

    // 连接健康 is fed by real 1 Hz samples recorded in Main, not a static series
    await $('//button[text()="连接健康"]').click();
    await browser.waitUntil(async () => /[1-9][0-9]* 个采样点/.test(await bodyText()), { timeout: 20000 });
    await browser.pause(1500);
    const healthText = await bodyText();
    expect(healthText).toContain('总线负载');
    expect(healthText).toContain('数据块性能');
    await shot('20-comm-health-1440');
    await $('//button[text()="报文"]').click();
    await browser.pause(500);
  });

  it('trend chart renders live signals', async () => {
    await $('//button[contains(., "趋势")]').click();
    await browser.pause(500);
    const chartTab = await $('//button[text()="图表"]');
    await chartTab.click();
    await browser.pause(2500);
    const text = await bodyText();
    expect(text).toContain('功耗分析');
    await shot('11-trend-1440');
  });

  it('slave scan discovers simulator units', async () => {
    await $('//button[contains(., "设备")]').click();
    await browser.pause(400);
    await $('//button[text()="扫描"]').click();
    await browser.pause(400);
    await setNative('input[data-testid="scan-from"]', '1');
    await setNative('input[data-testid="scan-to"]', '20');
    await $('//button[text()="开始扫描"]').click();
    await browser.pause(500);
    await browser.waitUntil(async () => /已发现 [1-9][0-9]* 个从站/.test(await bodyText()), { timeout: 25000 });
    const text = await bodyText();
    expect(text).toContain('扫描摘要');
    expect(text).toMatch(/已发现 [1-9][0-9]* 个从站/);
    await shot('17-scan-1440');
  });

  it('temporary read returns registers and offers save-as-block', async () => {
    await $('//button[text()="临时读取"]').click();
    await browser.pause(400);
    await $('//button[text()="读取"]').click();
    await browser.pause(1500);
    await browser.waitUntil(async () => (await bodyText()).includes('读取成功'), { timeout: 20000 });
    const text = await bodyText();
    expect(text).toContain('保存为数据块');
    await shot('18-temp-read-1440');
  });

  it('connection settings open in the main area with edit and save', async () => {
    await $('//button[contains(., "设备")]').click();
    await browser.pause(400);
    await browser.execute(() => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.textContent ?? '').includes('生产线 TCP'));
      (b as HTMLElement | undefined)?.click();
    });
    await browser.waitUntil(async () => (await bodyText()).includes('连接名称'), { timeout: 15000 });
    const text = await bodyText();
    expect(text).toContain('从站');
    expect(text).toContain('添加从站');
    expect(await (await $('input[data-testid="timeout-input"]')).getValue()).toBe('800');
    // a live connection locks the parameter form and offers 断开连接
    expect(await (await $('input[data-testid="timeout-input"]')).isEnabled()).toBe(false);
    const t2 = await bodyText();
    expect(t2).toContain('断开连接');
    expect(t2).toContain('已连接：参数已锁定');
    await shot('01B-connection-settings-1440');
    // back to the slave device page
    await browser.execute(() => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.textContent ?? '').includes('伺服驱动器 A'));
      (b as HTMLElement | undefined)?.click();
    });
    await browser.pause(500);
  });

  it('compact window keeps engineering columns via internal scrolling', async () => {
    await setViewport(1024, 680);
    await $('//button[contains(., "实时")]').click();
    await browser.pause(800);
    const text = await bodyText();
    expect(text).toContain('访问');
    expect(text).toContain('单位');
    await shot('04A-realtime-1024');
    await setViewport(1440, 960);
  });
});
