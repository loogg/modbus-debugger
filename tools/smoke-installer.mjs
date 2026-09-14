/** Validate this version's actual release Setup without uninstalling an existing user installation. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { base, pkg, release, run, smokeApp, waitFor } from './smoke-app.mjs';

const setup = path.join(release, `${base}-Setup.exe`);
const install = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'modbus-debugger');
const exists = async file => fs.access(file).then(() => true, () => false);
await fs.access(setup);
assert(!await exists(path.join(install, 'modbus-debugger.exe')), 'Existing user installation found; refusing to replace or uninstall it');
assert(!await exists(path.join(install, `app-${pkg.version}`, 'modbus-debugger.exe')), 'Existing version installation found');

function stopInstalledProcesses() {
  const literal = install.replaceAll("'", "''");
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `$ErrorActionPreference='Stop'; Get-Process -Name 'modbus-debugger' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith('${literal}\\', [System.StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force`],
  { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
}

let attempted = false;
try {
  attempted = true;
  console.log(`[smoke] Installing ${setup}`);
  await run(setup, ['--silent'], 240000);
  const executable = path.join(install, `app-${pkg.version}`, 'modbus-debugger.exe');
  await waitFor(() => exists(executable));
  stopInstalledProcesses();
  await smokeApp(executable, 'Setup installed');
} finally {
  if (attempted && await exists(path.join(install, 'Update.exe'))) {
    stopInstalledProcesses();
    await run(path.join(install, 'Update.exe'), ['--uninstall', '-s']);
    await waitFor(async () => !await exists(path.join(install, 'modbus-debugger.exe')) &&
      !await exists(path.join(install, `app-${pkg.version}`, 'modbus-debugger.exe')), 30000);
    console.log('[smoke] Setup uninstall verified');
  }
}
console.log('[smoke] PASS: current release Setup install -> render -> IPC -> uninstall');
