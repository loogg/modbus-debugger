import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { UpdateService } from './updater';
import type { RuntimeManager } from '../runtime/manager';
import { parseImportSource } from './importer';
import type { Command, CommandResult } from '../../shared/commands';
import { commandSchema } from '../../shared/commands';
import type { AppDelta, AppSnapshot } from '../../shared/snapshot';
import type { AppVersions } from '../../shared/preload-api';

function getElectron() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('electron') as typeof import('electron');
  } catch {
    return null;
  }
}

export class AppBackendService {
  private deltaListeners = new Set<(delta: AppDelta) => void>();

  constructor(
    readonly manager: RuntimeManager,
    readonly updater: UpdateService,
    private readonly getWindow?: () => BrowserWindow | null,
  ) {
    this.manager.setUpdateState(this.updater.snapshot());
    this.updater.onChange = (state) => this.manager.setUpdateState(state);

    this.manager.onDelta = (delta) => {
      for (const listener of this.deltaListeners) {
        try {
          listener(delta);
        } catch {
          // Ignore listener error
        }
      }
    };
  }

  getSnapshot(): AppSnapshot {
    return this.manager.buildSnapshot();
  }

  getVersions(): AppVersions {
    const electron = getElectron();
    return {
      electron: process.versions.electron ?? (electron?.app ? 'electron' : 'browser'),
      node: process.versions.node ?? 'unknown',
      app: electron?.app?.getVersion ? electron.app.getVersion() : '0.11.0',
    };
  }

  subscribeDelta(listener: (delta: AppDelta) => void): () => void {
    this.deltaListeners.add(listener);
    return () => {
      this.deltaListeners.delete(listener);
    };
  }

  async handleCommand(raw: unknown): Promise<CommandResult> {
    const parsed = commandSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: `invalid command: ${parsed.error.message}` };
    }
    const cmd = parsed.data;
    if (['preparing', 'installing'].includes(this.updater.snapshot().phase) && !cmd.type.startsWith('update.')) {
      return { ok: false, error: '正在准备或安装更新，请稍候。' };
    }

    if (cmd.type.startsWith('update.')) {
      try {
        switch (cmd.type) {
          case 'update.status':
            return { ok: true, value: this.updater.snapshot() };
          case 'update.install':
            return { ok: true, value: await this.updater.install() };
          case 'update.confirmBoot':
            await this.updater.confirmBoot();
            return { ok: true, value: null };
          case 'update.check':
            return { ok: true, value: await this.updater.check() };
          case 'update.download':
            return { ok: true, value: await this.updater.download() };
          case 'update.cancel':
            this.updater.cancel();
            return { ok: true, value: null };
          case 'update.reveal':
            await this.updater.revealDownload();
            return { ok: true, value: null };
          case 'update.openLink':
            await this.updater.openLink(cmd.target);
            return { ok: true, value: null };
        }
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    }

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
      try {
        const electron = getElectron();
        if (!electron?.dialog) return { ok: false, error: 'Native file dialog requires desktop runtime' };
        const win = this.getWindow ? this.getWindow() : null;
        const opts = { properties: ['openFile'] as Array<'openFile'>, filters: [{ name: '导入文件', extensions: cmd.accept }] };
        const res = win ? await electron.dialog.showOpenDialog(win, opts) : await electron.dialog.showOpenDialog(opts);
        if (res.canceled || !res.filePaths.length) return { ok: false, error: 'cancelled' };
        return { ok: true, value: res.filePaths[0] };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }

    if (cmd.type === 'dialog.saveFile') {
      try {
        const electron = getElectron();
        const win = this.getWindow ? this.getWindow() : null;
        const userData = electron?.app?.getPath ? electron.app.getPath('userData') : process.cwd();
        const defaultPath = path.isAbsolute(cmd.defaultName) ? cmd.defaultName : path.join(userData, 'workspaces', path.basename(cmd.defaultName));
        if (!electron?.dialog) return { ok: false, error: 'Native file dialog requires desktop runtime' };
        const res = win ? await electron.dialog.showSaveDialog(win, { defaultPath }) : await electron.dialog.showSaveDialog({ defaultPath });
        if (res.canceled || !res.filePath) return { ok: false, error: 'cancelled' };
        return { ok: true, value: res.filePath };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
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
      return await this.manager.handleCommand(cmd as Command);
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }
}
