import { ipcMain, dialog, BrowserWindow, app } from 'electron';
import { IPC_CHANNELS } from '../shared/preload-api';
import type { Command, CommandResult } from '../shared/commands';
import { commandSchema } from '../shared/commands';
import type { RuntimeManager } from './runtime/manager';
import { parseImportSource } from './services/importer';

export function registerIpc(manager: RuntimeManager, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC_CHANNELS.snapshot, () => manager.buildSnapshot());
  ipcMain.handle(IPC_CHANNELS.versions, () => ({
    electron: process.versions.electron,
    node: process.versions.node,
    app: app.getVersion(),
  }));
  ipcMain.handle(IPC_CHANNELS.command, async (_event, raw: unknown): Promise<CommandResult> => {
    const parsed = commandSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: `invalid command: ${parsed.error.message}` };
    }
    const cmd = parsed.data;
    if (cmd.type === 'serial.list') {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { SerialPort } = require('serialport') as { SerialPort: { list(): Promise<Array<Record<string, unknown>>> } };
        const ports = await SerialPort.list();
        return {
          ok: true,
          value: ports.map((p) => ({
            path: String(p.path ?? ''),
            manufacturer: p.manufacturer ? String(p.manufacturer) : null,
            serialNumber: p.serialNumber ? String(p.serialNumber) : null,
          })),
        };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }
    if (cmd.type === 'dialog.openFile') {
      const win = getWindow();
      const opts = { properties: ['openFile'] as Array<'openFile'>, filters: [{ name: '导入文件', extensions: cmd.accept }] };
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      if (res.canceled || !res.filePaths.length) return { ok: false, error: 'cancelled' };
      return { ok: true, value: res.filePaths[0] };
    }
    if (cmd.type === 'dialog.saveFile') {
      const win = getWindow();
      const res = win ? await dialog.showSaveDialog(win, { defaultPath: cmd.defaultName }) : await dialog.showSaveDialog({ defaultPath: cmd.defaultName });
      if (res.canceled || !res.filePath) return { ok: false, error: 'cancelled' };
      return { ok: true, value: res.filePath };
    }
    if (cmd.type === 'import.parse') {
      try {
        const table = await parseImportSource(cmd.source);
        return { ok: true, value: table };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }
    try {
      return await manager.handleCommand(cmd as Command);
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  manager.onDelta = (delta) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(IPC_CHANNELS.delta, delta);
  };
}