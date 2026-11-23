import fs from 'node:fs';
import path from 'node:path';
import { browser, $, expect } from '@wdio/globals';
import type { ModbusApi } from '../../src/shared/preload-api';
import type { Workspace } from '../../src/domain/model';
import type { ColumnDataReadResult, DataReadResult } from '../../src/shared/point-data';

const view = () => $('.workbench-view:not([style*="display: none"])');
const snapshot = () => browser.execute(async () => (window as unknown as { modbus: ModbusApi }).modbus.getSnapshot());
const rail = (name: string) => $(`//nav//button[normalize-space(.)="${name}"]`).click();
async function fill(label: string, value: string) {
  const input = await view().$(`[aria-label="${label}"]`);
  await input.click(); await browser.keys(['Control', 'a']); await browser.keys('Backspace');
  if (value) await input.addValue(value);
}

describe('Host reads and shared confirmed sample buffers', () => {
  let main: string;
  before(async () => {
    await $('nav').waitForDisplayed({ timeout: 20000 });
    main = await browser.getWindowHandle();
    const workspace = JSON.parse(fs.readFileSync(path.resolve('out/test-temp/host-buffer-review/source.workspace.json'), 'utf8')) as Workspace;
    for (const canvas of workspace.canvases ?? []) for (const widget of canvas.widgets) if (widget.kind === 'trend') widget.windowSec = 5;
    const applied = await browser.execute(async value => (window as unknown as { modbus: ModbusApi }).modbus.command({ type: 'workspace.apply', workspace: value }), workspace);
    expect(applied.ok).toBe(true);
    await rail('组态画布');
    await view().$('button=采样控制台').click();
    await browser.waitUntil(async () => (await snapshot()).points['slave-1::pt-speed']?.hasValue === true, { timeout: 15000 });
  });

  it('carries Float64 columns through sandboxed preload IPC and reuses stable metadata', async () => {
    const proof = await browser.execute(async () => {
      const api = (window as unknown as { modbus: ModbusApi }).modbus;
      const refs = ['pt-speed', 'pt-temp'].map(pointId => ({ slaveId: 'slave-1', pointId }));
      const first = await api.command<ColumnDataReadResult>({ type: 'data.read', format: 'columns-v1', points: [{ slaveId: 'slave-1', pointId: 'pt-enable' }], blocks: [], buffers: [], series: refs.map(ref => ({ ...ref, limit: 2000 })) });
      if (!first.ok) throw new Error(first.error);
      const second = await api.command<ColumnDataReadResult>({ type: 'data.read', format: 'columns-v1', points: [], blocks: [], buffers: [], series: refs.map(ref => ({ ...ref, limit: 2000, metadataVersion: first.value.series[`${ref.slaveId}::${ref.pointId}`]!.metadataVersion })) });
      if (!second.ok) throw new Error(second.error);
      return { binary: Object.values(first.value.series).every(page => page.columns.times instanceof Float64Array && page.columns.sequences instanceof Float64Array && page.columns.values instanceof Float64Array),
        samples: Object.values(first.value.series).reduce((total, page) => total + page.columns.times.length, 0), bytes: first.value.sampleBytes,
        metadataReused: Object.values(second.value.series).every(page => page.metadata === undefined), scalar: first.value.points['slave-1::pt-enable']?.hasValue };
    });
    expect(proof.binary).toBe(true);
    expect(proof.samples).toBeGreaterThan(0);
    expect(proof.bytes).toBe(proof.samples * 24);
    expect(proof.metadataReused).toBe(true);
    expect(proof.scalar).toBe(true);
  });

  it('reads real values at a configurable Host interval and still confirms an explicit device write', async () => {
    await view().$('[data-series-count="2"]').waitForDisplayed();
    await browser.waitUntil(async () => Number(await view().$('[data-series-count="2"]').getAttribute('data-last-seq')) > 0);
    await view().$('[aria-label="界面刷新周期"]').selectByAttribute('value', '500');
    await expect(view().$('[aria-label="界面刷新周期"]')).toHaveValue('500');
    const previous = (await snapshot()).points['slave-1::pt-speed']!.engNumber;
    await fill('设置转速 写入值', '1733');
    expect((await snapshot()).points['slave-1::pt-speed']!.engNumber).toBe(previous);
    await view().$('[data-widget-id="input"] button').click();
    await browser.waitUntil(async () => (await snapshot()).points['slave-1::pt-speed']?.engNumber === 1733);
    await expect(view().$('[data-widget-id="input"]')).toHaveText(expect.stringContaining('确认值：1733'));
  });

  it('edits one capacity through the trend, device instance and canvas entries', async () => {
    await rail('趋势');
    await view().$('[aria-label="目标转速 缓冲容量"]').click();
    await fill('共享缓冲容量', '600');
    await view().$('button=保存共享容量').click();
    await browser.waitUntil(async () => (await snapshot()).workspace.sampleBuffers?.find(item => item.pointId === 'pt-speed')?.capacity === 600);
    await rail('设备');
    await view().$('[aria-label="pt-speed 缓冲设置"]').click();
    await expect(view().$('[aria-label="共享缓冲容量"]')).toHaveValue('600');
    await expect(view().$('[role="dialog"]')).toHaveText(expect.stringContaining('画布 · 采样控制台'));
    await view().$('button=关闭').click();
    await rail('组态画布');
    await view().$('button=编辑').click();
    await view().$('button=转速 / 温度').click();
    await view().$('[aria-label="曲线 1 缓冲容量"]').click();
    await expect(view().$('[aria-label="共享缓冲容量"]')).toHaveValue('600');
    await view().$('button=关闭').click();
    await view().$('button=运行').click();
  });

  it('snaps cross-block curves to real retained samples with independent times and sequence numbers', async () => {
    await view().$('[aria-label="暂停曲线"]').click();
    const chart = await view().$('[data-series-count="2"]');
    const size = await chart.getSize();
    await browser.action('pointer').move({ origin: chart, x: Math.round(size.width * .32), y: 0 }).perform();
    await view().$('[data-sample-cursor]').waitForDisplayed();
    const matches = await view().$$('[data-sample-cursor] tbody tr');
    expect(matches).toHaveLength(2);
    for (let index = 0; index < matches.length; index++) {
      const row = matches[index]!;
      const seq = Number(await row.getAttribute('data-sample-seq'));
      const time = Number(await row.getAttribute('data-sample-time'));
      expect(seq).toBeGreaterThan(0);
      expect(await row.getText()).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}/);
      const pointId = index === 0 ? 'pt-speed' : 'pt-temp';
      const data = await browser.execute(async args => (window as unknown as { modbus: ModbusApi }).modbus.command<DataReadResult>({ type: 'data.read', points: [], blocks: [], buffers: [], series: [{ slaveId: 'slave-1', pointId: args.pointId, afterSeq: args.seq - 1, limit: 1 }] }), { pointId, seq });
      if (!data.ok) throw new Error(data.error);
      expect(data.value.series[`slave-1::${pointId}`]!.samples[0]).toMatchObject({ seq, timeMs: time });
    }
    await view().$('[aria-label="恢复跟随"]').click();
  });

  it('retains the Host across a native popout and exports real raw samples from the child window', async () => {
    await $('[aria-label="弹出当前页面"]').click();
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 2);
    await browser.switchToWindow((await browser.getWindowHandles()).find(id => id !== main)!);
    await $('button=回入主窗口').waitForDisplayed({ timeout: 15000 });
    await expect($('[aria-label="界面刷新周期"]')).toHaveValue('500');
    const first = Number(await $('[data-series-count="2"]').getAttribute('data-last-seq'));
    await browser.waitUntil(async () => Number(await $('[data-series-count="2"]').getAttribute('data-last-seq')) > first);
    await $('[aria-label="转速 / 温度 导出采样数据"]').click();
    const output = path.join(process.env.MODBUS_TEST_RUN_DIR!, `native-samples-${Date.now()}.csv`);
    await fill('采样导出路径', output);
    await $('button=导出 CSV').click();
    await browser.waitUntil(() => fs.existsSync(output));
    const csv = fs.readFileSync(output, 'utf8');
    expect(csv).toContain('时间UTC'); expect(csv).toContain('序号');
    expect(csv).toContain('目标转速'); expect(csv).toContain('温度');
    expect(csv).toContain('"1733"');
    expect(csv).toMatch(/T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    expect(csv.trim().split('\n').length).toBeGreaterThan(10);
    await $('button=回入主窗口').click();
    await browser.switchToWindow(main);
    await expect(view().$('[aria-label="界面刷新周期"]')).toHaveValue('500');
    expect((await snapshot()).workspace.sampleBuffers?.find(item => item.pointId === 'pt-speed')?.capacity).toBe(600);
  });

  it('backfills an expanded canvas window and releases samples outside the smaller window', async () => {
    await browser.waitUntil(async () => {
      const info = await browser.execute(async () => (window as unknown as { modbus: ModbusApi }).modbus.command<DataReadResult>({ type: 'data.read', points: [], blocks: [], series: [], buffers: [{ slaveId: 'slave-1', pointId: 'pt-speed' }] }));
      return info.ok && info.value.buffers['slave-1::pt-speed']!.count > 400;
    }, { timeout: 15000 });
    const chart = await view().$('[data-series-count="2"]');
    const shortCount = Number(await chart.getAttribute('data-sample-count'));
    expect(shortCount).toBeLessThan(400);
    await view().$('[aria-label="转速 / 温度 时间窗口"]').selectByAttribute('value', '30');
    await browser.waitUntil(async () => Number(await chart.getAttribute('data-sample-count')) > shortCount + 50);
    await view().$('[aria-label="转速 / 温度 时间窗口"]').selectByAttribute('value', '5');
    await browser.waitUntil(async () => Number(await chart.getAttribute('data-sample-count')) < 400);
  });
});
