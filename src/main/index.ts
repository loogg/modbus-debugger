import { UpdateService, detectPackageKind } from './services/updater';
import { prepareInstall, confirmUpdatedBoot, readInstallOutcome } from './services/self-update';
import path from 'node:path';
import fs from 'node:fs';
import { app, BrowserWindow, dialog, nativeImage, net, protocol, screen, shell } from 'electron';
import { pathToFileURL } from 'node:url';
import log from 'electron-log';
import { RuntimeManager } from './runtime/manager';
import { WorkspaceService } from './services/workspace';
import { HistoryStore } from './services/history';
import { registerIpc } from './ipc';
import { DevBridgeServer } from './services/dev-bridge';
import { executionDirectory } from './services/execution-directory';
import { prepareStorage } from './services/storage-paths';

let mainWindow: BrowserWindow | null = null;
let manager: RuntimeManager | null = null;
let updater: UpdateService | null = null;
let devBridge: DevBridgeServer | null = null;

// Configure Electron/Chromium BEFORE ready, logging or creating any BrowserWindow.
const executionDir = executionDirectory(app.isPackaged, app.getPath('exe'), process.cwd(), app.commandLine.getSwitchValue('portable-dir') || process.env.PORTABLE_EXECUTABLE_DIR);
const storage = (() => {
  try {
    return prepareStorage(executionDir, app.commandLine.getSwitchValue('data-dir') || process.env.MODBUS_DATA_DIR);
  } catch (error) {
    dialog.showErrorBox('数据目录不可写', `${String(error)}\n\n请将程序放到可写目录，或使用 --data-dir="D:\\ModbusData" 指定可写的数据目录。程序不会回退到 AppData 或系统临时目录。`);
    app.exit(1);
    throw error;
  }
})();
app.setPath('userData', storage.data);
app.setPath('sessionData', storage.cache);
app.setPath('logs', storage.logs);
app.setPath('temp', storage.temp);
app.setPath('crashDumps', storage.crashes);
app.commandLine.appendSwitch('disk-cache-dir', path.join(storage.cache, 'http'));
process.env.TEMP = storage.temp;
process.env.TMP = storage.temp;

// E2E harness: expose a fixed Chrome DevTools port so WebdriverIO can attach.
if (process.env.MODBUS_E2E === '1') {
  app.commandLine.appendSwitch('remote-debugging-port', '9222');
}

// Registered once: createWindow() can run again on macOS "activate".
let appProtocolRegistered = false;
function registerAppProtocol(): void {
  if (appProtocolRegistered) return;
  appProtocolRegistered = true;
  const rendererDir = path.join(__dirname, '../renderer', MAIN_WINDOW_VITE_NAME);
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\//, '');
    const file = path.join(rendererDir, rel === '' ? 'index.html' : rel);
    return net.fetch(pathToFileURL(file).toString());
  });
}

// Serve the packaged renderer over a privileged standard scheme: ES-module scripts
// cannot load from file:// (CORS), and a custom scheme keeps webSecurity enabled.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

log.transports.file.resolvePathFn = () => path.join(storage.logs, 'main.log');
log.initialize();
log.info('runtime-paths', JSON.stringify({ ...storage, executable: app.getPath('exe'), userData: app.getPath('userData'), sessionData: app.getPath('sessionData'), electronTemp: app.getPath('temp') }));
log.info('app starting, userData =', app.getPath('userData'));

function clampToBounds(x: number, y: number, width: number, height: number): Electron.Rectangle {
  const displays = screen.getAllDisplays();
  const visible = displays.some((d) => {
    const b = d.workArea;
    return x < b.x + b.width && x + width > b.x && y < b.y + b.height && y + height > b.y;
  });
  if (!visible && displays.length) {
    const b = displays[0] as Electron.Display;
    return {
      x: b.workArea.x + 40,
      y: b.workArea.y + 40,
      width: Math.min(width, b.workArea.width),
      height: Math.min(height, b.workArea.height),
    };
  }
  return { x, y, width, height };
}

async function createWindow(): Promise<void> {
  const wsSvc = new WorkspaceService(app.getPath('userData'));
  const historyPath = wsSvc.getPrefs().historyDbPath ?? path.join(storage.data, 'history.db');
  const history = await HistoryStore.open(historyPath);
  manager = new RuntimeManager(wsSvc, history);
  const loaded = wsSvc.loadFrom(process.env.MODBUS_E2E_WORKSPACE || null);
  log.info('workspace loaded:', loaded.ok, wsSvc.currentPath);
  manager.start();

  const prefs = wsSvc.getPrefs();
  const desired = clampToBounds(
    prefs.window.x ?? 80,
    prefs.window.y ?? 80,
    Math.max(1024, prefs.window.width),
    Math.max(680, prefs.window.height),
  );

  mainWindow = new BrowserWindow({
    ...desired,
    minWidth: 1024,
    minHeight: 680,
    title: 'Modbus 调试工具',
    backgroundColor: '#F6F7F9',
    icon: (() => {
      const p = path.join(process.resourcesPath, 'build', 'icon.png');
      return fs.existsSync(p) ? nativeImage.createFromPath(p) : undefined;
    })(),
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (process.env.MODBUS_HEADLESS !== '1') {
      mainWindow?.show();
    }
  });

  let boundsTimer: NodeJS.Timeout | null = null;
  const persistBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!mainWindow) return;
      const b = mainWindow.getBounds();
      wsSvc.updatePrefs({ window: { x: b.x, y: b.y, width: b.width, height: b.height } });
    }, 500);
  };
  mainWindow.on('moved', persistBounds);
  mainWindow.on('resized', persistBounds);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  updater ??= new UpdateService({
    currentVersion: app.getVersion(), packageKind: detectPackageKind(executionDir, Boolean(app.commandLine.getSwitchValue('portable-dir') || process.env.PORTABLE_EXECUTABLE_DIR)),
    platform: process.platform, arch: process.arch, dataDirectory: storage.data, tempDirectory: storage.temp,
    fetch: (url, init) => net.fetch(url, init), reveal: file => shell.showItemInFolder(file), openExternal: url => shell.openExternal(url),
    canInstall: app.isPackaged && process.platform === 'win32',
    bootPending: loaded.ok && Boolean(app.commandLine.getSwitchValue('update-session')),
    installMessage: (await readInstallOutcome(storage.root))?.message ?? null,
    confirmBoot: async () => {
      const confirmed = await confirmUpdatedBoot(storage.root, app.commandLine.getSwitchValue('update-session'), app.commandLine.getSwitchValue('update-token'), app.getVersion());
      return confirmed ? `已升级到 v${app.getVersion()}，工作区已恢复。` : null;
    },
    install: async (release, file, manifest, signal, installing) => {
      const protectedPaths = [historyPath, ...(wsSvc.currentPath ? [wsSvc.currentPath] : [])];
      if (storage.root.toLowerCase() !== executionDir.toLowerCase()) protectedPaths.push(storage.root);
      const restartArgs = [`--data-dir=${storage.root}`];
      const debugPort = app.commandLine.getSwitchValue('remote-debugging-port');
      if (debugPort) restartArgs.push(`--remote-debugging-port=${debugPort}`);
      const prepared = await prepareInstall({packaged:app.isPackaged,kind:updater!.snapshot().packageKind,currentVersion:app.getVersion(),executionDir,
        currentExe:app.getPath('exe'),portableExe:app.commandLine.getSwitchValue('portable-exe'),dataRoot:storage.root,
        helperSource:path.join(process.resourcesPath,'update-helper.ps1'),protectedPaths,restartArgs}, release.asset!, file, release.version, manifest, signal);
      let stopping = false;
      try {
        signal.throwIfAborted();
        const saved = wsSvc.saveTo(wsSvc.currentPath ?? path.join(storage.workspaces, `before-update-${Date.now()}.workspace.json`));
        if (!saved.ok) throw new Error(`保存工作区失败，未安装更新：${saved.error}`);
        installing(); stopping = true;
        await manager!.stop();
        await prepared.commit();
        app.exit(0);
      } catch (error) {
        await prepared.abort();
        if (stopping) { log.error('update handoff failed', error); app.relaunch({execPath:prepared.targetExe,args:restartArgs}); app.exit(1); }
        throw error;
      }
    },
  });
  const backend = registerIpc(manager, () => mainWindow, updater);
  if (!app.isPackaged) {
    const bridgePort = Number(process.env.MODBUS_DEV_BRIDGE_PORT || 5174);
    devBridge = new DevBridgeServer(backend, { port: bridgePort, host: '127.0.0.1' });
    devBridge
      .start()
      .then((port) => log.info(`Dev Bridge server listening on ws://127.0.0.1:${port}`))
      .catch((err) => log.error('Failed to start Dev Bridge server', err));
  }
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    registerAppProtocol();
    await mainWindow.loadURL('app://./index.html');
  }
}

app.whenReady().then(() => {
  void createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  const done = () => app.exit(0);
  void (async () => {
    if (devBridge) await devBridge.close();
    await updater?.dispose();
    await manager?.stop();
  })().then(done, done);
});

process.on('uncaughtException', (err) => {
  log.error('uncaught', err);
});
