import fs from 'node:fs';
import { browser, $, expect } from '@wdio/globals';
import { migrateWorkspace } from '../../src/domain/model';
import { canvasSchema } from '../../src/domain/canvas';
import type { ModbusApi } from '../../src/shared/preload-api';
import type { DiagnosticsPage } from '../../src/shared/diagnostics';

const view = () => $('.workbench-view:not([style*="display: none"])');
const chart = () => view().$('[data-series-count="2"]');
const rail = (name: string) => $(`//nav//button[normalize-space(.)="${name}"]`).click();

describe('Scoped diagnostics and bounded live curve windows', () => {
  let main: string;
  before(async () => {
    await $('nav').waitForDisplayed({ timeout: 20000 });
    main = await browser.getWindowHandle();
    const workspace = migrateWorkspace(JSON.parse(fs.readFileSync('tools/e2e/demo.workspace.json', 'utf8')));
    workspace.connections = workspace.connections.filter(connection => connection.transport === 'tcp');
    workspace.slaves = workspace.slaves.filter(slave => workspace.connections.some(connection => connection.id === slave.connectionId));
    workspace.trendGroups = workspace.trendGroups.map(group => ({ ...group, signals: group.signals.filter(signal => workspace.slaves.some(slave => slave.id === signal.pointRef.slaveId)) }));
    for (const template of workspace.templates) template.blocks.forEach(block => { block.periodMs = block.id === 'blk-ctrl' ? 5 : 20; });
    workspace.sampleBuffers = ['pt-speed', 'pt-temp'].map(pointId => ({ slaveId: 'slave-1', pointId, capacity: 400 }));
    workspace.canvases = [canvasSchema.parse({ id: 'scoped', name: '窗口复验', width: 960, height: 680, widgets: [
      { id: 'curve', kind: 'trend', label: '速度与温度', showLabel: true, x: 24, y: 24, width: 800, height: 400, windowSec: 5,
        signals: [{ slaveId: 'slave-1', pointId: 'pt-speed', color: '#0078D4' }, { slaveId: 'slave-1', pointId: 'pt-temp', color: '#D97706' }] },
    ] })];
    const result = await browser.execute(async value => (window as unknown as { modbus: ModbusApi }).modbus.command({ type: 'workspace.apply', workspace: value }), workspace);
    expect(result.ok).toBe(true);
    await rail('组态画布');
    await view().$('button=窗口复验').click();
    await browser.waitUntil(async () => Number(await chart().getAttribute('data-last-seq')) > 20);
  });

  it('delivers light snapshots and deltas while diagnostics remain queryable', async () => {
    const proof = await browser.execute(async () => {
      const api = (window as unknown as { modbus: ModbusApi }).modbus;
      const snapshot = await api.getSnapshot({ includeDiagnostics: false });
      let details = false;
      const release = api.onDelta(delta => { details ||= Boolean(delta.transactions?.length || delta.parseEvents?.length); });
      await new Promise(resolve => setTimeout(resolve, 500));
      release();
      const page = await api.command<DiagnosticsPage>({ type: 'diagnostics.read', connectionId: 'conn-tcp', limit: 20 });
      if (!page.ok) throw new Error(page.error);
      return { light: snapshot.transactions.length + snapshot.parseEvents.length, details, records: page.value.transactions.length, throughput: snapshot.health['conn-tcp']?.throughputBytesPerSec };
    });
    expect(proof.light).toBe(0); expect(proof.details).toBe(false);
    expect(proof.records).toBeGreaterThan(0); expect(proof.throughput).toBeGreaterThan(0);
  });

  it('retains a real-time zoom while continuing to advance the sample sequence', async () => {
    const first = Number(await chart().getAttribute('data-last-seq'));
    const size = await chart().getSize();
    await browser.action('pointer').move({ origin: await chart(), x: 0, y: Math.round(size.height * .12) }).perform();
    await browser.action('wheel').scroll({ origin: await chart(), x: 0, y: 0, deltaY: -300, deltaX: 0, duration: 150 }).perform();
    await browser.waitUntil(async () => Number(await chart().getAttribute('data-view-end-ms')) - Number(await chart().getAttribute('data-view-start-ms')) < 4900);
    await browser.waitUntil(async () => Number(await chart().getAttribute('data-last-seq')) > first);
    await expect(view().$('[aria-label="暂停曲线"]')).toBeDisplayed();
    await expect(view().$('[aria-label="恢复跟随"]')).not.toBeExisting();
  });

  it('keeps a paused snapshot through buffer overwrite and a native return', async () => {
    await view().$('[aria-label="暂停曲线"]').click();
    await view().$('[aria-label="恢复跟随"]').waitForDisplayed();
    const frozen = Number(await chart().getAttribute('data-last-seq'));
    await $('[aria-label="弹出当前页面"]').click();
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 2);
    const child = (await browser.getWindowHandles()).find(id => id !== main)!;
    await browser.switchToWindow(child);
    await $('button=回入主窗口').waitForDisplayed({ timeout: 15000 });
    await browser.switchToWindow(main);
    await browser.waitUntil(async () => {
      const response = await browser.execute(async () => (window as unknown as { modbus: ModbusApi }).modbus.command({ type: 'data.read', points: [], blocks: [], buffers: [{ slaveId: 'slave-1', pointId: 'pt-speed' }], series: [] }));
      return response.ok && (response.value as { buffers: Record<string, { firstSeq: number }> }).buffers['slave-1::pt-speed']!.firstSeq > frozen;
    }, { timeout: 15000 });
    await browser.switchToWindow(child);
    await expect($('[data-series-count="2"]')).toHaveAttribute('data-last-seq', String(frozen));
    await expect($('[role="status"]')).toHaveText(expect.stringContaining('暂停快照'));
    await $('button=回入主窗口').click();
    await browser.switchToWindow(main);
    await view().$('[aria-label="恢复跟随"]').click();
    await browser.waitUntil(async () => Number(await chart().getAttribute('data-last-seq')) > frozen);
  });

  it('reads, pauses and clears communication details from the real page', async () => {
    await rail('通信');
    await view().$('tbody tr').waitForDisplayed();
    await view().$('button=暂停').click();
    const frozen = await view().$('tbody').getText();
    await browser.pause(500);
    expect(await view().$('tbody').getText()).toBe(frozen);
    await view().$('button=继续显示').click();
    const before = await browser.execute(async () => (window as unknown as { modbus: ModbusApi }).modbus.command<DiagnosticsPage>({ type: 'diagnostics.read', limit: 1 }));
    await view().$('button=清空').click();
    const after = await browser.execute(async generation => (window as unknown as { modbus: ModbusApi }).modbus.command<DiagnosticsPage>({ type: 'diagnostics.read', generation, limit: 1 }), before.ok ? before.value.generation : '');
    expect(after.ok && after.value.reset).toBe(true);
  });
});
