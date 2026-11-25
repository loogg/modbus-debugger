import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { browser, $, expect } from '@wdio/globals';
import type { ModbusApi } from '../../src/shared/preload-api';
import { writeAckWorkspace } from '../support/write-ack-workspace';
import { submitRealtimeValue } from '../support/workbench-controls';

const view = () => $('.workbench-view:not([style*="display: none"])');
const snapshot = () => browser.execute(async () => (window as unknown as { modbus: ModbusApi }).modbus.getSnapshot());
const servers: ChildProcess[] = [];

async function startSimulator(index: number) {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const address = probe.address();
  await new Promise<void>(resolve => probe.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('No test port');
  const args = [path.resolve('tools/simulator/modbus_sim.py'), '--port', String(address.port), '--static', '--write-only-register', '3:2'];
  if (index > 0) args.push('--fault', index === 1 ? 'exception' : 'timeout', '--fault-fc', '6');
  const server = spawn('python', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Simulator startup timeout ${output}`)), 15000);
    server.stdout!.on('data', chunk => { output += String(chunk); if (output.includes('"event": "ready"')) { clearTimeout(timer); resolve(); } });
    server.stderr!.on('data', chunk => { output = (output + String(chunk)).slice(-4000); });
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Simulator exited ${code} ${output}`)); });
  });
  return address.port;
}

describe('Write acknowledgements and write-only points in packaged Electron', () => {
  let main: string;
  before(async () => {
    await $('nav').waitForDisplayed({ timeout: 20000 });
    main = await browser.getWindowHandle();
    const ports = [];
    for (let index = 0; index < 3; index++) ports.push(await startSimulator(index));
    const workspace = writeAckWorkspace(ports);
    const applied = await browser.execute(async value => (window as unknown as { modbus: ModbusApi }).modbus.command({ type: 'workspace.apply', workspace: value }), workspace);
    expect(applied.ok).toBe(true);
    await $('//nav//button[normalize-space(.)="组态画布"]').click();
    await view().$('button=命令操作台').click();
    await browser.waitUntil(async () => (await snapshot()).points['device-0::speed']?.hasValue === true);
  });
  after(async () => {
    for (const server of servers) {
      server.kill();
      if (server.exitCode === null) await new Promise<void>(resolve => server.once('exit', () => resolve()));
    }
  });

  it('shows normal, rejected and unknown writes while keeping command addresses unreadable', async () => {
    for (const index of [0, 1, 2]) await view().$(`[data-widget-id="send-${index}"] button`).click();
    await browser.waitUntil(async () => (await snapshot()).points['device-2::command']?.lastWrite?.phase === 'unknown');
    const result = await snapshot();
    expect(result.points['device-0::command']).toMatchObject({ hasValue: false, lastWrite: { phase: 'confirmed', accepted: { value: 1 } } });
    expect(result.points['device-1::command']).toMatchObject({ hasValue: false, lastWrite: { phase: 'rejected' } });
    expect(result.points['device-2::command']).toMatchObject({ hasValue: false, lastWrite: { phase: 'unknown' } });
    await expect(view().$('[data-widget-id="send-0"] [role="status"]')).toHaveText(expect.stringContaining('写入成功'));
    await expect(view().$('[data-widget-id="send-1"] [role="status"]')).toHaveText(expect.stringContaining('设备拒绝'));
    await expect(view().$('[data-widget-id="send-2"] [role="status"]')).toHaveText(expect.stringContaining('结果未知'));
    expect(result.transactions.filter(transaction => transaction.sourceKind === 'readback')).toHaveLength(0);
  });

  it('uses FC22 for a write-only bit and projects its accepted command through preload', async () => {
    await view().$('[role="switch"][aria-label="使能命令"]').click();
    await expect(view().$('[role="switch"][aria-label="使能命令"]')).toHaveAttribute('aria-checked', 'true');
    const result = await snapshot();
    expect(result.points['device-0::flag']).toMatchObject({ hasValue: false, lastWrite: { phase: 'confirmed', accepted: { value: true } } });
    expect(result.transactions.some(transaction => transaction.sourceId === 'flag' && transaction.functionCode === 22 && transaction.result === 'ok')).toBe(true);
    expect(result.blocks['device-0::mixed']!.valid?.slice(3, 5)).toEqual([false, false]);
  });

  it('updates the memoized realtime row when only its write receipt changes', async () => {
    await $('//nav//button[normalize-space(.)="实时"]').click();
    const command = await view().$('[title^="只写点位"]');
    await command.doubleClick();
    await submitRealtimeValue('99');
    await browser.waitUntil(async () => /^99\s*上次写入/.test(await view().$('[title^="只写点位"]').getText()));
    expect((await snapshot()).points['device-0::command']).toMatchObject({
      hasValue: false, lastWrite: { phase: 'confirmed', accepted: { value: 99 } },
    });
  });

  it('keeps accepted command state across a native popout and return', async () => {
    await $('//nav//button[normalize-space(.)="组态画布"]').click();
    await $('[aria-label="弹出当前页面"]').click();
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 2);
    await browser.switchToWindow((await browser.getWindowHandles()).find(id => id !== main)!);
    await $('button=回入主窗口').waitForDisplayed({ timeout: 15000 });
    await expect($('[data-widget-id="input-0"]')).toHaveText(expect.stringContaining('上次写入：99'));
    await expect($('[role="switch"][aria-label="使能命令"]')).toHaveAttribute('aria-checked', 'true');
    await $('button=回入主窗口').click();
    await browser.switchToWindow(main);
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 1);
    await expect(view().$('[data-widget-id="input-0"]')).toHaveText(expect.stringContaining('上次写入：99'));
  });
});
