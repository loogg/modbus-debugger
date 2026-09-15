/** Exercise NSIS custom directory install, reinstall, data preservation and uninstall. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { base, release, run, smokeApp, waitFor } from './smoke-app.mjs';
import { createScratch, removeScratch } from './test-paths.mjs';

const existing = spawnSync('powershell.exe', ['-NoProfile', '-Command',
  "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Modbus Debugger*' } | Select-Object -ExpandProperty UninstallString"],
{ encoding: 'utf8', windowsHide: true });
if (existing.error) throw existing.error;
assert(!existing.stdout.trim(), 'Existing user installation found; refusing to replace it');

const setup = path.join(release, `${base}-Setup.exe`);
await fs.access(setup);
const scratch = createScratch('installer-');
const install = path.join(scratch, '自选路径 Custom install');
const executable = path.join(install, 'modbus-debugger.exe');
const uninstaller = path.join(install, 'Uninstall modbus-debugger.exe');
const exists = async file => fs.access(file).then(() => true, () => false);
let dataWritten = false;
try {
  await run(setup, ['/S', `/D=${install}`], 240000);
  await waitFor(() => exists(executable));
  await fs.access(uninstaller);
  await smokeApp(executable, 'NSIS custom directory');
  const sentinel = path.join(install, 'data', 'keep-on-upgrade.json');
  await fs.writeFile(sentinel, 'user data must survive');
  dataWritten = true;
  await run(setup, ['/S', `/D=${install}`], 240000);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'user data must survive');
  await smokeApp(executable, 'NSIS reinstall');
} finally {
  if (await exists(uninstaller)) {
    // Run the test uninstaller in place so run() waits for the actual uninstall, not its detached copy.
    await run(uninstaller, ['/S', `_?=${install}`]);
    await waitFor(async () => !await exists(executable), 30000);
    const sentinel = path.join(install, 'data', 'keep-on-upgrade.json');
    if (dataWritten) assert.equal(await fs.readFile(sentinel, 'utf8'), 'user data must survive');
    console.log('[smoke] NSIS uninstall removed application files and retained user data');
  }
  let cleanupWarning = false;
  await waitFor(() => {
    try { removeScratch(scratch); return true; }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error;
      if (!cleanupWarning) { console.warn('[smoke] Windows still holds the verified test directory; waiting for cleanup (bounded).'); cleanupWarning = true; }
      return false;
    }
  }, 60000);
}
console.log('[smoke] PASS: chosen directory -> launch -> reinstall -> preserved data -> uninstall');
