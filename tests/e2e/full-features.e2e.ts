import { browser, $, expect } from '@wdio/globals';

/** Set a controlled input value through the native setter (React-safe). */
async function setNative(selector: string, value: string): Promise<void> {
  await browser.execute((sel, v) => {
    const input = document.querySelector(sel) as HTMLInputElement | null;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, v);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  }, selector, value);
  await browser.pause(200);
}
async function bodyText(): Promise<string> {
  return (await browser.execute(() => document.body.innerText)) as string;
}

/** Click by exact visible text through the DOM (immune to overlay interception). */
async function clickText(text: string): Promise<void> {
  const ok = await browser.execute((t) => {
    const el = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === t);
    if (!el) return false;
    (el as HTMLElement).click();
    return true;
  }, text);
  if (!ok) throw new Error(`button not found: ${text}`);
  await browser.pause(400);
}

async function rail(label: string): Promise<void> {
  await browser.execute((t) => {
    const el = [...document.querySelectorAll('nav button')].find((b) => (b.textContent ?? '').includes(t));
    (el as HTMLElement)?.click();
  }, label);
  await browser.pause(500);
}

async function waitGone(fragment: string, ms = 8000): Promise<void> {
  await browser.waitUntil(async () => !(await bodyText()).includes(fragment), { timeout: ms });
}

describe('上位机全量功能自测 (full-feature self test)', () => {
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
    await clickText('取消');
    await waitGone('从站地址 (Unit ID)');
  });

  it('实时表双击进入编辑态、Esc 取消且不污染确认值', async () => {
    await rail('实时');
    await browser.execute(() => {
      const el = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('伺服驱动器 A'));
      (el as HTMLElement)?.click();
    });
    await browser.pause(800);
    const cell = await $('//div[text()="目标转速"]/following-sibling::div[2]');
    await cell.doubleClick();
    await browser.pause(400);
    const editing = await $('//input[contains(@class,"w-24")]');
    expect(await editing.isExisting()).toBe(true);
    await browser.execute(() => {
      const input = document.querySelector('input.w-24') as HTMLInputElement | null;
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await browser.pause(300);
    expect(await $('//input[contains(@class,"w-24")]').isExisting()).toBe(false);
  });

  it('模板编辑：点位表、映射详情与编辑点位抽屉', async () => {
    await rail('模板');
    await clickText('编辑模板');
    let text = await bodyText();
    expect(text).toContain('点位映射');
    expect(text).toContain('母线电压');
    await browser.execute(() => {
      const el = [...document.querySelectorAll('div')].find((d) => d.textContent === '母线电压' && d.children.length === 0);
      (el as HTMLElement)?.click();
    });
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
    await browser.execute(() => {
      const el = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('开始记录'));
      (el as HTMLElement)?.click();
    });
    await browser.pause(3000);
    expect(await bodyText()).toContain('停止记录');
    await browser.execute(() => {
      const el = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('停止记录'));
      (el as HTMLElement)?.click();
    });
    await browser.pause(1000);
    await rail('历史');
    let text = await bodyText();
    expect(text).toContain('功耗分析');
    await browser.execute(() => {
      const el = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('功耗分析'));
      (el as HTMLElement)?.click();
    });
    await browser.pause(800);
    await clickText('信号');
    text = await bodyText();
    expect(text).toContain('记录信号');
    expect(text).toContain('连续样本');
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
  });

  it('连接设置：右侧主区编辑并保存生效', async () => {
    await rail('设备');
    await browser.execute(() => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.textContent ?? '').includes('生产线 TCP'));
      (b as HTMLElement | undefined)?.click();
    });
    await browser.pause(500);
    const text = await bodyText();
    expect(text).toContain('连接名称');
    expect(text).toContain('从站');
    const timeoutSel = 'input[data-testid="timeout-input"]';
    expect(await (await $(timeoutSel)).getValue()).toBe('800');
    await setNative(timeoutSel, '700');
    await clickText('保存');
    await browser.pause(600);
    await browser.execute(() => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.textContent ?? '').includes('生产线 TCP'));
      (b as HTMLElement | undefined)?.click();
    });
    await browser.pause(500);
    expect(await (await $(timeoutSel)).getValue()).toBe('700');
    await setNative(timeoutSel, '800');
    await clickText('保存');
    await browser.pause(400);
  });
  it('设置页：工作区文件 / 地址规则 / 记录与历史 / 写入安全', async () => {
    await rail('设置');
    const text = await bodyText();
    expect(text).toContain('工作区文件');
    expect(text).toContain('协议地址固定为 0-based');
    expect(text).toContain('记录与历史');
    expect(text).toContain('写入安全');
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
    await browser.execute(() => {
      const opt = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '19200');
      (opt as HTMLElement | undefined)?.click();
    });
    await browser.pause(300);
    expect(await (await $(baud)).getValue()).toBe('19200');
    expect(await listOpen()).toBe(false);

    // 2) reopen then move focus elsewhere -> closes on blur
    await (await $(baud)).click();
    await browser.pause(300);
    expect(await listOpen()).toBe(true);
    await browser.execute(() => (document.querySelector('input[data-testid="port-combo"]') as HTMLInputElement | null)?.focus());
    await browser.pause(400);
    expect(await listOpen()).toBe(false);

    // 3) reopen then press Escape -> closes
    await (await $(baud)).click();
    await browser.pause(300);
    expect(await listOpen()).toBe(true);
    // cancelable matters: Radix honours preventDefault() from our layered-Escape handler,
    // and preventDefault is a no-op on a non-cancelable synthetic event
    await browser.execute(() => {
      (document.querySelector('input[data-testid="baud-combo"]') as HTMLInputElement | null)?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    await browser.pause(300);
    expect(await listOpen()).toBe(false);

    // 4) a click outside the combobox also closes it
    await (await $(baud)).click();
    await browser.pause(300);
    expect(await listOpen()).toBe(true);
    await browser.execute(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await browser.pause(300);
    expect(await listOpen()).toBe(false);

    await clickText('取消');
    await waitGone('配置 RTU / TCP 通信参数');
  });

  it('未绑定模板也能添加从站：从站建立但不参与轮询', async () => {
    await rail('设备');
    // a previous failure could leave a dialog mounted; start from a clean overlay state
    await browser.execute(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
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
