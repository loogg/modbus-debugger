import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';

let sim: ChildProcess | null = null;
let workspaceCopyDir: string | null = null;
const SIM_PORT = 50520;
const FIXTURE = path.resolve('tools', 'e2e', 'demo.workspace.json');

/**
 * The app autosaves whatever workspace it loaded, so the committed fixture must never be
 * handed to it directly: each run gets a throw-away copy in a temp directory. Without this
 * a single failing run silently rewrites the fixture and every later run starts from a
 * different world.
 */
function stageWorkspace(): string {
  workspaceCopyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbe2e-'));
  const dest = path.join(workspaceCopyDir, 'demo.workspace.json');
  fs.copyFileSync(FIXTURE, dest);
  return dest;
}

function waitForPort(port: number, ms = 30000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - start > ms) reject(new Error(`port ${port} never opened`));
        else setTimeout(tryOnce, 300);
      });
    };
    tryOnce();
  });
}

function seedPrefs(workspacePath: string): void {
  for (const dirName of ['modbus-debugger', 'Modbus Debugger']) {
    const prefsDir = path.join(os.homedir(), 'AppData', 'Roaming', dirName);
    fs.mkdirSync(prefsDir, { recursive: true });
    const prefs = {
      window: { x: 60, y: 60, width: 1440, height: 960 },
      sidebarWidth: 244,
      historyDbPath: null,
      persistRawComm: false,
      lastWorkspacePath: workspacePath,
    };
    fs.writeFileSync(path.join(prefsDir, 'prefs.json'), JSON.stringify(prefs, null, 2));
  }
}

export const config = {
  runner: 'local',
  specs: ['./tests/e2e/**/*.e2e.ts'],
  maxInstances: 1,
  specFileRetries: 1,
  specFileRetryInterval: 3,
  capabilities: [
    {
      browserName: 'electron',
      'wdio:electronServiceOptions': {
        appBinaryPath: path.resolve('out', 'Modbus Debugger-win32-x64', 'modbus-debugger.exe'),
      },
    },
  ],
  services: ['electron'],
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: { ui: 'bdd', timeout: 120000 },
  waitforTimeout: 5000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,
  onPrepare: async () => {
    const staged = stageWorkspace();
    seedPrefs(staged);
    process.env.MODBUS_E2E_WORKSPACE = staged;
    sim = spawn('python', [path.resolve('tools', 'simulator', 'modbus_sim.py'), '--port', String(SIM_PORT)], { stdio: 'ignore' });
    await waitForPort(SIM_PORT);
  },
  onComplete: () => {
    sim?.kill();
    if (workspaceCopyDir) fs.rmSync(workspaceCopyDir, { recursive: true, force: true });
  },
};