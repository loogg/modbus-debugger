import path from 'node:path';
import fs from 'node:fs';
import { app, BrowserWindow, dialog, nativeImage, net, protocol, screen } from 'electron';
import { pathToFileURL } from 'node:url';
import log from 'electron-log';
import { RuntimeManager } from './runtime/manager';
import { WorkspaceService } from './services/workspace';
import { HistoryStore } from './services/history';
import { registerIpc } from './ipc';
import { executionDirectory } from './services/execution-directory';
import { prepareStorage } from './services/storage-paths';

let mainWindow: BrowserWindow | null = null;
let manager: RuntimeManager | null = null;

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

  mainWindow.once('ready-to-show', () => mainWindow?.show());

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

  registerIpc(manager, () => mainWindow);
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
  if (manager) void manager.stop().then(done, done);
  else done();
});

process.on('uncaughtException', (err) => {
  log.error('uncaught', err);
});
