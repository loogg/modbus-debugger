import puppeteer from 'puppeteer-core';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '../out/browser-review');
fs.mkdirSync(outDir, { recursive: true });

function getWebSocketDebuggerUrl() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json/version', (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.webSocketDebuggerUrl);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('[FullReview] Connecting to visible Chrome on 9222...');
  const browserWSEndpoint = await getWebSocketDebuggerUrl();
  const browser = await puppeteer.connect({
    browserWSEndpoint,
    defaultViewport: null,
  });

  const pages = await browser.pages();
  const page = pages.find((p) => p.url().includes('5173')) || pages[0] || (await browser.newPage());

  console.log('[FullReview] Current Page URL:', page.url());
  await page.goto('http://localhost:5173/?transport=bridge', { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 2000));

  // --- Step 1: Devices Screen & Real Modbus Topology ---
  console.log('\n[FullReview] --- Step 1: Devices Screen (Real Modbus Topology) ---');
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('nav button'));
    btns[0]?.click(); // Devices
  });
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(outDir, 'live_01_devices_online.png') });
  console.log('Saved live_01_devices_online.png');

  // --- Step 2: Realtime Screen with Live Data ---
  console.log('\n[FullReview] --- Step 2: Realtime Screen (Live Polling & Confirmed Values) ---');
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('nav button'));
    btns[1]?.click(); // Realtime
  });
  await new Promise((r) => setTimeout(r, 1500));

  // Click on slave or block in sidebar to reveal table
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('aside button, div button'));
    const slaveBtn = buttons.find((b) => b.textContent && b.textContent.includes('伺服驱动器 A'));
    if (slaveBtn) slaveBtn.click();
    const ctrlBlockBtn = buttons.find((b) => b.textContent && b.textContent.includes('控制寄存器'));
    if (ctrlBlockBtn) ctrlBlockBtn.click();
  });
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(outDir, 'live_02_realtime_confirmed_values.png') });
  console.log('Saved live_02_realtime_confirmed_values.png');

  // --- Step 3: Trend Screen with Live Chart ---
  console.log('\n[FullReview] --- Step 3: Trend Screen & Live Sampling ---');
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('nav button'));
    btns[2]?.click(); // Trend
  });
  await new Promise((r) => setTimeout(r, 1500));

  // Click '图表' tab to show chart
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const chartTab = buttons.find((b) => b.textContent && b.textContent.trim() === '图表');
    if (chartTab) chartTab.click();
  });
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(outDir, 'live_03_trend_chart.png') });
  console.log('Saved live_03_trend_chart.png');

  // --- Step 4: Comm Diagnostics Screen (Real Modbus Packets) ---
  console.log('\n[FullReview] --- Step 4: Comm Diagnostics (Real Modbus Packets) ---');
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('nav button'));
    btns[4]?.click(); // Comm
  });
  await new Promise((r) => setTimeout(r, 2000));
  await page.screenshot({ path: path.join(outDir, 'live_04_comm_transactions.png') });
  console.log('Saved live_04_comm_transactions.png');

  // View Connection Health
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const healthBtn = buttons.find((b) => b.textContent && b.textContent.includes('连接健康'));
    if (healthBtn) healthBtn.click();
  });
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(outDir, 'live_05_comm_health.png') });
  console.log('Saved live_05_comm_health.png');

  // --- Step 5: Templates Screen ---
  console.log('\n[FullReview] --- Step 5: Templates Screen ---');
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('nav button'));
    btns[5]?.click(); // Templates
  });
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(outDir, 'live_06_templates.png') });
  console.log('Saved live_06_templates.png');

  // --- Step 6: Add Connection Modal Dialog ---
  console.log('\n[FullReview] --- Step 6: Modal Dialog ---');
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('nav button'));
    btns[0]?.click(); // Back to Devices
  });
  await new Promise((r) => setTimeout(r, 1000));

  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const addBtn = buttons.find((b) => b.textContent && b.textContent.includes('添加连接'));
    if (addBtn) addBtn.click();
  });
  await new Promise((r) => setTimeout(r, 1000));
  await page.screenshot({ path: path.join(outDir, 'live_07_add_connection_dialog.png') });
  console.log('Saved live_07_add_connection_dialog.png');

  // Close dialog
  await page.keyboard.press('Escape');
  await new Promise((r) => setTimeout(r, 500));

  // --- Step 7: DevReviewIndicator Menu ---
  console.log('\n[FullReview] --- Step 7: DevReviewIndicator Menu ---');
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const switchBtn = buttons.find((b) => b.textContent && b.textContent.includes('切换 ▼'));
    if (switchBtn) switchBtn.click();
  });
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: path.join(outDir, 'live_08_review_indicator_menu.png') });
  console.log('Saved live_08_review_indicator_menu.png');

  console.log('\n[FullReview] All live screenshots captured successfully from visible Chrome!');
  browser.disconnect();
}

main().catch((err) => {
  console.error('[FullReview] Error:', err);
  process.exit(1);
});
