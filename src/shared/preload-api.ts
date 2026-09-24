import type { AppDelta, AppSnapshot } from './snapshot';
import type { Command, CommandResult } from './commands';

export type AppVersions = { electron: string; node: string; app: string };

export interface ModbusApi {
  getSnapshot(): Promise<AppSnapshot>;
  command<T = unknown>(cmd: Command): Promise<CommandResult<T>>;
  onDelta(cb: (delta: AppDelta) => void): () => void;
  versions(): Promise<AppVersions>;
}

export type AppApi = ModbusApi;

export const IPC_CHANNELS = {
  snapshot: 'app:snapshot',
  command: 'app:command',
  delta: 'app:delta',
  versions: 'app:versions',
} as const;

/** Whitelisted WebSocket Bridge client -> server messages */
export type BridgeClientMessage =
  | { type: 'snapshot'; id: string }
  | { type: 'versions'; id: string }
  | { type: 'command'; id: string; command: unknown };

/** Whitelisted WebSocket Bridge server -> client messages */
export type BridgeServerMessage =
  | { type: 'response'; id: string; ok: true; value: unknown }
  | { type: 'response'; id: string; ok: false; error: string }
  | { type: 'delta'; delta: AppDelta }
  | { type: 'hello'; versions: AppVersions };