import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const setup = path.resolve('out', 'make', 'squirrel.windows', 'x64', 'Modbus Debugger-0.1.0 Setup.exe');
const installRoot = path.join(os.homedir(), 'AppData', 'Local', 'modbus-debugger');
console.log('running installer...');
spawn(setup, [], { stdio: 'ignore', detached: true });
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  if (fs.existsSync(installRoot)) break;
}
console.log('install dir exists:', fs.existsSync(installRoot));
const exe = path.join(installRoot, 'modbus-debugger.exe');
const alt = path.join(installRoot, 'modbus-debugger.exe');
const appExe = fs.existsSync(exe) ? exe : alt;
console.log('installed exe:', fs.existsSync(appExe) ? appExe : 'MISSING');
await new Promise((r) => setTimeout(r, 5000));
// kill auto-launched instance, then relaunch with debug port
try { execSync('taskkill /IM modbus-debugger.exe /F', { stdio: 'ignore' }); } catch { /* not running */ }
await new Promise((r) => setTimeout(r, 2000));
const app = spawn(appExe, ['--remote-debugging-port=9222'], {
  stdio: 'ignore',
  env: { ...process.env, MODBUS_E2E_WORKSPACE: path.resolve('tools', 'e2e', 'demo.workspace.json') },
});
let ok = false;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 500));
  try {
    const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
    if (list.length) { ok = true; console.log('installed app page target:', list[0].title); break; }
  } catch { /* retry */ }
}
console.log('SMOKE RESULT:', ok ? 'PASS' : 'FAIL');
app.kill();
await new Promise((r) => setTimeout(r, 1500));
try { execSync('taskkill /IM modbus-debugger.exe /F', { stdio: 'ignore' }); } catch { /* ignore */ }
const update = path.join(installRoot, 'Update.exe');
if (fs.existsSync(update)) {
  spawn(update, ['--uninstall'], { stdio: 'ignore', detached: true });
  await new Promise((r) => setTimeout(r, 12000));
  console.log('uninstalled, dir gone:', !fs.existsSync(installRoot));
}
process.exit(0);