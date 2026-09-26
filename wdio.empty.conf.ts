/** Opt-in first-use smoke against an isolated data root with no saved workspace. */
import fs from 'node:fs';
import path from 'node:path';
import { config as base } from './wdio.conf';

export const config = {
  ...base,
  specs: ['./tests/capacity/first-use.e2e.ts'],
  onPrepare: async () => {
    await base.onPrepare();
    const runDir = process.env.MODBUS_TEST_RUN_DIR;
    if (!runDir) throw new Error('First-use E2E requires isolated run directory');
    fs.rmSync(path.join(runDir, 'data', 'prefs.json'));
    process.env.MODBUS_E2E_WORKSPACE = '';
  },
};
