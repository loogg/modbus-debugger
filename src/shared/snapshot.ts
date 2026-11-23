import type { UpdateState } from './update';
import type { Workspace } from '../domain/model';
import type { ConnectionHealth, ParseEventRecord, PointWriteReceipt, Prefs, SessionSummary, TransactionRecord } from './contracts';
import type { ScanOptions } from './scan-options';
import type { ScriptRunView } from './script-run';

export type BlockStatusView = 'idle' | 'ok' | 'timeout' | 'exception' | 'transport-error' | 'disabled';

export interface BlockViewState {
  valid?: boolean[];
  registers?: number[];
  bits?: boolean[];
  key: string;
  slaveId: string;
  blockId: string;
  blockName: string;
  area: 1 | 2 | 3 | 4;
  start: number;
  length: number;
  periodMs: number;
  status: BlockStatusView;
  exceptionCode: number | null;
  lastUpdateUtc: string | null;
  lastDurationMs: number | null;
  revision: number;
}

export interface PointViewState {
  lastWrite?: PointWriteReceipt;
  slaveId?: string;
  pointId: string;
  /** decoded raw rendered for engineering columns / inspector */
  rawText: string;
  /** engineering value text (confirmed value only) */
  engText: string;
  finite: boolean;
  rawNumber: number | null;
  engNumber: number | null;
  boolValue: boolean | null;
  stringValue: string | null;
  enumLabel: string | null;
  hasValue: boolean;
}

export interface ScanRow {
  unitId: number;
  responseMs: number;
  exceptionCode: number | null;
}

export interface ScanStateView {
  options: ScanOptions;
  phase: 'running' | 'stopping' | 'completed' | 'stopped';
  from: number;
  to: number;
  currentUnit: number | null;
  checked: number;
  found: ScanRow[];
  elapsedMs: number;
}

export interface ConnectionStateView {
  state: 'offline' | 'connecting' | 'online' | 'error';
  detail: string | null;
  lastResponseUtc: string | null;
  scan?: ScanStateView | null;
  clientCount?: number;
}

export type SlaveCommunicationState = 'pending' | 'connecting' | 'online' | 'offline' | 'disabled';

export interface SlaveStateView {
  state: SlaveCommunicationState;
  lastResponseUtc: string | null;
}

export interface AppSnapshot {
  update?: UpdateState;
  scriptRun?: ScriptRunView | null;
  revision: number;
  workspace: Workspace;
  workspacePath: string | null;
  dirty: boolean;
  connections: Record<string, ConnectionStateView>;
  slaveStates?: Record<string, SlaveStateView>;
  blocks: Record<string, BlockViewState>;
  points: Record<string, PointViewState>;
  transactions: TransactionRecord[];
  parseEvents: ParseEventRecord[];
  /** Bumped by diagnostics.clear so the renderer drops its local ring copies. */
  diagRev: number;
  health: Record<string, ConnectionHealth>;
  sessions: SessionSummary[];
  warnings: string[];
  prefs: Prefs;
  historyDbPath: string;
}

export interface SnapshotOptions { includeDiagnostics?: boolean }

export interface AppDelta {
  pointWrites?: Record<string, PointWriteReceipt>;
  scriptRun?: ScriptRunView | null;
  /** Layout/canvas metadata did not replace or invalidate the runtime bindings. */
  workspaceMetadataOnly?: boolean;
  update?: UpdateState;
  revision: number;
  workspace?: Workspace;
  workspacePath?: string | null;
  dirty?: boolean;
  connections?: Record<string, ConnectionStateView>;
  /** Changed devices only. Null removes the previous device state. */
  slaveStates?: Record<string, SlaveStateView | null>;
  blocks?: Record<string, BlockViewState>;
  points?: Record<string, PointViewState>;
  transactions?: TransactionRecord[];
  parseEvents?: ParseEventRecord[];
  diagRev?: number;
  health?: Record<string, ConnectionHealth>;
  sessions?: SessionSummary[];
  warnings?: string[];
  prefs?: Prefs;
}
