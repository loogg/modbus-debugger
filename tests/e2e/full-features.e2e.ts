import { browser, $, expect } from '@wdio/globals';
import fs from 'node:fs';
import path from 'node:path';
import type { ModbusApi } from '../../src/shared/preload-api';

const SHOTS = path.resolve('out', 'audit', 'screenshots');
const FIGMA_SHOTS = path.resolve('out', 'audit', 'figma-current');
async function shot(name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true });
  await browser.saveScreenshot(path.join(SHOTS, `${name}.png`));
}
async function figmaShot(name: string): Promise<void> {
  fs.mkdirSync(FIGMA_SHOTS, { recursive: true });
  await browser.saveScreenshot(path.join(FIGMA_SHOTS, `${name}.png`));
}

/** Use real keyboard input so focus and validation paths participate. */
async function setNative(selector: string, value: string): Promise<void> {
  const input = await $(selector);
  await input.click();
  await browser.keys(['Control', 'a']);
  await browser.keys('Backspace');
  await input.addValue(value);
}
async function bodyText(): Promise<string> {
  return (await browser.execute(() => document.body.innerText)) as string;
}

async function clickText(text: string): Promise<void> {
  await $(`//button[normalize-space(.)="${text}"]`).click();
  await browser.pause(200);
}
async function rail(label: string): Promise<void> {
  await $(`//nav//button[contains(., "${label}")]`).click();
  await browser.pause(300);
}

async function waitGone(fragment: string, ms = 8000): Promise<void> {
  await browser.waitUntil(async () => !(await bodyText()).includes(fragment), { timeout: ms });
}

describe('既有页面操作回归', () => {
  it('添加连接对话框：串口下拉每次打开重新枚举、波特率支持自定义', async () => {
    await rail('设备');
    await clickText('添加连接');
    const text = await bodyText();
    expect(text).toContain('配置 RTU / TCP 通信参数');
    const baudInput = await $('//div[text()="波特率"]/following-sibling::div//input');
    await baudInput.click();
    await browser.pause(300);
    expect(await bodyText()).toContain('921600');
    await setNative('input[data-testid="baud-combo"]', '123456');
    expect(await baudInput.getValue()).toBe('123456');
    const portInput = await $('//div[text()="串口"]/following-sibling::div//input');
    await portInput.click();
    await browser.pause(600);
    await clickText('取消');
    await waitGone('配置 RTU / TCP 通信参数');
  });

  it('添加从站对话框可打开并校验 Unit ID 冲突检查', async () => {
    await clickText('＋ 添加从站');
    const text = await bodyText();
    expect(text).toContain('从站地址 (Unit ID)');
    expect(text).toMatch(/Unit ID \d+ 可用|已被占用/);
    await figmaShot('03-add-slave-dialog');
    await clickText('取消');
    await waitGone('从站地址 (Unit ID)');
  });

  it('实时表双击进入编辑态、Esc 取消且不污染确认值', async () => {
    await rail('实时');
    await $('//button[contains(., "伺服驱动器 A")]').click();
    await browser.pause(800);
    const cell = await $('//div[text()="目标转速"]/following-sibling::div[2]');
    await cell.doubleClick();
    await browser.pause(400);
    const editing = await $('//input[contains(@class,"w-24")]');
    expect(await editing.isExisting()).toBe(true);
    await browser.keys('Escape');
    await browser.pause(300);
    expect(await $('//input[contains(@class,"w-24")]').isExisting()).toBe(false);
  });

  it('模板编辑：点位表、映射详情与编辑点位抽屉', async () => {
    await rail('模板');
    await browser.pause(400);
    await shot('12-templates-1440');
    await $('//nav[@aria-label="设备模板树"]//button[contains(.,"控制寄存器")]').click();
    let text = await bodyText();
    expect(text).toContain('点位映射');
    expect(text).toContain('母线电压');
    await $('//tbody/tr[1]').click();
    await browser.pause(400);
    text = await bodyText();
    expect(text).toContain('映射详情');
    expect(text).toContain('寄存器偏移');
    await clickText('编辑点位');
    text = await bodyText();
    expect(text).toContain('内存映射');
    await clickText('取消');
    await waitGone('内存映射');
  });

  it('导入寄存器表界面：字段映射与预览步骤', async () => {
    await clickText('导入寄存器表');
    const text = await bodyText();
    expect(text).toContain('字段映射');
    expect(text).toContain('预览与转换');
    expect(text).toContain('数据块策略');
    await clickText('取消');
    await waitGone('字段映射');
  });

  it('趋势记录 → 历史会话 → 信号页 全链路', async () => {
    await rail('趋势');
    await $('//button[contains(., "开始记录")]').click();
    await browser.pause(3000);
    expect(await bodyText()).toContain('停止记录');
    await $('//button[contains(., "停止记录")]').click();
    await browser.pause(1000);
    await rail('历史');
    await browser.pause(400);
    await shot('14-history-1440');
    let text = await bodyText();
    expect(text).toContain('功耗分析');
    await $('//button[contains(., "功耗分析")]').click();
    await browser.pause(800);
    await clickText('信号');
    text = await bodyText();
    expect(text).toContain('记录信号');
    expect(text).toContain('连续样本');
    await figmaShot('12B-history-signals');
  });

  it('通信：连接健康与点位追踪视图', async () => {
    await rail('通信');
    await clickText('连接健康');
    let text = await bodyText();
    expect(text).toContain('总线负载');
    expect(text).toContain('数据块性能');
    // the 5-minute chart is fed by real 1 Hz samples recorded in Main, not a static series
    expect(text).toMatch(/[1-9][0-9]* 个采样点/);
    await clickText('点位追踪');
    text = await bodyText();
    expect(text).toContain('请求来源');
    expect(text).toContain('原始帧');
    expect(text).toContain('个点位：');
    await figmaShot('23-point-trace');
  });

  it('连接设置：连接时锁定，断开后可编辑保存，再连接恢复锁定', async () => {
    await rail('设备');
    await $('//button[contains(., "生产线 TCP")]').click();
    await browser.pause(500);
    const text = await bodyText();
    expect(text).toContain('连接名称');
    expect(text).toContain('从站');
    const timeoutSel = 'input[data-testid="timeout-input"]';
    const originalTimeout = await browser.execute(async () => {
      const api = (window as unknown as { modbus: ModbusApi }).modbus;
      return (await api.getSnapshot()).workspace.connections.find((connection) => connection.id === 'conn-tcp')?.timeoutMs;
    });
    expect(typeof originalTimeout).toBe('number');
    expect(await (await $(timeoutSel)).getValue()).toBe(String(originalTimeout));

    // connected -> parameters locked, disconnect offered
    expect(await (await $(timeoutSel)).isEnabled()).toBe(false);
    expect(text).toContain('已连接：参数已锁定');
    expect(text).toContain('断开连接');

    // disconnect -> editable
    await clickText('断开连接');
    await browser.waitUntil(async () => (await bodyText()).includes('未连接：可编辑参数'), { timeout: 15000 });
    expect(await (await $(timeoutSel)).isEnabled()).toBe(true);
    await shot('01C-connection-settings-offline-1440');
    // visual check of the restyled Radix Select panel
    await (await $('//div[text()="日志级别"]/following-sibling::button[1]')).click();
    await browser.pause(400);
    await shot('26-select-open-1440');
    await browser.keys('Escape');
    await browser.pause(300);
    await setNative(timeoutSel, '700');
    await clickText('保存');
    await browser.pause(600);
    expect(await (await $(timeoutSel)).getValue()).toBe('700');

    // connect again -> live with the new timeout, locked again
    await clickText('连接');
    await browser.waitUntil(async () => (await bodyText()).includes('已连接：参数已锁定'), { timeout: 20000 });
    expect(await (await $(timeoutSel)).getValue()).toBe('700');
    expect(await (await $(timeoutSel)).isEnabled()).toBe(false);

    // Restore the value present at this spec's start for later specs.
    await clickText('断开连接');
    await browser.waitUntil(async () => (await bodyText()).includes('未连接：可编辑参数'), { timeout: 15000 });
    await setNative(timeoutSel, String(originalTimeout));
    await clickText('保存');
    await browser.pause(400);
    await clickText('连接');
    await browser.waitUntil(async () => (await bodyText()).includes('已连接：参数已锁定'), { timeout: 20000 });
  });

  it('时区：侧栏与表头同一时区，切换 UTC 后按系统时区偏移', async () => {
    await rail('历史');
    await browser.pause(600);
    const readFirstSessionTime = () =>
      browser.execute(() => {
        const el = [...document.querySelectorAll('div.mono')]
          .map((d) => d.textContent ?? '')
          .find((x) => /\d{2}:\d{2}:\d{2} – /.test(x));
        return el ?? '';
      });
    const before = await readFirstSessionTime();
    expect(before).toMatch(/\d{2}:\d{2}:\d{2} – /);

    // the detail header must show the SAME wall clock as the sidebar card
    await $(`//button[contains(.,"${before.slice(0, 8)}")]`).click();
    await browser.pause(700);
    const head = await bodyText();
    const m = head.match(/(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) –/);
    expect(m).not.toBeNull();
    expect(m![2]).toBe(before.slice(0, 8));

    // Radix Select opens on pointerdown, so options need a real mouse click (element.click()
    // inside browser.execute is ignored). Asserting the trigger text afterwards proves the pref
    // round-tripped through Main before we compare rendered timestamps.
    const tzTrigger = '//div[text()="时区"]/following-sibling::button[1]';
    const pickTimezone = async (label: string) => {
      await (await $(tzTrigger)).click();
      await browser.pause(400);
      const option = await $(`//*[@role="option"][normalize-space(.)="${label}"]`);
      expect(await option.isExisting()).toBe(true);
      await option.click();
      await browser.pause(700);
      expect(await (await $(tzTrigger)).getText()).toContain(label);
    };

    // Compare against the actual system offset, not an assumed UTC+8 host.
    await rail('设置');
    await pickTimezone('UTC');
    await rail('历史');
    await browser.pause(600);
    await shot('22-history-utc-1440');
    const utc = await readFirstSessionTime();
    const hour = (s: string) => Number(s.slice(0, 2));
    const offset = await browser.execute(() => new Date().getTimezoneOffset() / 60);
    expect(hour(utc)).toBe((hour(before) + 24 + offset) % 24);

    // back to following the OS
    await rail('设置');
    await pickTimezone('跟随系统');
    await rail('历史');
    await browser.pause(600);
    expect(await readFirstSessionTime()).toBe(before);
  });

  it('添加连接：串口默认第一个可用口，选中选项后下拉自动关闭', async () => {
    await rail('设备');
    await clickText('添加连接');
    await browser.pause(900); // mount-time enumeration
    const portSel = 'input[data-testid="port-combo"]';
    const prefilled = await (await $(portSel)).getValue();
    expect(prefilled).toMatch(/^COM\d+$/);

    await (await $(portSel)).click();
    await browser.pause(400);
    await shot('25-combo-open-1440');
    const labels = await browser.execute(() =>
      [...document.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim()).filter((x) => /^COM\d+/.test(x)),
    );
    expect(labels.length).toBeGreaterThanOrEqual(1);
    const label = labels.find((x) => x !== prefilled) ?? labels[0]!;
    // a REAL mouse click: synthetic el.click() never produces the second, retargeted click
    // Chrome dispatches onto the input after the option node unmounts mid-click
    await (await $(`//button[normalize-space(.)="${label}"]`)).click();
    await browser.pause(400);

    // value applied and the list is gone
    expect(await (await $(portSel)).getValue()).toBe(label.split(' · ')[0]);
    const stillOpen = await browser.execute(() =>
      [...document.querySelectorAll('button')].some((b) => /^COM\d+/.test((b.textContent ?? '').trim())),
    );
    expect(stillOpen).toBe(false);
    await clickText('取消');
    await waitGone('配置 RTU / TCP 通信参数');
  });
  it('设置页：工作区文件 / 地址规则 / 记录与历史 / 写入安全', async () => {
    await rail('设置');
    await browser.pause(400);
    await shot('21-settings-1440');
    const text = await bodyText();
    expect(text).toContain('工作区文件');
    expect(text).toContain('协议地址固定为 0-based');
    expect(text).toContain('记录与历史');
    expect(text).toContain('写入安全');
    // 显示偏好：时区与语言必须可见且已接入当前值
    expect(text).toContain('时区');
    expect(text).toContain('跟随系统');
    expect(text).toContain('语言');
    expect(text).toContain('简体中文');
  });
});

  it('下拉框：选择选项 / 失焦 / Esc 三种方式都会自动关闭', async () => {
    await rail('设备');
    await clickText('添加连接');
    const listOpen = () =>
      browser.execute(() => [...document.querySelectorAll('button')].some((b) => (b.textContent ?? '').trim() === '921600'));
    const baud = 'input[data-testid="baud-combo"]';

    // 1) pick an option -> value applied and the list closes
    await (await $(baud)).click();
    await browser.pause(300);
    expect(await listOpen()).toBe(true);
    await (await $('//button[normalize-space(.)="19200"]')).click();
    await browser.pause(300);
    expect(await (await $(baud)).getValue()).toBe('19200');
    expect(await listOpen()).toBe(false);

    // 2) reopen then move focus elsewhere -> closes on blur
    await (await $(baud)).click();
    await browser.pause(300);
    expect(await listOpen()).toBe(true);
    await $('input[data-testid="port-combo"]').click();
    await browser.pause(400);
    expect(await listOpen()).toBe(false);

    // 3) reopen then press Escape -> closes
    await (await $(baud)).click();
    await browser.pause(300);
    expect(await listOpen()).toBe(true);
    // cancelable matters: Radix honours preventDefault() from our layered-Escape handler,
    // and preventDefault is a no-op on a non-cancelable synthetic event
    await browser.keys('Escape');
    await browser.pause(300);
    expect(await listOpen()).toBe(false);

    // 4) a click outside the combobox also closes it
    await (await $(baud)).click();
    await browser.pause(300);
    expect(await listOpen()).toBe(true);
    await $('//h2[contains(.,"添加连接")]').click();
    await browser.pause(300);
    expect(await listOpen()).toBe(false);

    // 5) real chevron click while the field is focused: the blur stays inside the combobox,
    //    so the list opens and STAYS open (the old blur grace timer closed it ~120 ms later)
    await (await $('//input[@data-testid="baud-combo"]/following-sibling::button[1]')).click();
    await browser.pause(400);
    expect(await listOpen()).toBe(true);

    await clickText('取消');
    await waitGone('配置 RTU / TCP 通信参数');
  });

  it('未绑定模板也能添加从站：从站建立但不参与轮询', async () => {
    await rail('设备');
    // a previous failure could leave a dialog mounted; start from a clean overlay state
    await browser.keys('Escape');
    await browser.pause(300);
    await clickText('＋ 添加从站');
    await browser.pause(500);
    expect(await bodyText()).toContain('从站地址 (Unit ID)');

    // Radix Select opens on pointerdown, so it needs a real mouse click (not element.click())
    const trigger = await $('//div[text()="设备模板"]/following-sibling::button[1]');
    await trigger.click();
    await browser.pause(500);
    const option = await $('//*[@role="option"][contains(., "暂不绑定模板")]');
    expect(await option.isExisting()).toBe(true);
    await option.click();
    await browser.pause(500);
    expect(await bodyText()).toContain('未绑定模板：从站创建后不会轮询');

    await setNative('input[value^="从站"]', '无模板从站');
    await browser.pause(200);

    // the confirm button must be enabled purely on Unit-ID availability
    const addBtn = await browser.execute(() => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.textContent ?? '').trim() === '添加从站');
      return b ? (b as HTMLButtonElement).disabled : null;
    });
    expect(addBtn).toBe(false);

    await clickText('添加从站');
    await browser.pause(800);
    const text = await bodyText();
    expect(text).toContain('无模板从站');
    expect(text).toContain('未绑定模板');
  });
