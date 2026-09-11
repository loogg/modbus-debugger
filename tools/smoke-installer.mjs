/**
 * Installer / distributable smoke test (Squirrel.Windows).
 *
 * install (silent) -> launch installed exe -> assert window title -> kill ->
 * Update.exe --uninstall -> assert the install tree is gone.
 * Exits non-zero on any failed step; never leaves the app installed.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const APP_EXE = 'modbus-debugger.exe';
const EXPECTED_TITLE = 'Modbus';
const failures = [];

function log(msg) {
  console.log(`[smoke] ${msg}`);
}
function fail(msg) {
  failures.push(msg);
  console.error(`[smoke] FAIL ${msg}`);
}

function findSetup() {
  const root = path.resolve('out', 'make');
  if (!fs.existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (/Setup\.exe$/i.test(e.name)) return full;
    }
  }
  return null;
}

function findInstallDir() {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const candidates = [path.join(local, 'modbus-debugger'), path.join(local, 'Modbus Debugger')];
  for (const c of candidates) if (fs.existsSync(path.join(c, APP_EXE))) return c;
  // fall back to scanning %LocalAppData% one level deep
  for (const e of fs.readdirSync(local, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const full = path.join(local, e.name);
    if (fs.existsSync(path.join(full, APP_EXE))) return full;
  }
  return null;
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: false });
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        resolve({ code: null, timedOut: true });
      }
    }, timeoutMs);
    child.on('exit', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, timedOut: false });
    });
    child.on('error', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: -1, timedOut: false });
    });
  });
}

function processesWithName(name) {
  const res = spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-Process -Name '${name}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id | ForEach-Object { "$_ " }`],
  { encoding: 'utf8' });
  return (res.stdout ?? '').trim().split(/\s+/).filter(Boolean);
}

function windowTitle(pid) {
  const res = spawnSync('powershell', ['-NoProfile', '-Command',
    `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).MainWindowTitle`], { encoding: 'utf8' });
  return (res.stdout ?? '').trim();
}

async function waitFor(predicate, timeoutMs, stepMs = 500) {
  const start = Date.now();
  for (;;) {
    const v = await predicate();
    if (v) return v;
    if (Date.now() - start > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

async function main() {
  const setup = findSetup();
  if (!setup) { fail('no *Setup.exe under out/make (run `npm run make` first)'); return; }
  log(`setup: ${setup} (${(fs.statSync(setup).size / 1e6).toFixed(1)} MB)`);

  // 1) silent install
  log('installing (silent)...');
  const inst = await run(setup, [], 240000);
  if (inst.timedOut) fail('installer did not exit within 240s');
  else log(`installer exited with code ${inst.code}`);

  const dir = findInstallDir();
  if (!dir) { fail('install directory with modbus-debugger.exe not found under %LocalAppData%'); return; }
  log(`installed to ${dir}`);
  const versions = fs.readdirSync(dir).filter((n) => /^app-/.test(n));
  log(`version dirs: ${versions.join(', ') || '(none)'}`);
  if (!versions.length) fail('no app-<version> directory in the install tree');

  // 2) launch the installed app and verify a real window
  const exe = path.join(dir, APP_EXE);
  log('launching installed app...');
  const child = spawn(exe, [], { stdio: 'ignore', detached: true });
  child.unref();
  const pidWithTitle = await waitFor(async () => {
    for (const pid of processesWithName('modbus-debugger')) {
      const title = windowTitle(pid);
      if (title.includes(EXPECTED_TITLE)) return { pid, title };
    }
    return null;
  }, 40000);
  if (!pidWithTitle) {
    fail('installed app never showed a window with the expected title');
  } else {
    log(`window ok: pid=${pidWithTitle.pid} title="${pidWithTitle.title}"`);
  }

  // 3) stop it again
  for (const pid of processesWithName('modbus-debugger')) {
    spawnSync('taskkill', ['/PID', pid, '/F', '/T'], { stdio: 'ignore' });
  }
  await waitFor(async () => processesWithName('modbus-debugger').length === 0, 15000);
  if (processesWithName('modbus-debugger').length) fail('installed app did not stop');

  // 4) uninstall through Squirrel's Update.exe
  const update = path.join(dir, 'Update.exe');
  if (!fs.existsSync(update)) { fail('Update.exe missing from the install tree'); return; }
  log('uninstalling...');
  const un = await run(update, ['--uninstall', '-s'], 180000);
  if (un.timedOut) fail('uninstaller did not exit within 180s');
  else log(`uninstaller exited with code ${un.code}`);

  const gone = await waitFor(async () => !fs.existsSync(path.join(dir, APP_EXE)), 30000);
  if (!gone) fail(`install tree still present after uninstall: ${dir}`);
  else log('install tree removed');
}

main().then(() => {
  if (failures.length) {
    console.error(`[smoke] ${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log('[smoke] PASS: install -> launch -> verify -> uninstall');
  process.exit(0);
});
