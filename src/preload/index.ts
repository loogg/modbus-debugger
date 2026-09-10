import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, type ModbusApi } from '../shared/preload-api';
import type { AppDelta } from '../shared/snapshot';
import type { Command, CommandResult } from '../shared/commands';

const api: ModbusApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.snapshot),
  command: <T = unknown>(cmd: Command) => ipcRenderer.invoke(IPC_CHANNELS.command, cmd) as Promise<CommandResult<T>>,
  onDelta: (cb: (delta: AppDelta) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, delta: AppDelta) => cb(delta);
    ipcRenderer.on(IPC_CHANNELS.delta, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.delta, listener);
    };
  },
  versions: () => ipcRenderer.invoke(IPC_CHANNELS.versions),
};

contextBridge.exposeInMainWorld('modbus', api);