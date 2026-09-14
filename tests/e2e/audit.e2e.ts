import { browser, $, $$, expect } from '@wdio/globals';
import fs from 'node:fs';
import path from 'node:path';
import type { ModbusApi } from '../../src/shared/preload-api';
import type { Workspace } from '../../src/domain/model';

const fixture = (): Workspace => JSON.parse(fs.readFileSync('tools/e2e/demo.workspace.json', 'utf8')) as Workspace;
const snap = () => browser.execute(() => (window as unknown as { modbus: ModbusApi }).modbus.getSnapshot());
const text = () => $('body').getText();
const click = async (label: string) => { await $(`//button[normalize-space(.)="${label}"]`).click(); };
const rail = async (label: string) => { await $(`//nav//button[contains(.,"${label}")]`).click(); };
const fill = async (selector: string, value: string) => { const el = await $(selector); await el.click(); await browser.keys(['Control','a']); await browser.keys('Backspace'); await el.addValue(value); };
const field = (label: string) => `//div[normalize-space(.)="${label}"]/following-sibling::input`;
const waitText = (fragment: string) => browser.waitUntil(async () => (await text()).includes(fragment), { timeout: 15000 });
const writeValue = async (name: string, value: string) => { await $(`//div[text()="${name}"]/following-sibling::div[2]`).doubleClick(); await fill('input.w-24', value); await browser.keys('Enter'); };
// IPC is only used for fixture setup and read-only observation. Actions under test use real pointer/keyboard input.
async function setup(ws = fixture()) {
  await browser.keys('Escape'); await browser.keys('Escape');
  const result = await browser.execute(async workspace => (window as unknown as { modbus: ModbusApi }).modbus.command({ type: 'workspace.apply', workspace }), ws);
  expect(result.ok).toBe(true);
  await rail('设备');
  await browser.pause(250);
  await $('//button[contains(.,"生产线 TCP")]').click();
}
async function realtime() { await rail('实时'); await $('//button[contains(.,"伺服驱动器 A")]').click(); await browser.waitUntil(async () => (await snap()).points['slave-1::pt-speed']?.hasValue === true, { timeout: 15000 }); }
async function openDialogFile(file: string) { const mock = await browser.electron.mock('dialog', 'showOpenDialog'); await mock.mockResolvedValue({ canceled: false, filePaths: [file] }); return mock; }

let savedClipboard = '';
describe('审计：实际按钮到持久化/通信结果', () => {
  before(async () => { savedClipboard = await browser.electron.execute(electron => electron.clipboard.readText()); });
  after(async () => { await browser.electron.execute((electron, value) => electron.clipboard.writeText(value), savedClipboard); });
  beforeEach(async () => { await setup(); });
  afterEach(async function () {
    await browser.electron.restoreAllMocks();
    if (this.currentTest?.state === 'failed') {
      fs.mkdirSync('out/audit/failures', { recursive: true });
      const name = this.currentTest.title.replace(/[^a-zA-Z0-9一-龥]/g, '_');
      await browser.saveScreenshot(path.resolve('out/audit/failures', `${name}.png`));
      fs.writeFileSync(path.resolve('out/audit/failures', `${name}.txt`), await text());
    }
  });
  it('RTU：通过 UI 新建指定端口连接与从站，实际读写并隔离 TCP', async function () {
    if (!process.env.MODBUS_RTU_MASTER_PORT) this.skip();
    await click('添加连接');
    await fill('//*[@role="dialog"]' + field('连接名称'), '审计 RTU');
    await fill('input[data-testid="port-combo"]', process.env.MODBUS_RTU_MASTER_PORT!);
    await click('创建连接');
    await browser.waitUntil(async () => (await snap()).workspace.connections.some(c => c.name === '审计 RTU'));
    const conn = (await snap()).workspace.connections.find(c => c.name === '审计 RTU')!;
    expect(conn.rtu?.port).toBe(process.env.MODBUS_RTU_MASTER_PORT);
    await $('//button[contains(.,"审计 RTU")]').click();
    await $('//main//button[normalize-space(.)="＋ 添加从站"]').click();
    await fill(field('设备名称'), '串口从站');
    await click('添加从站');
    await browser.waitUntil(async () => (await snap()).workspace.slaves.some(s => s.name === '串口从站'));
    const slave = (await snap()).workspace.slaves.find(s => s.name === '串口从站')!;
    expect(slave.connectionId).toBe(conn.id);
    await rail('实时'); await $('//button[contains(.,"串口从站")]').click();
    await browser.waitUntil(async () => (await snap()).points[`${slave.id}::pt-speed`]?.hasValue === true, { timeout: 15000 });
    await writeValue('目标转速', '2345');
    await browser.waitUntil(async () => (await snap()).points[`${slave.id}::pt-speed`]?.engNumber === 2345);
    expect((await snap()).points['slave-1::pt-speed']?.engNumber).not.toBe(2345);
    expect((await snap()).transactions.some(tx => tx.connectionId === conn.id && tx.functionCode === 6 && tx.result === 'ok' && tx.responseAduHex)).toBe(true);
  });
  it('读取：默认10、真实原始数据、异常原因、输入校验、保存非重叠块', async () => {
    await click('临时读取');
    expect(await $('input[aria-label="数量（寄存器）"]').getValue()).toBe('10');
    await fill('input[aria-label="起始地址"]', '20');
    await click('读取'); await waitText('读取成功');
    await click('原始数据');
    expect(await $('[data-testid="temporary-raw"]').getText()).toBe(Array(10).fill('0000').join(' '));
    await click('保存为数据块'); await click('保存数据块');
    await browser.waitUntil(async () => (await snap()).workspace.templates[0]!.blocks.some(b => b.start === 20 && b.length === 10));
    await fill('input[aria-label="起始地址"]', '128'); await click('读取'); await waitText('设备返回异常 0x02');
    expect(await text()).toContain('Trace ID');
    await fill('input[aria-label="数量（寄存器）"]', '0'); expect(await $('//button[text()="读取"]').isEnabled()).toBe(false);
    await click('查看通信诊断'); await waitText('通信诊断');
  });
  it('扫描：折叠配置、停止保留结果、重扫替换结果、不自动添加从站', async () => {
    await click('扫描');
    expect(await $('details').getAttribute('open')).toBeNull();
    await click('开始扫描');
    await browser.waitUntil(async () => ((await snap()).connections['conn-tcp']?.scan?.checked ?? 0) >= 3);
    await click('停止扫描'); await waitText('扫描已停止');
    const stopped = (await snap()).connections['conn-tcp']!.scan!;
    expect(stopped.checked).toBeLessThan(247);
    expect((await snap()).workspace.slaves).toHaveLength(1);
    await fill('[data-testid="scan-from"]', '2'); await fill('[data-testid="scan-to"]', '3');
    await $('summary').click(); await fill('input[aria-label="起始地址（0-based）"]', '128');
    await click('开始扫描'); await waitText('扫描摘要');
    const units = await browser.execute(() => [...document.querySelectorAll('tbody tr')].map(row => row.children[0]?.textContent?.trim()));
    expect(units).toEqual(['2','3']); expect(await text()).toContain('异常响应 0x02');
    await $('//tbody/tr[1]//button').click();
    expect(await $(field('从站地址 (Unit ID)')).getValue()).toBe('2');
    await click('取消');
  });
  it('高风险写入确认/取消、无效 Bool 不发包、手动刷新确实发起读取', async () => {
    const ws = fixture(); ws.templates[0]!.points.find(p => p.id === 'pt-speed')!.highRisk = true;
    ws.templates[0]!.blocks.forEach(b => { b.periodMs = 60000; }); await setup(ws); await realtime();
    const before = (await snap()).points['slave-1::pt-speed']?.engNumber;
    await writeValue('目标转速', '2100'); await waitText('确认高风险写入'); await click('取消');
    expect((await snap()).points['slave-1::pt-speed']?.engNumber).toBe(before);
    await writeValue('目标转速', '2100'); await click('确认写入');
    await browser.waitUntil(async () => (await snap()).points['slave-1::pt-speed']?.engNumber === 2100);
    const writes = (await snap()).transactions.filter(tx => tx.sourceKind === 'write').length;
    await writeValue('使能', 'invalid'); await waitText('请输入 ON/OFF');
    expect((await snap()).transactions.filter(tx => tx.sourceKind === 'write')).toHaveLength(writes);
    const last = (await snap()).transactions.at(-1)?.traceId;
    await click('刷新全部');
    await browser.waitUntil(async () => (await snap()).transactions.at(-1)?.traceId !== last);
  });
  it('趋势：暂停冻结时间、恢复继续、窗口配置保存、显隐与删除信号', async () => {
    await rail('趋势'); await click('图表'); await browser.pause(500);
    await click('暂停'); const end = await $('[data-testid="trend-window"]').getAttribute('data-end-ms');
    await browser.pause(700); expect(await $('[data-testid="trend-window"]').getAttribute('data-end-ms')).toBe(end);
    await click('继续'); await browser.waitUntil(async () => Number(await $('[data-testid="trend-window"]').getAttribute('data-end-ms')) > Number(end));
    await $('select').selectByAttribute('value','30');
    await browser.waitUntil(async () => (await snap()).workspace.trendGroups[0]?.windowSec === 30);
    await click('信号'); await $('button[title="隐藏图表"]').click();
    await browser.waitUntil(async () => (await snap()).workspace.trendGroups[0]?.signals[0]?.visible === false);
    await $('//button[text()="移除"]').click();
    await browser.waitUntil(async () => (await snap()).workspace.trendGroups[0]?.signals.length === 3);
  });
  it('通信：暂停冻结行、搜索/结果过滤生效、清空、恢复、导出真实帧', async () => {
    await rail('通信'); await click('报文'); await waitText('FC03');
    await click('暂停'); const rows = await $$('tbody tr').map(row => row.getText());
    await browser.pause(700); expect(await $$('tbody tr').map(row => row.getText())).toEqual(rows);
    await fill('input[placeholder*="搜索"]','impossible-search'); expect(await $$('tbody tr')).toHaveLength(0);
    await fill('input[placeholder*="搜索"]',''); await click('仅异常'); expect((await $$('tbody tr').map(row => row.getText())).every(row => !row.includes('成功'))).toBe(true);
    await click('仅异常'); await click('导出日志');
    expect(await browser.electron.execute(electron => electron.clipboard.readText())).toContain('FC3');
    await click('清空'); expect(await $$('tbody tr')).toHaveLength(0);
    await click('继续显示'); await waitText('FC03');
    await $('//tbody/tr[1]').click(); expect(await text()).toContain('响应');
  });
  it('模板：复制隔离 ID、内存显示真实数据、编辑保存、导入 CSV 的 UInt16 与宽度', async () => {
    await rail('模板'); await click('复制模板');
    await browser.waitUntil(async () => (await snap()).workspace.templates.length === 2);
    const templates = (await snap()).workspace.templates;
    expect(new Set(templates.flatMap(t => t.points.map(p => p.id))).size).toBe(18);
    await $('//button[contains(.,"ServoDrive V2") and not(contains(.,"副本"))]').click();
    await click('编辑模板'); await click('内存布局');
    expect(await text()).toContain('0x0011');
    await click('点位映射'); await click('导入寄存器表');
    await browser.electron.execute(electron => electron.clipboard.writeText('Address,Name,Type,Access,Unit,Scale,Offset\n100,Unsigned,UInt16,RW,,1,0\n102,Wide,Float32,R,,1,0'));
    await click('粘贴表格'); await waitText('Unsigned'); await click('导入 2 个点位');
    await browser.waitUntil(async () => (await snap()).workspace.templates[0]!.points.some(p => p.name === 'Wide'));
    const template = (await snap()).workspace.templates[0]!;
    expect(template.points.find(p => p.name === 'Unsigned')?.mapping.rawType).toBe('UInt16');
    expect(template.blocks.find(b => b.start === 100)?.length).toBe(4);
    await click('保存');
    expect((await snap()).dirty).toBe(false);
  });
  it('历史：记录实际样本、备注持久化、CSV 转义、回放播放/暂停与返回', async () => {
    await realtime(); await rail('趋势'); await click('● 开始记录'); await browser.pause(1400); await click('■ 停止记录');
    await rail('历史'); await waitText('功耗分析');
    await click('添加备注'); await fill('input[aria-label="备注内容"]','audit "note",测试'); await click('保存备注'); await waitText('audit "note",测试');
    await click('导出 CSV');
    expect(await browser.electron.execute(electron => electron.clipboard.readText())).toContain('"audit ""note"",测试"');
    await click('回放'); await click('▶ 播放'); await browser.pause(600); await click('暂停');
    expect(await $('input[type="range"]').getValue()).not.toBe('0');
    await click('返回历史'); await click('信号'); expect(await text()).toContain('连续样本');
    const sessions = (await snap()).sessions; expect(sessions[0]!.sampleCount).toBeGreaterThan(0);
    await fill('input[aria-label="历史从站筛选"]', 'no-such-slave');
    expect(await $$('button[data-session-id]')).toHaveLength(0);
    await click('清除筛选'); expect((await $$('button[data-session-id]')).length).toBeGreaterThan(0);
    await $('select[aria-label="历史趋势组"]').selectByAttribute('value', 'g-power');
    expect((await $$('button[data-session-id]')).length).toBeGreaterThan(0);
  });
  it('设置：另存为文件、导出、导入失败保留工作区、导航与诊断清空确认', async () => {
    await rail('设置');
    const target = path.resolve(process.env.MODBUS_TEST_RUN_DIR!, 'audit-saved.workspace.json');
    const save = await browser.electron.mock('dialog','showSaveDialog'); await save.mockResolvedValue({ canceled: false, filePath: target });
    await click('另存为'); await browser.waitUntil(() => fs.existsSync(target));
    expect(JSON.parse(fs.readFileSync(target,'utf8')).name).toBe(fixture().name);
    await click('导出工作区'); expect(JSON.parse(await browser.electron.execute(electron => electron.clipboard.readText())).templates).toHaveLength(1);
    const invalid = path.resolve(process.env.MODBUS_TEST_RUN_DIR!, 'invalid.json'); fs.writeFileSync(invalid,'invalid json');
    await openDialogFile(invalid); await click('导入工作区'); await waitText('操作失败'); expect((await snap()).workspace.name).toBe(fixture().name);
    await click('日志'); await click('清空通信诊断'); await click('取消');
    expect((await snap()).transactions.length).toBeGreaterThan(0);
    await click('清空通信诊断'); const rev = (await snap()).diagRev; await click('清空'); await browser.waitUntil(async () => (await snap()).diagRev > rev);
  });
  it('新建模板/块/点位、编辑校验、导出模板与独立导入', async () => {
    await rail('模板'); await click('新建设备模板');
    await browser.waitUntil(async () => (await snap()).workspace.templates.length === 2);
    if (await $('//button[text()="编辑模板"]').isExisting()) await click('编辑模板');
    await click('＋ 添加数据块'); await fill(field('名称'), 'Audit block'); await fill(field('起始地址'), '30'); await fill(field('长度'), '4'); await click('保存数据块');
    await waitText('Audit block'); await click('＋ 添加点位'); await fill(field('名称'), 'Audit point');
    await fill(field('寄存器偏移'), '10'); await click('保存点位'); await waitText('操作失败');
    expect(await $('//button[text()="保存点位"]').isExisting()).toBe(true);
    await fill(field('寄存器偏移'), '1'); await click('保存点位');
    await browser.waitUntil(async () => (await snap()).workspace.templates[1]?.points.length === 1);
    await click('编辑点位'); await fill(field('名称'), 'Edited point'); await click('保存点位');
    await browser.waitUntil(async () => (await snap()).workspace.templates[1]?.points[0]?.name === 'Edited point');
    await click('导出模板'); const exported = await browser.electron.execute(electron => electron.clipboard.readText());
    expect(JSON.parse(exported).points[0].mapping.offset).toBe(1);
    const file = path.resolve(process.env.MODBUS_TEST_RUN_DIR!, 'standalone-template.json'); fs.writeFileSync(file, exported);
    await browser.execute(async () => (window as unknown as { modbus: ModbusApi }).modbus.command({ type: 'workspace.new' }));
    await rail('设备'); await openDialogFile(file); await click('导入设备模板');
    await browser.waitUntil(async () => (await snap()).workspace.templates.length === 1);
    expect((await snap()).workspace.templates[0]?.points[0]?.name).toBe('Edited point');
  });
  it('新建趋势组、添加信号、复制/删除组、实时选择加入趋势', async () => {
    await rail('趋势'); await click('新建趋势组'); await fill(field('名称'), 'Audit group'); await click('创建趋势组');
    await $('//*[@role="dialog"]//button[@role="checkbox"]').click();
    await $('//*[@role="dialog"]//button[contains(.,"添加") and not(@role="checkbox")]').click();
    await browser.waitUntil(async () => (await snap()).workspace.trendGroups.find(g => g.name === 'Audit group')?.signals.length === 1);
    await click('复制组'); await browser.waitUntil(async () => (await snap()).workspace.trendGroups.length === 3);
    await click('删除组'); await browser.waitUntil(async () => (await snap()).workspace.trendGroups.length === 2);
    await realtime(); await $('button[role="checkbox"]').click(); await click('加入趋势组');
    await browser.waitUntil(async () => (await snap()).workspace.trendGroups.some(g => g.signals.length >= 9));
  });

});
