import { BrowserWindow, dialog, ipcMain, screen } from 'electron';
import { WINDOW_CHANNELS } from '../shared/workbench';
import type { WorkspaceService } from './services/workspace';
import { clampToWorkAreas } from './window-bounds';

/** Native windows host a retained view tree. They never initialize a second backend. */
export function installViewWindows(main: BrowserWindow, workspace: WorkspaceService) {
  const windows = new Map<string, BrowserWindow>();
  const allowedClose = new Set<string>();
  let shuttingDown = false;
  main.webContents.setWindowOpenHandler(details => {
    try {
      const target = new URL(details.url);
      const source = new URL(main.webContents.getURL());
      const id = target.searchParams.get('viewHost');
      if (!id || !/^[a-zA-Z0-9_-]{1,100}$/.test(id) || target.protocol !== source.protocol || target.host !== source.host || target.pathname !== source.pathname || windows.has(id) || windows.size >= 40) return { action: 'deny' };
      const saved = workspace.getPrefs().detachedWindows?.[id];
      const bounds = clampToWorkAreas(saved ?? { x: 100, y: 100, width: 1280, height: 860 }, screen.getAllDisplays().map(s => s.workArea));
      return { action: 'allow', overrideBrowserWindowOptions: {
        ...bounds, minWidth: 1024, minHeight: 680, backgroundColor: '#F6F7F9', autoHideMenuBar: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
      } };
    } catch { return { action: 'deny' }; }
  });
  main.webContents.on('did-create-window', (child, details) => {
    const id = new URL(details.url).searchParams.get('viewHost')!;
    windows.set(id, child);
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    child.webContents.on('will-navigate', (event, url) => { if (url !== details.url) event.preventDefault(); });
    child.on('close', event => {
      if (shuttingDown || allowedClose.has(id) || main.isDestroyed()) return;
      event.preventDefault();
      main.webContents.send(WINDOW_CHANNELS.closeRequest, id);
    });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const saveBounds = () => {
      if (child.isDestroyed()) return;
      const all = { ...workspace.getPrefs().detachedWindows, [id]: child.getNormalBounds() };
      // Preferences are bounded independently of portable workspace content.
      workspace.updatePrefs({ detachedWindows: Object.fromEntries(Object.entries(all).slice(-80)) });
    };
    const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(saveBounds, 400); };
    child.on('moved', schedule); child.on('resized', schedule);
    child.on('close', saveBounds);
    child.on('closed', () => { if (timer) clearTimeout(timer); windows.delete(id); allowedClose.delete(id); });
  });
  ipcMain.removeHandler(WINDOW_CHANNELS.close);
  ipcMain.handle(WINDOW_CHANNELS.close, (event, id: unknown) => {
    if (event.sender !== main.webContents || typeof id !== 'string') throw new Error('Unknown window owner');
    allowedClose.add(id);
    windows.get(id)?.close();
  });
  main.webContents.on('will-prevent-unload', event => {
    const choice = dialog.showMessageBoxSync(main, { type: 'question', title: '退出 Modbus Debugger', message: '页面中有未提交的编辑，退出将丢弃这些草稿。', buttons: ['继续编辑', '丢弃草稿并退出'], defaultId: 0, cancelId: 0 });
    if (choice === 1) event.preventDefault();
  });
  main.on('closed', () => {
    shuttingDown = true;
    for (const child of windows.values()) child.destroy();
    ipcMain.removeHandler(WINDOW_CHANNELS.close);
  });
  // A successful main-page reload replaces its JS tree. Do not leave old portals orphaned.
  main.webContents.on('did-navigate', () => { for (const child of windows.values()) child.destroy(); });
}
