import type { UpdateService } from './services/updater';
import { ipcMain, BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../shared/preload-api';
import type { CommandResult } from '../shared/commands';
import type { RuntimeManager } from './runtime/manager';
import { AppBackendService } from './services/backend-service';

export function registerIpc(
  managerOrService: RuntimeManager | AppBackendService,
  getWindow: () => BrowserWindow | null,
  updater?: UpdateService,
): AppBackendService {
  const service =
    managerOrService instanceof AppBackendService
      ? managerOrService
      : new AppBackendService(managerOrService, updater!, getWindow);

  ipcMain.handle(IPC_CHANNELS.snapshot, () => service.getSnapshot());
  ipcMain.handle(IPC_CHANNELS.versions, () => service.getVersions());
  ipcMain.handle(IPC_CHANNELS.command, async (_event, raw: unknown): Promise<CommandResult> => {
    return service.handleCommand(raw);
  });

  service.subscribeDelta((delta) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.delta, delta);
    }
  });

  return service;
}
