import { spawn } from 'node:child_process';
import path from 'node:path';
const exe = path.resolve('out', 'Modbus Debugger-win32-x64', 'modbus-debugger.exe');
const t0 = Date.now();
const app = spawn(exe, ['--remote-debugging-port=9222'], { stdio: 'ignore' });
for (;;) {
  await new Promise((r) => setTimeout(r, 100));
  try {
    const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
    if (list.length) { console.log('first page target after ms:', Date.now() - t0, list.length); break; }
  } catch { /* not up yet */ }
  if (Date.now() - t0 > 15000) { console.log('timeout'); break; }
}
app.kill();
process.exit(0);