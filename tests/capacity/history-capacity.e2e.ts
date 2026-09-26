import { browser, $, expect } from '@wdio/globals';
import fs from 'node:fs';
import path from 'node:path';

const metricsPath = path.resolve('out/audit/capacity-1m-smoke.json');
const clipboardInfo = () => browser.electron.execute(electron => {
  const text = electron.clipboard.readText();
  return { length: text.length, head: text.slice(0, 64), tail: text.slice(-64) };
});
const replayLinePixels = () => browser.execute(() => {
  const canvas = document.querySelector<HTMLCanvasElement>('div[data-chart-units] canvas');
  const context = canvas?.getContext('2d');
  if (!canvas || !context) return 0;
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let blue = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index]! < 70 && pixels[index + 1]! >= 80 && pixels[index + 1]! < 170 && pixels[index + 2]! > 160 && pixels[index + 3]! > 180) blue++;
  }
  return blue;
});

describe('opt-in packaged history capacity smoke', () => {
  let originalClipboard: string;
  before(async () => { originalClipboard = await browser.electron.execute(electron => electron.clipboard.readText()); });
  after(async () => { await browser.electron.execute((electron, value) => electron.clipboard.writeText(value), originalClipboard); });

  it('opens, replays, scrubs and exports a real 1,000,000-sample session', async () => {
    const openedAt = Date.now();
    await $('//nav//button[normalize-space(.)="历史"]').click();
    await browser.waitUntil(async () => (await $('body').getText()).includes('1,000,000'), { timeout: 45000 });
    await browser.waitUntil(async () => await $('canvas').isExisting(), { timeout: 45000 });
    const openedMs = Date.now() - openedAt;
    fs.mkdirSync(path.dirname(metricsPath), { recursive: true });
    await browser.saveScreenshot(path.resolve('out/audit/capacity-1m-history.png'));

    const replayStartedAt = Date.now();
    await $('//button[normalize-space(.)="回放"]').click();
    await browser.waitUntil(async () => (await $('body').getText()).includes('游标时刻数据'), { timeout: 20000 });
    const replayMs = Date.now() - replayStartedAt;
    const scrubStartedAt = Date.now();
    const slider = await $('input[type="range"]');
    await slider.click();
    const cursorMs = Number(await slider.getValue());
    expect(cursorMs).toBeGreaterThan(0);
    expect(cursorMs).toBeLessThan(999_999_000);
    const lastSampleIndex = Math.floor(cursorMs / 1000);
    const expectedValue = String(20 + (lastSampleIndex % 1000) / 10);
    await browser.waitUntil(async () => (await $('body').getText()).includes(`${expectedValue} °C`), { timeout: 20000 });
    await browser.waitUntil(async () => (await replayLinePixels()) > 1000, { timeout: 5000, timeoutMsg: 'replay chart never rendered its sampled line' });
    const linePixels = await replayLinePixels();
    const scrubMs = Date.now() - scrubStartedAt;
    await browser.saveScreenshot(path.resolve('out/audit/capacity-1m-replay.png'));
    await $('//button[normalize-space(.)="返回历史"]').click();

    const exportStartedAt = Date.now();
    await $('//button[normalize-space(.)="导出 CSV"]').click();
    await browser.waitUntil(async () => (await clipboardInfo()).length > 27_000_000, { timeout: 30000 });
    const exportMs = Date.now() - exportStartedAt;
    const csv = await clipboardInfo();
    // Windows clipboard normalizes line endings to CRLF.
    expect(csv.head.replaceAll('\r', '')).toContain('signal,t_ms,value\n"signal-1",0,"20"');
    expect(csv.tail.replaceAll('\r', '')).toContain('999999000,"119.9"');
    const rendererHeap = await browser.execute(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null);
    const mainMemory = await browser.electron.execute(() => process.memoryUsage());
    const metrics = { openedMs, replayMs, scrubMs, cursorMs, expectedValue, linePixels, exportMs, csv, rendererHeap, mainMemory };
    fs.writeFileSync(metricsPath, JSON.stringify(metrics, null, 2));
    expect(openedMs).toBeLessThan(30000);
    expect(scrubMs).toBeLessThan(5000);
    expect(exportMs).toBeLessThan(30000);
  });
});
