import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '../out/browser-review');
fs.mkdirSync(outDir, { recursive: true });

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function review() {
  console.log('[BrowserReview] Launching Chrome:', chromePath);
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
      console.error('[Browser Console Error]:', msg.text());
    }
  });

  page.on('pageerror', (err) => {
    consoleErrors.push(err.message);
    console.error('[Browser Page Error]:', err.message);
  });

  // --- Step 1: Real Dev Bridge Review ---
  console.log('\n--- Step 1: Real Dev Bridge Review ---');
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto('http://localhost:5173/?transport=bridge', { waitUntil: 'networkidle0' });

  // Wait for review badge
  await new Promise((r) => setTimeout(r, 2000)); // Allow delta/state update

  const bodyText = await page.evaluate(() => document.body.innerText);
  console.log('[DevBridge] Page loaded. Title:', await page.title());
  console.log('[DevBridge] Review Badge present:', bodyText.includes('Bridge'));
  console.log('[DevBridge] Connected status:', bodyText.includes('已连接'));

  await page.screenshot({ path: path.join(outDir, '01_bridge_standard_1440x900.png') });
  console.log('[DevBridge] Saved screenshot: 01_bridge_standard_1440x900.png');

  // Test responsive compact size (1200x800)
  await page.setViewport({ width: 1200, height: 800 });
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: path.join(outDir, '02_bridge_compact_1200x800.png') });
  console.log('[DevBridge] Saved screenshot: 02_bridge_compact_1200x800.png');

  // Test responsive minimum size (1024x680)
  await page.setViewport({ width: 1024, height: 680 });
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: path.join(outDir, '03_bridge_minimum_1024x680.png') });
  console.log('[DevBridge] Saved screenshot: 03_bridge_minimum_1024x680.png');

  // Navigate to 'templates' and test real creation via Bridge
  await page.setViewport({ width: 1440, height: 900 });
  const railButtons = await page.$$('nav button, aside button');
  if (railButtons.length > 5) {
    await railButtons[5].click();
    await new Promise((r) => setTimeout(r, 600));

    // Click "新建设备模板" button
    const buttons = await page.$$('button');
    for (const b of buttons) {
      const text = await page.evaluate((el) => el.textContent, b);
      if (text && text.includes('新建设备模板')) {
        await b.click();
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 800));
    await page.screenshot({ path: path.join(outDir, '04_bridge_templates.png') });
    console.log('[DevBridge] Created template. Saved screenshot: 04_bridge_templates.png');

    const afterCreateText = await page.evaluate(() => document.body.innerText);
    console.log('[DevBridge] Template created in real backend:', afterCreateText.includes('未命名模板') || afterCreateText.includes('模板名称'));
  }

  // Navigate across other modules
  // Click 'realtime' (button 1)
  if (railButtons.length > 1) {
    await railButtons[1].click();
    await new Promise((r) => setTimeout(r, 600));
    await page.screenshot({ path: path.join(outDir, '08_bridge_realtime.png') });
    console.log('[DevBridge] Saved screenshot: 08_bridge_realtime.png');
  }

  // Click 'trend' (button 2)
  if (railButtons.length > 2) {
    await railButtons[2].click();
    await new Promise((r) => setTimeout(r, 600));
    await page.screenshot({ path: path.join(outDir, '09_bridge_trend.png') });
    console.log('[DevBridge] Saved screenshot: 09_bridge_trend.png');
  }

  // Click 'comm' (button 4)
  if (railButtons.length > 4) {
    await railButtons[4].click();
    await new Promise((r) => setTimeout(r, 600));
    await page.screenshot({ path: path.join(outDir, '10_bridge_comm.png') });
    console.log('[DevBridge] Saved screenshot: 10_bridge_comm.png');
  }

  // Click 'devices' (button 0) and open '添加连接' dialog
  if (railButtons.length > 0) {
    await railButtons[0].click();
    await new Promise((r) => setTimeout(r, 400));
    const addConnBtn = await page.$('button');
    const allButtons = await page.$$('button');
    for (const b of allButtons) {
      const txt = await page.evaluate((el) => el.textContent, b);
      if (txt && txt.includes('添加连接')) {
        await b.click();
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
    await page.screenshot({ path: path.join(outDir, '11_bridge_add_connection_dialog.png') });
    console.log('[DevBridge] Saved screenshot: 11_bridge_add_connection_dialog.png');

    // Close dialog with Escape or cancel
    await page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 300));
  }

  // --- Step 2: Mock Mode - Default ---
  console.log('\n--- Step 2: Mock Mode - Default ---');
  await page.goto('http://localhost:5173/?transport=mock&fixture=default', { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 1500));
  const mockDefaultText = await page.evaluate(() => document.body.innerText);
  console.log('[Mock:Default] Review Badge present:', mockDefaultText.includes('Mock (default)'));
  console.log('[Mock:Default] Shows smart meter:', mockDefaultText.includes('智能三相多功能电表') || mockDefaultText.includes('进线电表'));
  await page.screenshot({ path: path.join(outDir, '05_mock_default.png') });
  console.log('[Mock:Default] Saved screenshot: 05_mock_default.png');

  // Navigate to realtime in Mock mode to observe live fluctuating numbers
  const mockRailButtons = await page.$$('nav button, aside button');
  if (mockRailButtons.length > 1) {
    await mockRailButtons[1].click();
    await new Promise((r) => setTimeout(r, 1500));
    await page.screenshot({ path: path.join(outDir, '12_mock_realtime_live_data.png') });
    console.log('[Mock:Default] Saved screenshot: 12_mock_realtime_live_data.png');
  }

  // --- Step 3: Mock Mode - Empty ---
  console.log('\n--- Step 3: Mock Mode - Empty ---');
  await page.goto('http://localhost:5173/?transport=mock&fixture=empty', { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: path.join(outDir, '06_mock_empty.png') });
  console.log('[Mock:Empty] Saved screenshot: 06_mock_empty.png');

  // --- Step 4: Mock Mode - Large Data ---
  console.log('\n--- Step 4: Mock Mode - Large Data ---');
  await page.goto('http://localhost:5173/?transport=mock&fixture=large-data', { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 1200));
  const largeDataText = await page.evaluate(() => document.body.innerText);
  console.log('[Mock:LargeData] Shows 300点高密度采集器:', largeDataText.includes('300点高密度采集器') || largeDataText.includes('高密度测试从站'));
  await page.screenshot({ path: path.join(outDir, '07_mock_large_data.png') });
  console.log('[Mock:LargeData] Saved screenshot: 07_mock_large_data.png');

  // --- Step 5: Mock Mode - Error and Timeout ---
  console.log('\n--- Step 5: Mock Mode - Error and Timeout ---');
  await page.goto('http://localhost:5173/?transport=mock&fixture=error', { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: path.join(outDir, '13_mock_error_state.png') });
  console.log('[Mock:Error] Saved screenshot: 13_mock_error_state.png');

  await page.goto('http://localhost:5173/?transport=mock&fixture=timeout', { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: path.join(outDir, '14_mock_timeout_state.png') });
  console.log('[Mock:Timeout] Saved screenshot: 14_mock_timeout_state.png');

  await browser.close();

  console.log('\n--- Browser Review Results Summary ---');
  console.log(`Console Errors count: ${consoleErrors.length}`);
  if (consoleErrors.length > 0) {
    console.log('Errors:', consoleErrors);
  } else {
    console.log('✓ All modes rendered cleanly without any uncaught browser errors!');
  }
}

review().catch((err) => {
  console.error('[BrowserReview] Fatal:', err);
  process.exit(1);
});
