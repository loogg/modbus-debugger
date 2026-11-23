import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { assertLegacyPreferencesUnchanged, createScratch, removeScratch, setupTestEnvironment, snapshotLegacyPreferences, testRoot } from './tools/test-paths.mjs';
import { legacySessionsForWorkspace, writeLegacyHistoryFixture } from './tools/legacy-history-fixture';

setupTestEnvironment();
const testRunDir = process.env.MODBUS_TEST_RUN_DIR ? path.resolve(process.env.MODBUS_TEST_RUN_DIR) : createScratch('e2e-');
if (path.dirname(testRunDir) !== testRoot || !/^e2e-[a-z0-9-]+$/i.test(path.basename(testRunDir))) {
  throw new Error('MODBUS_TEST_RUN_DIR must be an e2e-* directory directly inside out/test-temp');
}
fs.mkdirSync(testRunDir, { recursive: true });
process.env.MODBUS_TEST_RUN_DIR = testRunDir;
process.env.MODBUS_DATA_DIR = testRunDir;
const legacyPreferences = snapshotLegacyPreferences();

let sim: ChildProcess | null = null;
let rtuSim: ChildProcess | null = null;
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
  workspaceCopyDir = testRunDir;
  const dest = path.join(workspaceCopyDir, 'demo.workspace.json');
  if (process.env.MODBUS_E2E_TCP_ONLY === '1') {
    const workspace = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as import('./src/domain/model').Workspace;
    workspace.connections = workspace.connections.filter(c => c.transport === 'tcp');
    workspace.slaves = workspace.slaves.filter(s => workspace.connections.some(c => c.id === s.connectionId));
    workspace.trendGroups = workspace.trendGroups.map(g => ({ ...g, signals: g.signals.filter(s => workspace.slaves.some(device => device.id === s.pointRef.slaveId)) }));
    fs.writeFileSync(dest, JSON.stringify(workspace));
  } else fs.copyFileSync(FIXTURE, dest);
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
  const prefsDir = path.join(testRunDir, 'data');
  fs.mkdirSync(prefsDir, { recursive: true });
  const prefs = {
    window: { x: 60, y: 60, width: 1440, height: 960 },
    sidebarWidth: 244,
    historyDbPath: null,
    lastWorkspacePath: workspacePath,
  };
  fs.writeFileSync(path.join(prefsDir, 'prefs.json'), JSON.stringify(prefs, null, 2));
}

export const config = {
  runner: 'local',
  logLevel: 'warn',
  specs: ['./tests/e2e/**/*.e2e.ts'],
  maxInstances: 1,
  specFileRetries: 0,
  specFileRetryInterval: 3,
  capabilities: [
    {
      browserName: 'electron',
      'wdio:electronServiceOptions': {
        appBinaryPath: path.resolve('out', 'Modbus Debugger-win32-x64', 'modbus-debugger.exe'),
        // ChromeDriver's DevToolsActivePort lives in Electron sessionData, not our app prefs directory.
        appArgs: [`--user-data-dir=${path.join(testRunDir, 'cache')}`],
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
    if (process.env.MODBUS_RTU_SLAVE_PORT) {
      rtuSim = spawn('python', [path.resolve('tools/simulator/modbus_sim.py'), '--transport', 'rtu', '--serial-port', process.env.MODBUS_RTU_SLAVE_PORT], { stdio: ['ignore', 'pipe', 'pipe'] });
      const child = rtuSim;
      await new Promise<void>((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error(output || 'RTU simulator start timeout')); }, 15000);
        child.stdout!.on('data', chunk => { output += String(chunk); if (output.includes('"event": "ready"')) { clearTimeout(timer); resolve(); } });
        child.stderr!.on('data', chunk => { output += String(chunk); });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`RTU exited ${code}: ${output}`)); });
        child.once('error', err => { clearTimeout(timer); reject(err); });
      });
    }
  },
  beforeSession: async (_config: unknown, _capabilities: unknown, specs: string[]) => {
    // Each spec starts a new app. Previous specs may have saved the fixture or switched workspaces.
    const staged = stageWorkspace();
    seedPrefs(staged);
    const workspace = JSON.parse(fs.readFileSync(staged, 'utf8')) as import('./src/domain/model').Workspace;
    if (specs.some(spec => spec.endsWith('display-followup.e2e.ts'))) {
      const slave = workspace.slaves.find(item => workspace.connections.find(connection => connection.id === item.connectionId)?.transport === 'tcp')!;
      const template = workspace.templates.find(item => item.id === slave.templateId)!;
      workspace.trendGroups[0]!.signals = template.points.map(point => ({ id: `legacy-${point.id}`, pointRef: { connectionId: slave.connectionId, slaveId: slave.id, pointId: point.id }, visible: true }));
    }
    const sessions = legacySessionsForWorkspace(workspace);
    if (specs.some(spec => spec.endsWith('display-followup.e2e.ts'))) {
      for (const session of sessions) session.events = Array.from(session.events ?? []).filter(event => event.kind !== 'string' || event.tMs === 0)
        .map(event => event.kind === 'string' ? { ...event, value: 'V2.4.0' } : event);
    }
    if (specs.some(spec => spec.endsWith('history-legacy.e2e.ts')) && sessions[0]) {
      sessions.push({ ...sessions[0], id: 'legacy-unfinished', groupName: '未结束的旧会话', status: 'recording', endUtc: null });
    }
    await writeLegacyHistoryFixture(path.join(testRunDir, 'data', 'history.db'), sessions);
  },
  onComplete: (exitCode: number) => {
    sim?.kill();
    rtuSim?.kill();
    assertLegacyPreferencesUnchanged(legacyPreferences);
    if (workspaceCopyDir && exitCode === 0) removeScratch(workspaceCopyDir);
  },
};
