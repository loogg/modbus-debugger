import { create } from 'zustand';
import type { Workspace } from '../../domain/model';
import type {
  AppDelta,
  AppSnapshot,
  BlockViewState,
  ConnectionStateView,
  PointViewState,
  RecordingView,
} from '../../shared/snapshot';
import type { ParseEventRecord, TransactionRecord, ConnectionHealth } from '../../main/runtime/diagnostics';
import type { Prefs } from '../../main/services/workspace';
import type { SessionSummary } from '../../main/services/history';
import type { Command, CommandResult } from '../../shared/commands';
import type { ModbusApi } from '../../shared/preload-api';
import { setDisplayTimeZone } from '../time';
import { applyLanguage } from '../i18n';

export type ModuleId = 'devices' | 'realtime' | 'trend' | 'history' | 'comm' | 'templates' | 'settings';

export interface Selection {
  connectionId: string | null;
  slaveId: string | null;
  blockId: string | null;
  templateId: string | null;
  groupId: string | null;
  sessionId: string | null;
  commView: 'messages' | 'health' | 'trace';
  historyTab: 'trend' | 'events' | 'data' | 'signals';
  trendTab: 'signals' | 'chart';
  realtimeScope: 'device' | 'block';
  deviceView: 'topology' | 'scan' | 'temp';
  templateEditing: boolean;
  editBlockId: string | null;
}

export type Overlay =
  | { kind: 'dialog'; id: 'add-connection'; connectionId?: string }
  | { kind: 'dialog'; id: 'add-slave'; connectionId: string; slaveId?: string }
  | { kind: 'dialog'; id: 'edit-block'; templateId: string; blockId?: string }
  | { kind: 'dialog'; id: 'new-trend-group' }
  | { kind: 'dialog'; id: 'save-as-block'; connectionId: string; unitId: number; area: 1 | 2 | 3 | 4; start: number; quantity: number; registers: number[] }
  | { kind: 'dialog'; id: 'confirm'; title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void }
  | { kind: 'drawer'; id: 'edit-point'; templateId: string; blockId: string; pointId?: string }
  | { kind: 'drawer'; id: 'inspector'; pointId: string }
  | { kind: 'dialog'; id: 'add-signal'; groupId: string }
  | { kind: 'screen'; id: 'import-registers'; templateId: string };

export interface PointWriteState {
  phase: 'writing' | 'rejected' | 'unknown' | 'confirmed';
  attempted: string;
  at: number;
  exceptionCode: number | null;
}

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message?: string;
}

interface AppState {
  api: ModbusApi | null;
  snapshot: AppSnapshot | null;
  module: ModuleId;
  selection: Selection;
  sidebarWidth: number;
  overlay: Overlay | null;
  toasts: Toast[];
  writeStates: Record<string, PointWriteState>;
  selectedPoints: Record<string, boolean>;
  live: Record<string, LiveSeries>;
  init: (api: ModbusApi) => Promise<void>;
  applyDelta: (d: AppDelta) => void;
  setModule: (m: ModuleId) => void;
  select: (patch: Partial<Selection>) => void;
  setSidebarWidth: (w: number) => void;
  openOverlay: (o: Overlay) => void;
  closeOverlay: () => void;
  toast: (t: Omit<Toast, 'id'>) => void;
  dismissToast: (id: number) => void;
  command: <T = unknown>(cmd: Command) => Promise<CommandResult<T>>;
  togglePointSelected: (pointId: string) => void;
  clearPointSelection: () => void;
}

let toastSeq = 1;

export interface LiveSeries {
  samples: Array<[number, number]>;
  events: Array<{ t: number; value: string }>;
}

const MAX_SAMPLES = 5000;
const MAX_EVENTS = 2000;

/**
 * Appends the newest confirmed values to the in-memory trend buffers.
 *
 * The buffers are mutated in place and trimmed from the front: copying a 5000-sample
 * array per point on every delta (10 Hz) was the single largest renderer hot spot.
 * Consumers always read the array fresh during render, and the enclosing `live` map
 * is replaced so subscriptions still update.
 */
function appendLive(live: Record<string, LiveSeries>, points: AppSnapshot['points'] | undefined): Record<string, LiveSeries> {
  if (!points) return live;
  const now = Date.now();
  const out = { ...live };
  for (const [id, view] of Object.entries(points)) {
    if (!view.hasValue) continue;
    const cur = out[id] ?? { samples: [], events: [] };
    if (view.engNumber !== null) {
      cur.samples.push([now, view.engNumber]);
      if (cur.samples.length > MAX_SAMPLES) cur.samples.splice(0, cur.samples.length - MAX_SAMPLES);
    } else {
      const value = view.boolValue !== null ? String(view.boolValue) : view.stringValue ?? view.enumLabel ?? String(view.rawNumber);
      const last = cur.events[cur.events.length - 1];
      if (!last || last.value !== value) {
        cur.events.push({ t: now, value });
        if (cur.events.length > MAX_EVENTS) cur.events.splice(0, cur.events.length - MAX_EVENTS);
      }
    }
    out[id] = cur;
  }
  return out;
}

export const useApp = create<AppState>((set, get) => ({
  api: null,
  snapshot: null,
  module: 'devices',
  selection: {
    connectionId: null,
    slaveId: null,
    blockId: null,
    templateId: null,
    groupId: null,
    sessionId: null,
    commView: 'messages',
    historyTab: 'trend',
    trendTab: 'signals',
    realtimeScope: 'device',
    templateEditing: false,
    deviceView: 'topology',
    editBlockId: null,
  },
  sidebarWidth: 244,
  overlay: null,
  toasts: [],
  writeStates: {},
  selectedPoints: {},
  live: {},

  init: async (api) => {
    const snapshot = await api.getSnapshot();
    setDisplayTimeZone(snapshot.prefs.timezone);
    applyLanguage(snapshot.prefs.language);
    set({ api, snapshot, sidebarWidth: snapshot.prefs.sidebarWidth || 244 });
    api.onDelta((d) => get().applyDelta(d));
  },

  applyDelta: (d) => {
    const prev = get().snapshot;
    if (!prev) return;
    // diagnostics.clear bumps diagRev: the local ring copies must be dropped, not appended to.
    const cleared = d.diagRev !== undefined && d.diagRev !== prev.diagRev;
    const next: AppSnapshot = {
      ...prev,
      revision: d.revision,
      workspace: d.workspace ?? prev.workspace,
      workspacePath: d.workspacePath !== undefined ? d.workspacePath : prev.workspacePath,
      dirty: d.dirty !== undefined ? d.dirty : prev.dirty,
      connections: d.connections ? { ...prev.connections, ...d.connections } : prev.connections,
      blocks: d.blocks ? { ...prev.blocks, ...d.blocks } : prev.blocks,
      points: d.points ? { ...prev.points, ...d.points } : prev.points,
      diagRev: d.diagRev ?? prev.diagRev,
      transactions: cleared
        ? (d.transactions ?? []).slice(-500)
        : d.transactions
          ? [...prev.transactions, ...d.transactions].slice(-500)
          : prev.transactions,
      parseEvents: cleared
        ? (d.parseEvents ?? []).slice(-200)
        : d.parseEvents
          ? [...prev.parseEvents, ...d.parseEvents].slice(-200)
          : prev.parseEvents,
      health: d.health ? { ...prev.health, ...d.health } : prev.health,
      recording: d.recording !== undefined ? d.recording : prev.recording,
      sessions: d.sessions ?? prev.sessions,
      warnings: d.warnings ?? prev.warnings,
      prefs: d.prefs ?? prev.prefs,
    };
    // Display prefs must be applied before the transactions branch below: that branch
    // early-returns, and while polling a prefs.set delta is routinely bundled with new
    // transactions. Applying it late silently dropped timezone/language changes.
    if (d.prefs) {
      setDisplayTimeZone(d.prefs.timezone);
      applyLanguage(d.prefs.language);
    }
    // derive transient write states from newly appended transactions
    if (d.transactions) {
      const hasWriteTx = d.transactions.some((t) => t.sourceKind === 'write' || t.sourceKind === 'readback');
      const writeStates = hasWriteTx ? { ...get().writeStates } : get().writeStates;
      const now = Date.now();
      for (const tx of d.transactions) {
        if (!tx.sourceId) continue;
        if (tx.sourceKind === 'write') {
          if (tx.result === 'ok') writeStates[tx.sourceId] = { phase: 'writing', attempted: writeStates[tx.sourceId]?.attempted ?? '', at: now, exceptionCode: null };
          else if (tx.result === 'exception') writeStates[tx.sourceId] = { phase: 'rejected', attempted: writeStates[tx.sourceId]?.attempted ?? '', at: now, exceptionCode: tx.exceptionCode };
          else if (tx.result === 'timeout') writeStates[tx.sourceId] = { phase: 'unknown', attempted: writeStates[tx.sourceId]?.attempted ?? '', at: now, exceptionCode: null };
        } else if (tx.sourceKind === 'readback' && tx.result === 'ok') {
          writeStates[tx.sourceId] = { phase: 'confirmed', attempted: '', at: now, exceptionCode: null };
        }
      }
      if (hasWriteTx) for (const [k, v] of Object.entries(writeStates)) {
        if (v.phase === 'confirmed' && now - v.at > 2500) delete writeStates[k];
        if ((v.phase === 'rejected' || v.phase === 'unknown') && now - v.at > 10000) delete writeStates[k];
      }
      const live = appendLive(get().live, d.points);
      set({ snapshot: next, writeStates, live });
      return;
    }
    const live = d.points ? appendLive(get().live, d.points) : get().live;
    set({ snapshot: next, live });
  },

  setModule: (m) => set({ module: m }),
  select: (patch) => set({ selection: { ...get().selection, ...patch } }),
  setSidebarWidth: (w) => {
    const clamped = Math.min(320, Math.max(220, w));
    set({ sidebarWidth: clamped });
    void get().command({ type: 'prefs.set', patch: { sidebarWidth: clamped } });
  },
  openOverlay: (o) => set({ overlay: o }),
  closeOverlay: () => set({ overlay: null }),
  toast: (t) => {
    const id = toastSeq++;
    set({ toasts: [...get().toasts, { ...t, id }] });
    setTimeout(() => get().dismissToast(id), 5000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  command: async <T,>(cmd: Command) => {
    const api = get().api;
    if (!api) return { ok: false, error: 'api not ready' } as CommandResult<T>;
    const res = (await api.command<T>(cmd)) as CommandResult<T>;
    if (!res.ok) get().toast({ kind: 'error', title: '操作失败', message: res.error });
    return res;
  },
  togglePointSelected: (pointId) => {
    const cur = { ...get().selectedPoints };
    if (cur[pointId]) delete cur[pointId];
    else cur[pointId] = true;
    set({ selectedPoints: cur });
  },
  clearPointSelection: () => set({ selectedPoints: {} }),
}));

/* ------------------------------------------------------------------ *
 * Stable slice selectors
 * ------------------------------------------------------------------ *
 * `snapshot` gets a fresh identity on every delta (up to 10/s while polling), so
 * subscribing to it re-renders the component on every poll even when nothing it
 * displays changed. These hooks subscribe to the individual slices instead:
 * `applyDelta` keeps the previous reference for any slice the delta did not carry,
 * so identity is stable and React can bail out.
 */

const EMPTY_POINTS: Record<string, PointViewState> = {};
const EMPTY_BLOCKS: Record<string, BlockViewState> = {};
const EMPTY_CONNECTIONS: Record<string, ConnectionStateView> = {};
const EMPTY_HEALTH: Record<string, ConnectionHealth> = {};
const EMPTY_TRANSACTIONS: TransactionRecord[] = [];
const EMPTY_PARSE_EVENTS: ParseEventRecord[] = [];
const EMPTY_SESSIONS: SessionSummary[] = [];
const EMPTY_WARNINGS: string[] = [];

export const useSnapshotReady = (): boolean => useApp((s) => s.snapshot !== null);
export const useWorkspace = (): Workspace | null => useApp((s) => s.snapshot?.workspace ?? null);
export const useWorkspacePath = (): string | null => useApp((s) => s.snapshot?.workspacePath ?? null);
export const useWorkspaceDirty = (): boolean => useApp((s) => s.snapshot?.dirty ?? false);
export const usePoints = (): Record<string, PointViewState> => useApp((s) => s.snapshot?.points ?? EMPTY_POINTS);
export const useBlocks = (): Record<string, BlockViewState> => useApp((s) => s.snapshot?.blocks ?? EMPTY_BLOCKS);
export const useConnectionStates = (): Record<string, ConnectionStateView> => useApp((s) => s.snapshot?.connections ?? EMPTY_CONNECTIONS);
export const useHealth = (): Record<string, ConnectionHealth> => useApp((s) => s.snapshot?.health ?? EMPTY_HEALTH);
export const useTransactions = (): TransactionRecord[] => useApp((s) => s.snapshot?.transactions ?? EMPTY_TRANSACTIONS);
export const useParseEvents = (): ParseEventRecord[] => useApp((s) => s.snapshot?.parseEvents ?? EMPTY_PARSE_EVENTS);
export const useSessions = (): SessionSummary[] => useApp((s) => s.snapshot?.sessions ?? EMPTY_SESSIONS);
export const useWarnings = (): string[] => useApp((s) => s.snapshot?.warnings ?? EMPTY_WARNINGS);
export const useRecording = (): RecordingView | null => useApp((s) => s.snapshot?.recording ?? null);
export const usePrefs = (): Prefs | null => useApp((s) => s.snapshot?.prefs ?? null);
export const useHistoryDbPath = (): string => useApp((s) => s.snapshot?.historyDbPath ?? '');

/** Connection state of one connection as a primitive, so status dots do not re-render on value deltas. */
export const useConnectionState = (connectionId: string | null | undefined): ConnectionStateView['state'] =>
  useApp((s) => (connectionId ? s.snapshot?.connections[connectionId]?.state ?? 'offline' : 'offline'));
