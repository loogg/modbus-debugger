import { browser, $, expect } from '@wdio/globals';
import { canvasSchema } from '../../src/domain/canvas';
import type { ModbusApi } from '../../src/shared/preload-api';

const view = () => $('.workbench-view:not([style*="display: none"])');
const snapshot = () => browser.execute(async () => (window as unknown as { modbus: ModbusApi }).modbus.getSnapshot());
const canvasId = 'layout-e2e';

async function geometry(id: string) {
  return browser.execute(pointId => {
    const root = document.querySelector('.workbench-view:not([style*="display: none"])')!;
    const stage = root.querySelector<HTMLElement>('[data-testid="canvas-stage"]')!;
    const bounds = stage.getBoundingClientRect();
    const scale = bounds.width / stage.offsetWidth;
    const widget = root.querySelector(`[data-widget-id="${pointId}"]`)!.getBoundingClientRect();
    return { x: (widget.x - bounds.x) / scale, y: (widget.y - bounds.y) / scale, width: widget.width / scale, height: widget.height / scale };
  }, id);
}

async function gridSize(size: number) {
  await view().$('[aria-label="网格设置"]').click();
  await view().$(`[aria-label="网格间距 ${size} 像素"]`).click();
  await browser.keys('Escape');
}

async function drag(id: string, dx: number, dy: number, alt = false, resize = false) {
  const widget = await view().$(`[data-widget-id="${id}"]`);
  const target = resize ? await widget.$('..').$('..').$('.canvas-resize-bottom-right') : widget;
  if (alt) await browser.action('key').down('\uE00A').perform(true);
  try {
    await browser.action('pointer').move({ origin: target, x: 0, y: 0 }).down('left')
      .move({ origin: 'pointer', x: dx, y: dy, duration: 250 }).up('left').perform();
  } finally { await browser.releaseActions(); }
}

describe('Configurable canvas grid and alignment in packaged Electron', () => {
  let main: string;
  before(async () => {
    await $('nav').waitForDisplayed({ timeout: 20000 });
    main = await browser.getWindowHandle();
    const canvas = canvasSchema.parse({ id: canvasId, name: '布局验证', width: 960, height: 680, widgets: [
      { id: 'lamp-a', kind: 'lamp', label: '指示灯 A', x: 41, y: 59, width: 24, height: 24 },
      { id: 'switch-b', kind: 'switch', label: '开关 B', x: 171, y: 103, width: 56, height: 28 },
      { id: 'lamp-c', kind: 'lamp', label: '指示灯 C', x: 341, y: 171, width: 32, height: 32 },
      { id: 'outer', kind: 'container', label: '容器', showLabel: true, x: 70, y: 300, width: 650, height: 300 },
      { id: 'inner', kind: 'container', label: '嵌套容器', parentId: 'outer', showLabel: true, x: 57, y: 63, width: 340, height: 180 },
      { id: 'nested-lamp', kind: 'lamp', label: '容器指示灯', parentId: 'inner', x: 13, y: 37, width: 24, height: 24 },
    ] });
    const created = await browser.execute(async value => (window as unknown as { modbus: ModbusApi }).modbus.command({ type: 'canvas.create', canvas: value }), canvas);
    expect(created.ok).toBe(true);
    await $('//nav//button[normalize-space(.)="组态画布"]').click();
    await view().$('button=布局验证').click();
    await view().$('button=编辑').click();
  });

  it('places newly clicked controls at the configured coarse grid spacing', async () => {
    await gridSize(24);
    await view().$('.canvas-library').$('button=数值显示').click();
    await expect(view().$('[aria-label="X"]')).toHaveValue('120');
    const name = await view().$('[aria-label="控件名称"]');
    await name.click(); await browser.keys(['Control', 'a']); await browser.keys('Backspace'); await name.addValue('Added A');
    await view().$('.canvas-library').$('button=数值显示').click();
    await expect(view().$('[aria-label="X"]')).toHaveValue('144');
    await view().$('[aria-label="删除所选控件"]').click();
    await view().$('button=Added A').click();
    await view().$('[aria-label="删除所选控件"]').click();
  });

  it('aligns mixed controls, distributes edge gaps and restores saved grid settings', async () => {
    await gridSize(16);
    await view().$('button=指示灯 A').click();
    await browser.action('key').down('\uE008').perform(true);
    try { await view().$('button=开关 B').click(); await view().$('button=指示灯 C').click(); }
    finally { await browser.releaseActions(); }
    await view().$('[aria-label="对齐与分布"]').click();
    await view().$('.//div[@role="menuitem" and normalize-space(.)="垂直居中"]').click();
    const a = await geometry('lamp-a'); const b = await geometry('switch-b'); const c = await geometry('lamp-c');
    expect(a.y + a.height / 2).toBeCloseTo(b.y + b.height / 2);
    expect(c.y + c.height / 2).toBeCloseTo(b.y + b.height / 2);
    await view().$('[aria-label="对齐与分布"]').click();
    await view().$('.//div[@role="menuitem" and normalize-space(.)="水平等间距"]').click();
    const distributed = await geometry('switch-b');
    expect(distributed.x - a.x - a.width).toBeCloseTo(c.x - distributed.x - distributed.width);
    await view().$('[aria-label="撤销"]').click();
    expect((await geometry('switch-b')).x).toBe(171);
    await view().$('[aria-label="重做"]').click();
    await view().$('button=保存画布').click();
    await browser.waitUntil(async () => (await snapshot()).workspace.canvases?.find(canvas => canvas.id === canvasId)?.grid.size === 16);
    await browser.refresh();
    await view().$('button=编辑').waitForDisplayed({ timeout: 10000 });
    await view().$('button=编辑').click();
    await view().$('[aria-label="网格设置"]').click();
    await expect(view().$('[aria-label="网格间距（px）"]')).toHaveValue('16');
    await expect(view().$('input[type="checkbox"]')).toBeSelected();
    await browser.keys('Escape');
  });

  it('snaps nested dragging and resizing at 75 percent zoom in a native popout and supports Alt movement', async () => {
    await $('[aria-label="弹出当前页面"]').click();
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 2);
    await browser.switchToWindow((await browser.getWindowHandles()).find(handle => handle !== main)!);
    await $('button=回入主窗口').waitForDisplayed({ timeout: 15000 });
    await gridSize(32);
    await view().$('[aria-label="画布缩放"]').selectByAttribute('value', '0.75');
    await view().$('button=容器指示灯').click();
    const parent = await geometry('inner');
    await drag('nested-lamp', 15, 9);
    let current = await geometry('nested-lamp');
    expect(Math.abs(current.x - Math.round(current.x / 32) * 32)).toBeCloseTo(0, 1);
    expect(Math.abs(current.y - Math.round(current.y / 32) * 32)).toBeCloseTo(0, 1);
    const beforeAlt = current;
    await drag('nested-lamp', 13, 7, true);
    current = await geometry('nested-lamp');
    expect(current.x - beforeAlt.x).toBeCloseTo(13 / .75, 0);
    expect(current.y - beforeAlt.y).toBeCloseTo(7 / .75, 0);
    await drag('nested-lamp', 21, 15, false, true);
    current = await geometry('nested-lamp');
    const right = current.x + current.width; const bottom = current.y + current.height;
    expect(Math.abs(right - Math.round(right / 32) * 32)).toBeCloseTo(0, 1);
    expect(Math.abs(bottom - Math.round(bottom / 32) * 32)).toBeCloseTo(0, 1);
    expect(await geometry('inner')).toEqual(parent);
    await view().$('button=保存画布').click();
    await browser.waitUntil(async () => (await view().$('button=运行').getAttribute('disabled')) === null);
    await $('button=回入主窗口').click();
    await browser.switchToWindow(main);
    await expect(view().$('[aria-label="画布缩放"]')).toHaveValue('0.75');
    const saved = (await snapshot()).workspace.canvases!.find(canvas => canvas.id === canvasId)!;
    expect(saved.grid).toEqual({ visible: true, snap: true, size: 32 });
    expect(saved.widgets.find(widget => widget.id === 'inner')).toMatchObject({ x: 57, y: 63 });
  });
});
