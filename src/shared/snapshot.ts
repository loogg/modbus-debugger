import type { Workspace } from '../domain/model';
import type { ConnectionHealth, ParseEventRecord, TransactionRecord } from '../main/runtime/diagnostics';
import type { Prefs } from '../main/services/workspace';
import type { SessionSummary } from '../main/services/history';
import type { ScanOptions } from './scan-options';

export type BlockStatusView = 'idle' | 'ok' | 'timeout' | 'exception' | 'transport-error' | 'disabled';

export interface BlockViewState {
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
}

export interface RecordingView {
  sessionId: string;
  groupId: string;
  groupName: string;
  startedUtc: string;
  signalCount: number;
  elapsedMs: number;
  sampleCount: number;
  eventCount: number;
}

export interface AppSnapshot {
  revision: number;
  workspace: Workspace;
  workspacePath: string | null;
  dirty: boolean;
  connections: Record<string, ConnectionStateView>;
  blocks: Record<string, BlockViewState>;
  points: Record<string, PointViewState>;
  transactions: TransactionRecord[];
  parseEvents: ParseEventRecord[];
  /** Bumped by diagnostics.clear so the renderer drops its local ring copies. */
  diagRev: number;
  health: Record<string, ConnectionHealth>;
  recording: RecordingView | null;
  sessions: SessionSummary[];
  warnings: string[];
  prefs: Prefs;
  historyDbPath: string;
}

export interface AppDelta {
  revision: number;
  workspace?: Workspace;
  workspacePath?: string | null;
  dirty?: boolean;
  connections?: Record<string, ConnectionStateView>;
  blocks?: Record<string, BlockViewState>;
  points?: Record<string, PointViewState>;
  transactions?: TransactionRecord[];
  parseEvents?: ParseEventRecord[];
  diagRev?: number;
  health?: Record<string, ConnectionHealth>;
  recording?: RecordingView | null;
  sessions?: SessionSummary[];
  warnings?: string[];
  prefs?: Prefs;
}
