import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

process.on('uncaughtException', (err) => { try { fs.writeFileSync(path.join(os.tmpdir(), 'mb-crash.txt'), String(err && err.stack)); } catch { /* ignore */ } });
fs.writeFileSync(path.join(os.tmpdir(), 'mb-main-boot.txt'), 'boot ' + new Date().toISOString() + ' pid ' + String(process.pid));
import { app, BrowserWindow, nativeImage, screen } from 'electron';
import log from 'electron-log';
import { RuntimeManager } from './runtime/manager';
import { WorkspaceService } from './services/workspace';
import { HistoryStore } from './services/history';
import { registerIpc } from './ipc';

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

let mainWindow: BrowserWindow | null = null;
let manager: RuntimeManager | null = null;

// eslint-disable-next-line @typescript-eslint/no-require-imports
if (require('electron-squirrel-startup')) app.quit();


// E2E harness: expose a fixed Chrome DevTools port so WebdriverIO can attach.
if (process.env.MODBUS_E2E === '1') {
  app.commandLine.appendSwitch('remote-debugging-port', '9222');
}

log.initialize();
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
  const history = await HistoryStore.open(wsSvc.defaultHistoryDbPath());
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
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
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
  await mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
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

app.on('before-quit', () => {
  if (manager) void manager.stop();
});

process.on('uncaughtException', (err) => {
  log.error('uncaught', err);
});
