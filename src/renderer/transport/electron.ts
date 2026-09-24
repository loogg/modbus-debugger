import type { ModbusApi, AppVersions } from '../../shared/preload-api';
import type { AppTransport, TransportState } from './types';
import type { AppDelta, AppSnapshot } from '../../shared/snapshot';
import type { Command, CommandResult } from '../../shared/commands';

export class ElectronTransport implements AppTransport {
  readonly transportType = 'electron' as const;
  private statusListeners = new Set<(s: TransportState) => void>();

  constructor(private readonly api: ModbusApi) {}

  getStatus(): TransportState {
    return { type: 'electron', status: 'connected' };
  }

  onStatusChange(cb: (state: TransportState) => void): () => void {
    this.statusListeners.add(cb);
    cb(this.getStatus());
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  getSnapshot(): Promise<AppSnapshot> {
    return this.api.getSnapshot();
  }

  command<T = unknown>(cmd: Command): Promise<CommandResult<T>> {
    return this.api.command<T>(cmd);
  }

  onDelta(cb: (delta: AppDelta) => void): () => void {
    return this.api.onDelta(cb);
  }

  versions(): Promise<AppVersions> {
    return this.api.versions();
  }
}
