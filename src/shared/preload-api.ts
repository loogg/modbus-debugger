import type { AppDelta, AppSnapshot } from './snapshot';
import type { Command, CommandResult } from './commands';

export interface ModbusApi {
  getSnapshot(): Promise<AppSnapshot>;
  command<T = unknown>(cmd: Command): Promise<CommandResult<T>>;
  onDelta(cb: (delta: AppDelta) => void): () => void;
  versions(): Promise<{ electron: string; node: string; app: string }>;
}

export const IPC_CHANNELS = {
  snapshot: 'app:snapshot',
  command: 'app:command',
  delta: 'app:delta',
  versions: 'app:versions',
} as const;