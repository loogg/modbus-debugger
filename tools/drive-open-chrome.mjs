import puppeteer from 'puppeteer-core';
import http from 'node:http';

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
  console.log('[LiveDrive] Connecting to user Chrome on 9222...');
  const browserWSEndpoint = await getWebSocketDebuggerUrl();
  const browser = await puppeteer.connect({
    browserWSEndpoint,
    defaultViewport: null,
  });

  const pages = await browser.pages();
  const page = pages.find((p) => p.url().includes('5173')) || pages[0] || (await browser.newPage());

  console.log('[LiveDrive] Active page URL:', page.url());
  if (!page.url().includes('http://localhost:5173/?transport=bridge')) {
    await page.goto('http://localhost:5173/?transport=bridge', { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 2000));
  }

  // 1. Check Devices Screen with Real Modbus Connection
  console.log('[LiveDrive] 1. Checking Devices Screen (Real Modbus TCP)...');
  await page.evaluate(() => {
    // Click devices rail button (index 0)
    const btns = Array.from(document.querySelectorAll('nav button'));
    btns[0]?.click();
  });
  await new Promise((r) => setTimeout(r, 1500));

  const devStatus = await page.evaluate(() => {
    return {
      title: document.title,
      textSnippet: document.body.innerText.slice(0, 300),
      hasOnline: document.body.innerText.includes('在线') || document.body.innerText.includes('1 个连接在线'),
    };
  });
  console.log('[LiveDrive] Devices Screen Status:', devStatus);

  // 2. Realtime Screen: View live Modbus values streaming
  console.log('[LiveDrive] 2. Switching to Realtime Screen...');
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('nav button'));
    btns[1]?.click(); // Realtime button
  });
  await new Promise((r) => setTimeout(r, 1500));

  // Select '伺服驱动器 A' -> '所有数据' or click first block
  await page.evaluate(() => {
    const allBtns = Array.from(document.querySelectorAll('button'));
    const allDataBtn = allBtns.find((b) => b.textContent && b.textContent.includes('全部'));
    if (allDataBtn) allDataBtn.click();
  });
  await new Promise((r) => setTimeout(r, 1500));

  const realtimeValues = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tr, table tr'));
    return rows.map((r) => r.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean);
  });
  console.log('[LiveDrive] Realtime Live Points in Browser:', realtimeValues.slice(0, 8));

  // 3. Trend Screen
  console.log('[LiveDrive] 3. Switching to Trend Screen...');
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('nav button'));
    btns[2]?.click(); // Trend button
  });
  await new Promise((r) => setTimeout(r, 2000));

  // 4. Comm Diagnostics Screen: Real packets from simulator
  console.log('[LiveDrive] 4. Switching to Comm Diagnostics Screen...');
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('nav button'));
    btns[4]?.click(); // Comm button
  });
  await new Promise((r) => setTimeout(r, 2000));

  const commPackets = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table tr, tbody tr'));
    return rows.map((r) => r.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean);
  });
  console.log('[LiveDrive] Comm Diagnostics Live Transactions:', commPackets.slice(0, 5));

  // 5. Templates Screen
  console.log('[LiveDrive] 5. Switching to Templates Screen...');
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('nav button'));
    btns[5]?.click(); // Templates button
  });
  await new Promise((r) => setTimeout(r, 2000));

  // 6. Return to Realtime so user can watch live Modbus values updating in their browser!
  console.log('[LiveDrive] 6. Returning to Realtime Screen for user live viewing...');
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('nav button'));
    btns[1]?.click();
  });
  await new Promise((r) => setTimeout(r, 1000));

  console.log('[LiveDrive] Complete! The user can now see real Modbus telemetry flowing live in Chrome.');
  browser.disconnect();
}

main().catch((err) => {
  console.error('[LiveDrive] Error:', err);
  process.exit(1);
});
