import { spawn } from 'node:child_process';
import path from 'node:path';
const exe = path.resolve('out', 'Modbus Debugger-win32-x64', 'modbus-debugger.exe');
const app = spawn(exe, ['--remote-debugging-port=9222'], { stdio: 'ignore' });
const drv = spawn(path.resolve('tools', 'e2e', 'driver', 'chromedriver.exe'), ['--port=9515'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 6000));
for (const caps of [
  { browserName: 'chrome', setWindowRect: true, 'goog:chromeOptions': { debuggerAddress: '127.0.0.1:9222' } },
  { browserName: 'chrome', 'wdio:enforceWebDriverClassic': true, 'goog:chromeOptions': { debuggerAddress: '127.0.0.1:9222' } },
]) {
  const res = await fetch('http://127.0.0.1:9515/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ capabilities: { alwaysMatch: caps, firstMatch: [{}] } }),
  });
  const body = await res.text();
  console.log('caps', JSON.stringify(caps).slice(0, 60), '->', res.status, body.slice(0, 160));
  if (res.status === 200) {
    const sid = JSON.parse(body).value.sessionId;
    await fetch(`http://127.0.0.1:9515/session/${sid}`, { method: 'DELETE' });
  }
}
app.kill();
drv.kill();
process.exit(0);