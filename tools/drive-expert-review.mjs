import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const outDir = path.resolve(__dirname, '../out/browser-review/expert');
  fs.mkdirSync(outDir, { recursive: true });

  console.log('[ExpertReview] Launching visible Chrome browser on desktop...');
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    defaultViewport: { width: 1440, height: 900 },
    args: ['--window-size=1440,900', '--no-first-run', '--no-default-browser-check'],
  });

  const page = (await browser.pages())[0] || (await browser.newPage());
  await page.setViewport({ width: 1440, height: 900 });

  console.log('[ExpertReview] Navigating to http://localhost:5173/?transport=bridge ...');
  await page.goto('http://localhost:5173/?transport=bridge', { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 2000));

  // --- Step 1: Devices Screen (Dual TCP + RTU COM1 Inspection) ---
  console.log('\n=== Step 1: Devices Screen Inspection ===');
  await page.evaluate(() => {
    const navBtns = Array.from(document.querySelectorAll('nav button'));
    navBtns[0]?.click(); // Devices
  });
  await new Promise((r) => setTimeout(r, 1000));
  await page.screenshot({ path: path.join(outDir, '01_devices_dual_overview.png') });

  // Connect to RTU COM1 if not online
  console.log('[ExpertReview] Connecting RTU (COM1) if needed...');
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const connectBtns = buttons.filter((b) => b.innerText.trim() === '连接');
    connectBtns.forEach((b) => b.click());
  });
  await new Promise((r) => setTimeout(r, 2500));
  await page.screenshot({ path: path.join(outDir, '02_devices_both_online.png') });

  // --- Step 2: Temporary Read on RTU COM1 ---
  console.log('\n=== Step 2: Temporary Read Inspection on RTU COM1 ===');
  await page.evaluate(() => {
    const tempBtns = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.includes('临时读取') || b.innerText.includes('临时调试'));
    if (tempBtns.length > 0) {
      tempBtns[tempBtns.length - 1].click(); // Click RTU's temp read
    }
  });
  await new Promise((r) => setTimeout(r, 1200));
  await page.screenshot({ path: path.join(outDir, '03_devices_temp_read_panel.png') });

  // Execute a temporary read
  console.log('[ExpertReview] Executing Temp Read...');
  await page.evaluate(() => {
    const readBtn = Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === '执行临时读取' || b.innerText.includes('读取'));
    readBtn?.click();
  });
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(outDir, '04_devices_temp_read_result.png') });

  // --- Step 3: Bus Scanner on RTU COM1 ---
  console.log('\n=== Step 3: Scanner Inspection on RTU COM1 ===');
  await page.evaluate(() => {
    const scanBtns = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === '扫描从站' || (b.innerText.includes('扫描') && !b.innerText.includes('停止')));
    if (scanBtns.length > 0) {
      scanBtns[scanBtns.length - 1].click(); // Click RTU's scan
    }
  });
  await new Promise((r) => setTimeout(r, 1200));
  await page.screenshot({ path: path.join(outDir, '05_devices_scan_panel.png') });

  // Start scanning
  console.log('[ExpertReview] Triggering unit scan...');
  await page.evaluate(() => {
    const startScanBtn = Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === '开始扫描');
    startScanBtn?.click();
  });
  await new Promise((r) => setTimeout(r, 2500));
  await page.screenshot({ path: path.join(outDir, '06_devices_scan_results.png') });

  // --- Step 4: Realtime Screen Inspection (TCP & RTU Data) ---
  console.log('\n=== Step 4: Realtime Screen Inspection ===');
  await page.evaluate(() => {
    const navBtns = Array.from(document.querySelectorAll('nav button'));
    navBtns[1]?.click(); // Realtime
  });
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(outDir, '07_realtime_servo_tcp.png') });

  // Switch to RTU slave in Realtime sidebar
  console.log('[ExpertReview] Switching to RTU slave (流量变送器)...');
  await page.evaluate(() => {
    const slaveCards = Array.from(document.querySelectorAll('div, button')).filter((el) => el.innerText && el.innerText.includes('流量变送器'));
    slaveCards[0]?.click();
  });
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(outDir, '08_realtime_flowmeter_rtu.png') });

  // Check Point Write Interaction on Realtime Table
  console.log('[ExpertReview] Testing Point Write Modal on Realtime Table...');
  await page.evaluate(() => {
    const writeBtns = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === '写入' || b.innerText.trim() === '修改');
    if (writeBtns.length > 0) {
      writeBtns[0].click();
    }
  });
  await new Promise((r) => setTimeout(r, 1200));
  await page.screenshot({ path: path.join(outDir, '09_realtime_point_write_dialog.png') });

  // Close dialog if open
  await page.evaluate(() => {
    const cancelBtns = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === '取消');
    cancelBtns[cancelBtns.length - 1]?.click();
  });
  await new Promise((r) => setTimeout(r, 500));

  // --- Step 5: Communication Diagnostics & Sniffer Screen ---
  console.log('\n=== Step 5: Diagnostics & Sniffer Screen Inspection ===');
  await page.evaluate(() => {
    const navBtns = Array.from(document.querySelectorAll('nav button'));
    navBtns[4]?.click(); // Comm
  });
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(outDir, '10_diagnostics_overview.png') });

  // Test Pause / Resume controls
  console.log('[ExpertReview] Testing Comm diagnostics pause/resume...');
  await page.evaluate(() => {
    const pauseBtn = Array.from(document.querySelectorAll('button')).find((b) => b.innerText.includes('暂停') || b.innerText.includes('停止跟踪'));
    pauseBtn?.click();
  });
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: path.join(outDir, '11_diagnostics_paused.png') });

  await page.evaluate(() => {
    const resumeBtn = Array.from(document.querySelectorAll('button')).find((b) => b.innerText.includes('恢复') || b.innerText.includes('开始跟踪'));
    resumeBtn?.click();
  });
  await new Promise((r) => setTimeout(r, 500));

  // --- Step 6: Trend Screen & Live Recording ---
  console.log('\n=== Step 6: Trend & Live Recording Inspection ===');
  await page.evaluate(() => {
    const navBtns = Array.from(document.querySelectorAll('nav button'));
    navBtns[2]?.click(); // Trend
  });
  await new Promise((r) => setTimeout(r, 2000));
  await page.screenshot({ path: path.join(outDir, '12_trend_chart_view.png') });

  // Click start recording button in Trend screen
  console.log('[ExpertReview] Triggering live session recording...');
  await page.evaluate(() => {
    const startRecBtn = Array.from(document.querySelectorAll('button')).find((b) => b.innerText.includes('开始记录') || b.innerText.includes('录制'));
    startRecBtn?.click();
  });
  await new Promise((r) => setTimeout(r, 3500)); // record for 3.5 seconds
  await page.screenshot({ path: path.join(outDir, '13_trend_recording_active.png') });

  // Stop recording
  console.log('[ExpertReview] Stopping live session recording...');
  await page.evaluate(() => {
    const stopRecBtn = Array.from(document.querySelectorAll('button')).find((b) => b.innerText.includes('停止记录') || b.innerText.includes('停止'));
    stopRecBtn?.click();
  });
  await new Promise((r) => setTimeout(r, 1200));

  // --- Step 7: History Screen Inspection ---
  console.log('\n=== Step 7: History Sessions Inspection ===');
  await page.evaluate(() => {
    const navBtns = Array.from(document.querySelectorAll('nav button'));
    navBtns[3]?.click(); // History
  });
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(outDir, '14_history_sessions_list.png') });

  // --- Step 8: Templates Screen Inspection ---
  console.log('\n=== Step 8: Templates Screen Inspection ===');
  await page.evaluate(() => {
    const navBtns = Array.from(document.querySelectorAll('nav button'));
    navBtns[5]?.click(); // Templates
  });
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(outDir, '15_templates_library.png') });

  // --- Step 9: Settings & About Screens ---
  console.log('\n=== Step 9: Settings & About Inspection ===');
  await page.evaluate(() => {
    const navBtns = Array.from(document.querySelectorAll('nav button'));
    navBtns[6]?.click(); // Settings
  });
  await new Promise((r) => setTimeout(r, 1000));
  await page.screenshot({ path: path.join(outDir, '16_settings_panel.png') });

  await page.evaluate(() => {
    const navBtns = Array.from(document.querySelectorAll('nav button'));
    navBtns[7]?.click(); // About
  });
  await new Promise((r) => setTimeout(r, 1000));
  await page.screenshot({ path: path.join(outDir, '17_about_panel.png') });

  // Return to Realtime screen for final monitoring view
  await page.evaluate(() => {
    const navBtns = Array.from(document.querySelectorAll('nav button'));
    navBtns[1]?.click(); // Realtime
  });
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(outDir, '18_realtime_final_converged.png') });

  console.log('\n[ExpertReview] Completed all 18 review steps! Keeping browser open for observation...');
  // Keep browser alive for 3 seconds then close
  await new Promise((r) => setTimeout(r, 3000));
  await browser.close();
  console.log('[ExpertReview] Browser closed cleanly. Review finished.');
}

main().catch((err) => {
  console.error('[ExpertReview] Failed:', err);
  process.exit(1);
});
