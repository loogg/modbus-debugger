import { browser, $, expect } from '@wdio/globals';
import fs from 'node:fs';
import path from 'node:path';
import type { ModbusApi } from '../../src/shared/preload-api';
import type { Workspace } from '../../src/domain/model';

const rail = (name: string) => $(`//nav//button[normalize-space(.)="${name}"]`).click();
const fixture = (): Workspace => JSON.parse(fs.readFileSync('tools/e2e/demo.workspace.json', 'utf8')) as Workspace;
const sidebarWidth = () => browser.execute(() => document.querySelector<HTMLDivElement>('div[title="拖拽调整宽度，双击恢复 244 px"]')!.parentElement!.getBoundingClientRect().width);

async function useIsolatedWorkspace(extraBlocks = false) {
  const ws = fixture();
  ws.connections = ws.connections.filter(c => c.id === 'conn-tcp');
  ws.slaves = ws.slaves.filter(s => s.connectionId === 'conn-tcp');
  if (extraBlocks) {
    const template = ws.templates.find(t => t.id === 'tpl-servo')!;
    for (let i = 0; i < 12; i++) template.blocks.push({ id: `layout-block-${i}`, name: `Layout block ${i}`, area: 3, start: 200 + i * 20, length: 4, periodMs: 60000 });
  }
  const result = await browser.execute(async value => (window as unknown as { modbus: ModbusApi }).modbus.command({ type: 'workspace.apply', workspace: value }), ws);
  expect(result.ok).toBe(true);
}

async function setWindowSize(width: number, height: number) {
  await browser.electron.execute((electron, w, h) => electron.BrowserWindow.getAllWindows()[0]!.setSize(w, h), width, height);
  await browser.waitUntil(async () => {
    const actual = await browser.execute(() => innerWidth);
    return actual > width - 100 && actual <= width;
  }, { timeout: 10000 });
}

describe('Sidebar, sticky engineering columns and compact overlays', () => {
  before(async () => { await useIsolatedWorkspace(); });

  it('keeps the realtime header and Point column fixed while the 1024 window scrolls in both directions', async () => {
    await setWindowSize(1024, 680);
    try {
      const handle = await $('div[title="拖拽调整宽度，双击恢复 244 px"]');
      await browser.action('pointer').move({ origin: handle, x: 0, y: 0 }).down('left')
        .move({ origin: 'pointer', x: 100, y: 0, duration: 250 }).up('left').perform();
      expect(await sidebarWidth()).toBe(320);
      await rail('实时');
      await $('//button[contains(.,"伺服驱动器 A")]').click();
      const scroller = await $('main div.overflow-auto[style*="max-height"]');
      await scroller.waitForExist();
      await browser.action('wheel').scroll({ origin: scroller, deltaX: 180, deltaY: 220, duration: 200 }).perform();
      const metrics = await browser.execute(() => {
        const box = document.querySelector<HTMLElement>('main div.overflow-auto[style*="max-height"]')!;
        const header = box.querySelector<HTMLElement>(':scope > div > div.sticky.top-0')!;
        const pointHeader = header.querySelector<HTMLElement>('.sticky.left-0')!;
        const pointCell = box.querySelector<HTMLElement>('div.absolute .sticky.left-0')!;
        return {
          scrollX: box.scrollLeft, scrollY: box.scrollTop,
          overflowX: box.scrollWidth > box.clientWidth, overflowY: box.scrollHeight > box.clientHeight,
          boxLeft: box.getBoundingClientRect().left, boxTop: box.getBoundingClientRect().top,
          headerTop: header.getBoundingClientRect().top,
          pointHeaderLeft: pointHeader.getBoundingClientRect().left,
          pointCellLeft: pointCell.getBoundingClientRect().left,
          pointCellBackground: getComputedStyle(pointCell).backgroundColor,
        };
      });
      expect(metrics.overflowX && metrics.overflowY).toBe(true);
      expect(metrics.scrollX).toBeGreaterThan(0);
      expect(metrics.scrollY).toBeGreaterThan(0);
      expect(Math.abs(metrics.headerTop - metrics.boxTop)).toBeLessThan(4);
      expect(Math.abs(metrics.pointHeaderLeft - metrics.boxLeft)).toBeLessThan(4);
      expect(Math.abs(metrics.pointCellLeft - metrics.boxLeft)).toBeLessThan(4);
      expect(metrics.pointCellBackground).not.toBe('rgba(0, 0, 0, 0)');
    } finally {
      await $('div[title="拖拽调整宽度，双击恢复 244 px"]').doubleClick();
      await setWindowSize(1440, 960);
    }
  });

  it('scrolls Drawer and Dialog content internally at 1024×680 while their actions stay visible', async () => {
    await useIsolatedWorkspace(true);
    await setWindowSize(1024, 680);
    try {
      await rail('设备');
      await $('//button[contains(.,"添加连接")]').click();
      const dialogBody = await $('[role="dialog"] > div.overflow-y-auto');
      await dialogBody.waitForExist();
      const dialogBefore = await browser.execute(() => {
        const root = document.querySelector<HTMLElement>('[role="dialog"]')!;
        const body = root.querySelector<HTMLElement>(':scope > div.overflow-y-auto')!;
        return { overflow: body.scrollHeight > body.clientHeight, bottom: root.getBoundingClientRect().bottom, viewport: innerHeight };
      });
      expect(dialogBefore.overflow).toBe(true);
      expect(dialogBefore.bottom).toBeLessThanOrEqual(dialogBefore.viewport + 1);
      await browser.action('wheel').scroll({ origin: dialogBody, deltaY: 420, duration: 200 }).perform();
      expect(await browser.execute(() => document.querySelector<HTMLElement>('[role="dialog"] > div.overflow-y-auto')!.scrollTop)).toBeGreaterThan(0);
      expect(await $('//div[@role="dialog"]//button[normalize-space(.)="创建连接"]').isDisplayed()).toBe(true);
      await $('//div[@role="dialog"]//button[normalize-space(.)="取消"]').click();

      await rail('模板');
      await $('//button[normalize-space(.)="打开数据块"]').click();
      await $('//button[contains(.,"添加点位")]').click();
      const drawerBody = await $('div.fixed.inset-0.z-40 > div.absolute.right-0 > div.flex-1.overflow-y-auto');
      await drawerBody.waitForExist();
      const drawerBefore = await browser.execute(() => {
        const root = document.querySelector<HTMLElement>('div.fixed.inset-0.z-40 > div.absolute.right-0')!;
        const body = root.querySelector<HTMLElement>(':scope > div.flex-1.overflow-y-auto')!;
        return { overflow: body.scrollHeight > body.clientHeight, bottom: root.getBoundingClientRect().bottom, viewport: innerHeight };
      });
      expect(drawerBefore.overflow).toBe(true);
      expect(drawerBefore.bottom).toBeLessThanOrEqual(drawerBefore.viewport + 1);
      await browser.action('wheel').scroll({ origin: drawerBody, deltaY: 420, duration: 200 }).perform();
      expect(await browser.execute(() => document.querySelector<HTMLElement>('div.fixed.inset-0.z-40 > div.absolute.right-0 > div.flex-1.overflow-y-auto')!.scrollTop)).toBeGreaterThan(0);
      expect(await $('//div[contains(@class,"fixed") and contains(@class,"z-40")]//button[normalize-space(.)="保存点位"]').isDisplayed()).toBe(true);
      await $('//div[contains(@class,"fixed") and contains(@class,"z-40")]//button[normalize-space(.)="取消"]').click();
    } finally { await setWindowSize(1440, 960); }
  });

  it('persists a mouse-dragged sidebar width to prefs and restores it after a new Electron session', async () => {
    await rail('设备');
    const before = await sidebarWidth();
    const handle = await $('div[title="拖拽调整宽度，双击恢复 244 px"]');
    await browser.action('pointer').move({ origin: handle, x: 0, y: 0 }).down('left')
      .move({ origin: 'pointer', x: 55, y: 0, duration: 250 }).up('left').perform();
    const resized = await sidebarWidth();
    expect(resized).toBeGreaterThan(before + 30);
    expect(resized).toBeLessThanOrEqual(320);
    const prefsPath = path.join(process.env.MODBUS_TEST_RUN_DIR!, 'data', 'prefs.json');
    await browser.waitUntil(() => JSON.parse(fs.readFileSync(prefsPath, 'utf8')).sidebarWidth === resized, { timeout: 5000 });
    const oldSession = browser.sessionId;
    await browser.reloadSession();
    expect(browser.sessionId).not.toBe(oldSession);
    await $('div[title="拖拽调整宽度，双击恢复 244 px"]').waitForExist({ timeout: 20000 });
    await browser.waitUntil(async () => (await sidebarWidth()) === resized, { timeout: 20000 });
    expect(JSON.parse(fs.readFileSync(prefsPath, 'utf8')).sidebarWidth).toBe(resized);
  });
});
