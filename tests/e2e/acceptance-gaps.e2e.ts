import { browser, $, expect } from '@wdio/globals';
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { templateWorkspace } from '../support/template-workspace';
import type { Workspace } from '../../src/domain/model';
import type { ModbusApi } from '../../src/shared/preload-api';

const snapshot = () => browser.execute(() => (window as unknown as { modbus: ModbusApi }).modbus.getSnapshot());
const click = async (label: string) => { await $(`//button[normalize-space(.)="${label}"]`).click(); };
const rail = async (label: string) => { await $(`//nav//button[normalize-space(.)="${label}"]`).click(); };
const drawerField = (label: string) => `//div[contains(@class,"fixed") and contains(@class,"z-40")]//div[@role="group"][div[normalize-space(.)="${label}"]]//input`;
const groupInput = (label: string) => `//div[@role="group"][div[normalize-space(.)="${label}"]]//input`;
const fill = async (selector: string, value: string) => {
  const input = await $(selector);
  await input.click();
  await browser.keys(['Control', 'a']);
  await browser.keys('Backspace');
  await input.addValue(value);
};
const waitText = (fragment: string) => browser.waitUntil(async () => (await $('body').getText()).includes(fragment), { timeout: 15000 });
const captureFigmaState = async (name: string) => {
  const file = path.resolve('out/audit/figma-current', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await browser.saveScreenshot(file);
};

async function applyWorkspace(workspace: Workspace): Promise<void> {
  await browser.keys('Escape');
  const result = await browser.execute(async value =>
    (window as unknown as { modbus: ModbusApi }).modbus.command({ type: 'workspace.apply', workspace: value }), workspace);
  expect(result.ok).toBe(true);
}

async function openRegisterImport(): Promise<void> {
  await rail('模板');
  await $('//nav[@aria-label="设备模板树"]//button[contains(.,"控制寄存器")]').click();
  await click('导入寄存器表');
}

async function importFile(filePath: string, expectedName: string, count: number, screenshotName?: string): Promise<void> {
  const picker = await browser.electron.mock('dialog', 'showOpenDialog');
  await picker.mockResolvedValue({ canceled: false, filePaths: [filePath] });
  await click('更换文件');
  await waitText(expectedName);
  expect(await $('body').getText()).toContain(path.basename(filePath));
  if (screenshotName) await captureFigmaState(screenshotName);
  const visible = await browser.execute((label) => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
    if (!button) return false;
    const rect = button.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth;
  }, `导入 ${count} 个点位`);
  expect(visible).toBe(true);
  await click(`导入 ${count} 个点位`);
}

const importedWorkspace = (): Workspace => ({ ...templateWorkspace(), connections: [], slaves: [], trendGroups: [] });
const demoWorkspace = (): Workspace => {
  const workspace = JSON.parse(fs.readFileSync('tools/e2e/demo.workspace.json', 'utf8')) as Workspace;
  workspace.connections = workspace.connections.filter(item => item.id === 'conn-tcp');
  workspace.slaves = workspace.slaves.filter(item => item.connectionId === 'conn-tcp');
  return workspace;
};

let xlsxPath: string;
let jsonPath: string;
let overlapPath: string;

describe('验收缺口：实际文件导入、保存为数据块与缩放', () => {
  before(async () => {
    const dir = path.join(process.env.MODBUS_TEST_RUN_DIR!, 'acceptance-import');
    fs.mkdirSync(dir, { recursive: true });
    xlsxPath = path.join(dir, 'registers.xlsx');
    jsonPath = path.join(dir, 'registers.json');
    overlapPath = path.join(dir, 'overlap.json');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Registers');
    sheet.addRow(['Address', 'Name', 'Type', 'Access', 'Unit', 'Scale', 'Offset']);
    sheet.addRow(['40201', 'ExcelUInt', 'UInt16', 'RW', 'rpm', '0.5', '2']);
    sheet.addRow(['40203', 'ExcelWide', 'Float32', 'R', 'V', '1', '0']);
    await workbook.xlsx.writeFile(xlsxPath);
    fs.writeFileSync(jsonPath, JSON.stringify([{ Address: '30051', Name: 'JsonInput', Type: 'Float64', Access: 'RW', Unit: 'Hz', Scale: '1.25', Offset: '-3' }]));
    fs.writeFileSync(overlapPath, JSON.stringify([{ Address: '40001', Name: 'Overlap', Type: 'UInt16', Access: 'R', Unit: '', Scale: '1', Offset: '0' }]));
  });
  after(async () => {
    // The next WDIO spec starts a fresh app against the same isolated test root.
    // Restore its staged workspace so import-only scenarios cannot leak into it.
    await applyWorkspace(JSON.parse(fs.readFileSync('tools/e2e/demo.workspace.json', 'utf8')) as Workspace);
    const saved = await browser.execute(() => (window as unknown as { modbus: ModbusApi }).modbus.command({ type: 'workspace.save' }));
    expect(saved.ok).toBe(true);
  });
  afterEach(async () => { await browser.electron.restoreAllMocks(); });

  it('通过文件选择和导入按钮将 XLSX 地址、类型、宽度与缩放保存到目标模板', async () => {
    await applyWorkspace(importedWorkspace());
    await openRegisterImport();
    await importFile(xlsxPath, 'ExcelUInt', 2, '22-register-import-mapping-preview.png');
    await browser.waitUntil(async () => (await snapshot()).workspace.templates[0]!.points.some(point => point.name === 'ExcelWide'));
    const template = (await snapshot()).workspace.templates.find(item => item.id === 't1')!;
    const block = template.blocks.find(item => item.start === 200)!;
    expect([block.area, block.start, block.length]).toEqual([3, 200, 4]);
    expect(template.points.find(item => item.name === 'ExcelUInt')).toMatchObject({
      blockId: block.id, mapping: { rawType: 'UInt16', offset: 0, registerCount: 1 }, scale: 0.5, offset: 2,
    });
    expect(template.points.find(item => item.name === 'ExcelWide')).toMatchObject({
      blockId: block.id, mapping: { rawType: 'Float32', offset: 2, registerCount: 2 }, access: 'ro',
    });
  });

  it('通过 JSON 文件导入 Input 地址，并拒绝与现有数据块重叠的文件', async () => {
    await applyWorkspace(importedWorkspace());
    await openRegisterImport();
    await importFile(jsonPath, 'JsonInput', 1);
    await browser.waitUntil(async () => (await snapshot()).workspace.templates[0]!.points.some(point => point.name === 'JsonInput'));
    const before = (await snapshot()).workspace.templates.find(item => item.id === 't1')!;
    const block = before.blocks.find(item => item.area === 4 && item.start === 50)!;
    expect(block.length).toBe(4);
    expect(before.points.find(item => item.name === 'JsonInput')).toMatchObject({
      blockId: block.id, mapping: { rawType: 'Float64', offset: 0, registerCount: 4 }, access: 'ro', scale: 1.25, offset: -3,
    });

    await browser.electron.restoreAllMocks();
    await click('导入寄存器表');
    await importFile(overlapPath, 'Overlap', 1);
    await waitText('同地址区数据块重叠');
    const after = (await snapshot()).workspace.templates.find(item => item.id === 't1')!;
    expect(after.blocks).toEqual(before.blocks);
    expect(after.points).toEqual(before.points);
    await click('取消');
  });

  it('临时读取后通过模板下拉保存到所选模板，并通过新建模板按钮另存一块', async () => {
    await applyWorkspace(demoWorkspace());
    await rail('设备');
    await $('//button[contains(.,"生产线 TCP")]').click();
    await browser.waitUntil(async () => (await snapshot()).connections['conn-tcp']?.state === 'online', { timeout: 20000 });
    await click('临时读取');
    await fill('input[aria-label="起始地址"]', '20');
    await click('读取');
    await waitText('读取成功');
    await click('保存为数据块');
    const target = '//div[@role="group"][div[normalize-space(.)="目标模板"]]//button';
    await $(target).waitForDisplayed();
    await captureFigmaState('18B-save-as-block-dialog.png');
    await $(target).click();
    await $('//*[@role="option"][contains(.,"FlowMeter-485")]').waitForDisplayed();
    await captureFigmaState('18C-save-as-block-template-dropdown.png');
    await $('//*[@role="option"][contains(.,"FlowMeter-485")]').click();
    await fill(groupInput('数据块名称'), '下拉目标块');
    await click('保存数据块');
    await browser.waitUntil(async () => (await snapshot()).workspace.templates.find(item => item.id === 'tpl-flow')?.blocks.some(block => block.name === '下拉目标块'));
    const selected = (await snapshot()).workspace;
    expect(selected.templates.find(item => item.id === 'tpl-flow')?.blocks.find(block => block.name === '下拉目标块')).toMatchObject({ area: 3, start: 20, length: 10 });
    expect(selected.templates.find(item => item.id === 'tpl-servo')?.blocks.some(block => block.name === '下拉目标块')).toBe(false);

    await click('保存为数据块');
    await $(target).click();
    await $('//*[@role="option"][contains(.,"新建模板")]').click();
    await fill('//*[@role="dialog"][.//h2[normalize-space(.)="新建设备模板"]]//div[@role="group"][div[normalize-space(.)="名称"]]//input', '现场新模板');
    await captureFigmaState('18D-save-as-block-new-template-dialog.png');
    await click('创建并选择');
    await browser.waitUntil(async () => (await snapshot()).workspace.templates.some(item => item.name === '现场新模板'));
    await browser.waitUntil(async () => (await $(target).getText()).includes('现场新模板'));
    await fill(groupInput('数据块名称'), '新模板块');
    await click('保存数据块');
    await browser.waitUntil(async () => (await snapshot()).workspace.templates.find(item => item.name === '现场新模板')?.blocks.some(block => block.name === '新模板块'));
    const created = (await snapshot()).workspace.templates.find(item => item.name === '现场新模板')!;
    expect(created.blocks.find(block => block.name === '新模板块')).toMatchObject({ area: 3, start: 20, length: 10 });
  });

  it('通过点位抽屉输入缩放参数、保存，并在映射详情显示持久化公式', async () => {
    await applyWorkspace(importedWorkspace());
    await rail('模板');
    await $('//nav[@aria-label="设备模板树"]//button[contains(.,"控制寄存器")]').click();
    await click('＋ 添加点位');
    await fill(drawerField('名称'), 'ScaleProbe');
    await fill(drawerField('寄存器偏移'), '11');
    await fill(drawerField('缩放因子'), '0.25');
    await fill(drawerField('偏移量'), '5');
    await waitText('工程值 = Raw × 0.25 + 5');
    await $('//div[contains(@class,"fixed") and contains(@class,"z-40")]//button[normalize-space(.)="保存点位"]').click();
    await browser.waitUntil(async () => (await snapshot()).workspace.templates[0]!.points.some(point => point.name === 'ScaleProbe'));
    const point = (await snapshot()).workspace.templates[0]!.points.find(item => item.name === 'ScaleProbe')!;
    expect([point.mapping.rawType, point.mapping.offset, point.scale, point.offset]).toEqual(['UInt16', 11, 0.25, 5]);
    await $('//tbody/tr[.//text()[contains(.,"ScaleProbe")]]').click();
    await waitText('工程值 = 原始值 × 0.25 + 5');
    await click('编辑点位');
    expect(await $(drawerField('缩放因子')).getValue()).toBe('0.25');
    expect(await $(drawerField('偏移量')).getValue()).toBe('5');
    await captureFigmaState('24-point-scale-0.25-offset-5-drawer.png');
  });
});
