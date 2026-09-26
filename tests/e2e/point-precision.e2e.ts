import { browser, $, expect } from '@wdio/globals';
import fs from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../../src/domain/model';
import type { ModbusApi } from '../../src/shared/preload-api';

const fixture = () => JSON.parse(fs.readFileSync('tools/e2e/demo.workspace.json', 'utf8')) as Workspace;
const snapshot = () => browser.execute(() => (window as unknown as { modbus: ModbusApi }).modbus.getSnapshot());
const rail = (name: string) => $(`//nav//button[normalize-space(.)="${name}"]`).click();
const shot = async (name: string) => {
  const file = path.resolve('out/audit/point-precision', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await browser.saveScreenshot(file);
};

async function applyWorkspace(workspace: Workspace): Promise<void> {
  const result = await browser.execute(async (value) =>
    (window as unknown as { modbus: ModbusApi }).modbus.command({ type: 'workspace.apply', workspace: value }), workspace);
  expect(result.ok).toBe(true);
}

describe('point decimal precision in real editor and trend', () => {
  before(async () => {
    const workspace = fixture();
    workspace.connections = workspace.connections.filter((connection) => connection.id === 'conn-tcp');
    workspace.slaves = workspace.slaves.filter((slave) => slave.connectionId === 'conn-tcp');
    await applyWorkspace(workspace);
  });

  after(async () => {
    await browser.keys('Escape');
    await applyWorkspace(fixture());
    const saved = await browser.execute(() => (window as unknown as { modbus: ModbusApi }).modbus.command({ type: 'workspace.save' }));
    expect(saved.ok).toBe(true);
  });

  it('saves two decimal places, keeps full sample precision, and renders a short trend tooltip', async () => {
    await rail('模板');
    await $('//nav[@aria-label="设备模板树"]//button[contains(.,"控制寄存器")]').click();
    await $('//tbody/tr[.//*[text()="母线电压"]]').click();
    await $('//button[normalize-space(.)="编辑点位"]').click();
    const drawer = '//div[contains(@class,"fixed") and contains(@class,"z-40")]';
    const precision = `${drawer}//div[@role="group"][div[normalize-space(.)="最多小数位"]]//button`;
    await $(precision).click();
    await $('//*[@role="option"][normalize-space(.)="2"]').click();
    expect(await $(precision).getText()).toContain('2');
    await shot('point-editor-1440.png');

    await browser.electron.execute((electron) => electron.BrowserWindow.getAllWindows()[0]!.setSize(1024, 680));
    await browser.waitUntil(async () => await browser.execute(() => innerWidth <= 1024));
    const geometry = await browser.execute(() => {
      const root = document.querySelector('div.fixed.inset-0.z-40')!;
      const field = [...root.querySelectorAll<HTMLElement>('[role="group"]')].find((item) => item.textContent?.includes('最多小数位') && item.querySelector('button'))!;
      const save = [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === '保存点位' && item.closest('div.fixed.inset-0.z-40'))!;
      return { fieldBottom: field.getBoundingClientRect().bottom, saveBottom: save.getBoundingClientRect().bottom, width: document.documentElement.scrollWidth, viewportWidth: innerWidth, viewportHeight: innerHeight };
    });
    expect(geometry.width).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(geometry.fieldBottom).toBeLessThanOrEqual(geometry.viewportHeight);
    expect(geometry.saveBottom).toBeLessThanOrEqual(geometry.viewportHeight);
    await shot('point-editor-1024.png');
    await browser.electron.execute((electron) => electron.BrowserWindow.getAllWindows()[0]!.setSize(1440, 960));
    await $(`${drawer}//button[normalize-space(.)="保存点位"]`).click();
    await browser.waitUntil(async () => (await snapshot()).workspace.templates.find((template) => template.id === 'tpl-servo')?.points.find((point) => point.id === 'pt-volt')?.decimalPlaces === 2);

    await rail('实时');
    await browser.waitUntil(async () => (await snapshot()).points['slave-1::pt-volt']?.hasValue === true, { timeout: 20000 });
    const confirmed = (await snapshot()).points['slave-1::pt-volt']!;
    expect(confirmed.engNumber).not.toBeNull();
    expect(confirmed.engText).toMatch(/^-?\d+(?:\.\d{1,2})?$/);
    expect(Number.isFinite(confirmed.engNumber)).toBe(true);

    await rail('趋势');
    await browser.waitUntil(async () => (await $('body').getText()).includes(confirmed.engText), { timeout: 15000 });
    await $('//button[normalize-space(.)="图表"]').click();
    const chart = await $('div[data-chart-units] canvas');
    await chart.waitForExist({ timeout: 15000 });
    const rect = await browser.execute(() => {
      const canvas = document.querySelector('div[data-chart-units] canvas')!;
      const bounds = canvas.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    });
    let tooltip = '';
    for (const inset of [35, 50, 70, 90, 120]) {
      await browser.action('pointer').move({ x: Math.round(rect.x + rect.width - inset), y: Math.round(rect.y + rect.height / 2) }).perform();
      await browser.waitUntil(async () => (await browser.execute(() => document.querySelector('.modbus-chart-tooltip')?.textContent ?? '')).includes('母线电压'), { timeout: 1200 }).catch(() => undefined);
      tooltip = await browser.execute(() => document.querySelector('.modbus-chart-tooltip')?.textContent ?? '');
      if (tooltip.includes('母线电压')) break;
    }
    expect(tooltip).toContain('母线电压');
    const voltage = tooltip.match(/母线电压:\s*(-?\d+(?:\.\d+)?)/)?.[1];
    expect(voltage).toBeDefined();
    expect(voltage!.split('.')[1]?.length ?? 0).toBeLessThanOrEqual(2);
    await shot('trend-tooltip-1440.png');
  });
});
