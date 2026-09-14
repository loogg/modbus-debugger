import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { createScratch, removeScratch, setupTestEnvironment } from './test-paths.mjs';
export { removeScratch } from './test-paths.mjs';

setupTestEnvironment();

export const root = path.resolve(import.meta.dirname, '..');
export const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
export const arch = process.env.RELEASE_ARCH || process.arch;
assert(['x64', 'arm64', 'ia32'].includes(arch), 'Unsupported release architecture');
export const base = `${pkg.name}-${pkg.version}-win-${arch}`;
export const release = path.join(root, 'release');
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function waitFor(predicate, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(300);
  }
  throw new Error(`Timed out after ${timeoutMs} ms`);
}

export async function run(executable, args, timeout = 180000, stdio = 'ignore') {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio, windowsHide: true });
    const timer = setTimeout(() => {
      if (child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      reject(new Error(`Timed out: ${executable}`));
    }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${executable} exited ${code}`));
    });
  });
}

export async function smokeApp(executable, label, options = {}) {
  const scratch = createScratch('smoke-profile-');
  const fixture = JSON.parse(await fs.readFile(path.join(root, 'tools', 'e2e', 'demo.workspace.json'), 'utf8'));
  const workspace = path.join(scratch, 'smoke.workspace.json');
  await fs.writeFile(workspace, JSON.stringify({
    ...fixture, name: 'Release smoke', connections: [], slaves: [], templates: [], trendGroups: [],
    layout: { module: 'devices', selection: {} },
  }));
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const child = spawn(executable, [`--remote-debugging-port=${port}`, ...(options.dataRoot ? [`--data-dir=${options.dataRoot}`] : [])], {
    cwd: path.dirname(executable), stdio: 'ignore', windowsHide: true,
    env: { ...process.env, MODBUS_DATA_DIR: '', MODBUS_E2E: '0', MODBUS_E2E_WORKSPACE: workspace },
  });
  let spawnError;
  child.once('error', error => { spawnError = error; });
  let browser;
  try {
    await waitFor(async () => {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`${label} exited before rendering: ${child.exitCode}`);
      try { return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })).ok; }
      catch { return false; }
    }, 90000);
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
    const page = await waitFor(async () => (await browser.pages()).find(p => p.url().startsWith('app://')));
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.waitForFunction(() => Boolean(window.modbus) && document.body.innerText.includes('设备'), { timeout: 30000 });
    const state = await page.evaluate(async () => ({
      versions: await window.modbus.versions(),
      snapshot: await window.modbus.getSnapshot(),
      serial: await window.modbus.command({ type: 'serial.list' }),
      text: document.body.innerText,
    }));
    assert.equal(state.versions.app, pkg.version, `${label}: wrong bundled version`);
    assert.equal(state.snapshot.workspace.name, 'Release smoke', `${label}: isolated workspace not loaded`);
    assert.equal(state.serial.ok, true, `${label}: serialport native module failed`);
    for (const navigation of ['设备', '实时', '趋势', '历史', '通信', '模板', '设置']) assert(state.text.includes(navigation));
    assert.deepEqual(errors, [], `${label}: renderer errors`);
    const dataRoot = options.dataRoot || path.dirname(executable);
    assert.equal(path.normalize(state.snapshot.historyDbPath), path.join(dataRoot, 'data', 'history.db'));
    const log = await fs.readFile(path.join(dataRoot, 'logs', 'main.log'), 'utf8');
    const lines = log.split('\n').filter(line => line.includes('runtime-paths '));
    const actualPaths = JSON.parse(lines.at(-1).slice(lines.at(-1).indexOf('runtime-paths ') + 'runtime-paths '.length));
    assert.equal(actualPaths.userData, path.join(dataRoot, 'data'));
    assert.equal(actualPaths.sessionData, path.join(dataRoot, 'cache'));
    assert.equal(actualPaths.electronTemp, path.join(dataRoot, 'temp'));
    if (options.portable) assert(actualPaths.executable.startsWith(path.join(dataRoot, 'temp') + path.sep), 'Portable extracted outside its own temp directory');
    if (options.screenshot) await page.screenshot({ path: options.screenshot });
    if (options.screenshotDir) {
      await fs.mkdir(options.screenshotDir, { recursive: true });
      for (const [width, height] of [[1440, 960], [1280, 960], [1279, 960], [1024, 680]]) {
        await page.setViewport({ width, height, deviceScaleFactor: 1 });
        await delay(200);
        const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
        assert.equal(layout.width, width);
        assert(layout.scrollWidth <= width, `${label}: document overflows at ${width}px`);
        await page.screenshot({ path: path.join(options.screenshotDir, `release-${width}x${height}.png`) });
      }
    }
    console.log(`[smoke] ${label}: v${state.versions.app}, renderer + IPC + serialport + history initialized`);
    await browser.close();
    browser = null;
    await waitFor(() => child.exitCode !== null, 30000);
    assert.equal(child.exitCode, 0, `${label}: nonzero exit`);
    if (options.portable) {
      await waitFor(async () => fs.access(actualPaths.executable).then(() => false, () => true), 10000);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (child.exitCode === null && child.pid) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      await delay(700);
    }
    await removeScratch(scratch);
  }
}
