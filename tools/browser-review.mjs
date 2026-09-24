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

  // --- Step 2: Mock Mode - Default ---
  console.log('\n--- Step 2: Mock Mode - Default ---');
  await page.goto('http://localhost:5173/?transport=mock&fixture=default', { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 1500));
  const mockDefaultText = await page.evaluate(() => document.body.innerText);
  console.log('[Mock:Default] Review Badge present:', mockDefaultText.includes('Mock (default)'));
  console.log('[Mock:Default] Shows smart meter:', mockDefaultText.includes('智能三相多功能电表') || mockDefaultText.includes('进线电表'));
  await page.screenshot({ path: path.join(outDir, '05_mock_default.png') });
  console.log('[Mock:Default] Saved screenshot: 05_mock_default.png');

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
