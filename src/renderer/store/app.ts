import { create, useStore } from 'zustand';
import { createContext, useContext } from 'react';
import type { ModuleId, WorkbenchView, ViewSelection } from '../../shared/workbench';
import type { SlaveDef, Workspace } from '../../domain/model';
import type {
  AppDelta,
  AppSnapshot,
  BlockViewState,
  ConnectionStateView,
  PointViewState,
  SlaveCommunicationState,
} from '../../shared/snapshot';
import type { ParseEventRecord, TransactionRecord, ConnectionHealth, Prefs, SessionSummary } from '../../shared/contracts';
import type { Command, CommandResult } from '../../shared/commands';
import type { ModbusApi } from '../../shared/preload-api';
import { setDisplayTimeZone } from '../time';
import { applyLanguage, i18n } from '../i18n';
import { pointKey } from '../../shared/point-key';
import type { BufferInfo, DataPointRef } from '../../shared/point-data';
import { dataCacheFor } from './data-cache';

export type { ModuleId } from '../../shared/workbench';

export type Selection = ViewSelection;

export type Overlay =
  | { kind: 'dialog'; id: 'add-connection'; connectionId?: string }
  | { kind: 'dialog'; id: 'add-slave'; connectionId: string; slaveId?: string; unitId?: number }
  | { kind: 'dialog'; id: 'edit-block'; templateId: string; blockId?: string }
  | { kind: 'dialog'; id: 'new-trend-group' }
  | { kind: 'dialog'; id: 'save-as-block'; connectionId: string; unitId: number; area: 1 | 2 | 3 | 4; start: number; quantity: number; registers: number[] }
  | { kind: 'dialog'; id: 'confirm'; title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void; onCancel?: () => void }
  | { kind: 'drawer'; id: 'edit-point'; templateId: string; blockId: string; pointId?: string }
  | { kind: 'drawer'; id: 'inspector'; pointId: string }
  | { kind: 'dialog'; id: 'add-signal'; groupId: string; initialPoints?: DataPointRef[] }
  | { kind: 'dialog'; id: 'point-buffer'; pointRef: DataPointRef }
  | { kind: 'dialog'; id: 'buffer-export'; points: DataPointRef[]; name: string }
  | { kind: 'screen'; id: 'import-registers'; templateId: string };

export interface PointWriteState {
  phase: 'writing' | 'not-sent' | 'rejected' | 'unknown' | 'confirmed';
  attempted: string;
  at: number;
  exceptionCode: number | null;
  reason?: string;
}

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message?: string;
}

interface AppState {
  commSlaveFilter: Record<string, boolean>;
  commResultFilter: { ok: boolean; timeout: boolean; exception: boolean; other: boolean };
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
  dataManaged: boolean;
  dataEpoch: number;
  dataError: string | null;
  dataBuffers: Record<string, BufferInfo>;
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

function connectionStatusChanged(previous: AppSnapshot['connections'], next: AppSnapshot['connections']): boolean {
  if (Object.keys(previous).length !== Object.keys(next).length) return true;
  return Object.entries(next).some(([id, value]) => {
    const before = previous[id];
    return !before || before.state !== value.state || before.detail !== value.detail || before.clientCount !== value.clientCount || JSON.stringify(before.scan) !== JSON.stringify(value.scan);
  });
}

export interface LiveSeries {
  rangeStatus?: 'available' | 'partial' | 'expired';
  firstTimeMs?: number | null;
  lastTimeMs?: number | null;
  firstSeq?: number;
  samples: Array<[number, number, number?]>;
  events: Array<{ t: number; value: string; seq?: number }>;
  generation?: string;
  gap?: boolean;
  loading?: boolean;
}

const createAppStore = () => create<AppState>((set, get) => ({
  commSlaveFilter: {},
  commResultFilter: { ok: true, timeout: true, exception: true, other: true },
  api: null,
  snapshot: null,
  module: 'devices',
  selection: {
    canvasId: null,
    connectionId: null,
    slaveId: null,
    blockId: null,
    templateId: null,
    groupId: null,
    sessionId: null,
    commView: 'messages',
    historyTab: 'trend',
    trendTab: 'signals',
    trendWindowSec: null,
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
  dataManaged: false,
  dataEpoch: 0,
  dataError: null,
  dataBuffers: {},

  init: async (api) => {
    const snapshot = await api.getSnapshot({ includeDiagnostics: false });
    setDisplayTimeZone(snapshot.prefs.timezone);
    applyLanguage(snapshot.prefs.language);
    set({ api, snapshot, sidebarWidth: snapshot.prefs.sidebarWidth || 244 });
    api.onDelta((d) => get().applyDelta(d));
  },

  applyDelta: (d) => {
    const prev = get().snapshot;
    if (!prev) return;
    // A snapshot may overtake an in-flight bridge delta, and reconnects may replay one.
    // Reapplying it would duplicate transactions and restore stale workspace slices.
    if (d.revision <= prev.revision) return;
    // diagnostics.clear bumps diagRev: the local ring copies must be dropped, not appended to.
    const cleared = d.diagRev !== undefined && d.diagRev !== prev.diagRev;
    const replaceRuntime = d.workspace && !d.workspaceMetadataOnly;
    if (replaceRuntime && get().api) dataCacheFor(get().api!).invalidate();
    let slaveStates = prev.slaveStates;
    if (d.slaveStates) {
      const states = new Map(Object.entries(prev.slaveStates ?? {}));
      for (const [id, view] of Object.entries(d.slaveStates)) {
        if (view) states.set(id, view);
        else states.delete(id);
      }
      slaveStates = Object.fromEntries(states);
    }
    const next: AppSnapshot = {
      ...prev,
      revision: d.revision,
      update: d.update ?? prev.update,
      scriptRun: d.scriptRun === undefined ? prev.scriptRun : d.scriptRun,
      workspace: d.workspace ?? prev.workspace,
      workspacePath: d.workspacePath !== undefined ? d.workspacePath : prev.workspacePath,
      dirty: d.dirty !== undefined ? d.dirty : prev.dirty,
      connections: replaceRuntime ? d.connections ?? prev.connections : d.connections ? { ...prev.connections, ...d.connections } : prev.connections,
      slaveStates,
      blocks: replaceRuntime ? d.blocks ?? {} : d.blocks ? { ...prev.blocks, ...d.blocks } : prev.blocks,
      points: replaceRuntime ? d.points ?? {} : d.points ? { ...prev.points, ...d.points } : prev.points,
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
      sessions: d.sessions ?? prev.sessions,
      warnings: d.warnings ?? prev.warnings,
      prefs: d.prefs ?? prev.prefs,
    };
    const statusChanged = connectionStatusChanged(prev.connections, next.connections)
      || Object.entries(d.blocks ?? {}).some(([key, block]) => prev.blocks[key]?.status !== block.status || prev.blocks[key]?.exceptionCode !== block.exceptionCode);
    if (!replaceRuntime && statusChanged && get().api) dataCacheFor(get().api!).invalidateLatest();
    // Display prefs must be applied before the transactions branch below: that branch
    // early-returns, and while polling a prefs.set delta is routinely bundled with new
    // transactions. Applying it late silently dropped timezone/language changes.
    if (d.prefs) {
      setDisplayTimeZone(d.prefs.timezone);
      applyLanguage(d.prefs.language);
    }
    // derive transient write states from newly appended transactions
    if (d.pointWrites) {
      const writeStates = { ...get().writeStates };
      for (const [key, receipt] of Object.entries(d.pointWrites)) {
        if (writeStates[key]?.phase === 'writing') continue;
        const reason = receipt.phase !== 'not-sent' ? undefined : receipt.result === 'exception'
          ? i18n.t('ui.valueCell.preReadException', { code: `0x${(receipt.exceptionCode ?? 0).toString(16).toUpperCase().padStart(2, '0')}` })
          : i18n.t(receipt.result === 'timeout' ? 'ui.valueCell.preReadTimeout' : 'ui.valueCell.preReadTransport');
        writeStates[key] = { phase: receipt.phase, attempted: receipt.attempted, at: receipt.atMs, exceptionCode: receipt.exceptionCode, reason };
      }
      set({ snapshot: next, writeStates, ...(replaceRuntime ? { live: {}, dataBuffers: {}, dataEpoch: get().dataEpoch + 1 } : {}) });
      return;
    }
    if (d.transactions) {
      const hasWriteTx = d.transactions.some((t) => t.sourceKind === 'write' || t.sourceKind === 'readback');
      const writeStates = hasWriteTx ? { ...get().writeStates } : get().writeStates;
      const now = Date.now();
      for (const tx of d.transactions) {
        if (!tx.sourceId) continue;
        const slave = next.workspace.slaves.find(s => s.connectionId === tx.connectionId && s.unitId === tx.unitId);
        const writeKey = pointKey(slave?.id, tx.sourceId);
        if (tx.sourceKind === 'write') {
          if (tx.result === 'ok') writeStates[writeKey] = { phase: 'confirmed', attempted: writeStates[writeKey]?.attempted ?? '', at: now, exceptionCode: null };
          else if (tx.result === 'exception') writeStates[writeKey] = { phase: 'rejected', attempted: writeStates[writeKey]?.attempted ?? '', at: now, exceptionCode: tx.exceptionCode };
          else writeStates[writeKey] = { phase: 'unknown', attempted: writeStates[writeKey]?.attempted ?? '', at: now, exceptionCode: null };
        } else if (tx.sourceKind === 'readback') {
          writeStates[writeKey] = { phase: tx.result === 'ok' ? 'confirmed' : 'unknown', attempted: '', at: now, exceptionCode: null };
        }
      }
      if (hasWriteTx) for (const [k, v] of Object.entries(writeStates)) {
        if (v.phase === 'confirmed' && now - v.at > 2500) delete writeStates[k];
        if ((v.phase === 'rejected' || v.phase === 'unknown') && now - v.at > 10000) delete writeStates[k];
      }
      set({ snapshot: next, writeStates, ...(replaceRuntime ? { live: {}, dataBuffers: {}, dataEpoch: get().dataEpoch + 1 } : {}) });
      return;
    }
    set({ snapshot: next, ...(replaceRuntime ? { live: {}, dataBuffers: {}, dataEpoch: get().dataEpoch + 1 } : {}) });
  },

  setModule: (m) => set({ module: m }),
  select: (patch) => set({ selection: { ...get().selection, ...(patch.templateId !== undefined ? {templateEditing:false,editBlockId:null} : {}), ...(patch.groupId !== undefined && patch.groupId !== get().selection.groupId ? { trendWindowSec: null } : {}), ...patch }, ...(patch.slaveId !== undefined && patch.slaveId !== get().selection.slaveId ? { selectedPoints: {} } : {}) }),
  setSidebarWidth: (w) => {
    const clamped = Math.min(320, Math.max(220, w));
    set({ sidebarWidth: clamped });
    if (get() !== appStore.getState()) appStore.setState({ sidebarWidth: clamped });
    void get().command({ type: 'prefs.set', patch: { sidebarWidth: clamped } });
  },
  openOverlay: (o) => set({ overlay: o }),
  closeOverlay: () => {
    const overlay = get().overlay;
    if (overlay?.kind === 'dialog' && overlay.id === 'confirm') overlay.onCancel?.();
    set({ overlay: null });
  },
  toast: (t) => {
    const id = toastSeq++;
    set({ toasts: [...get().toasts, { ...t, id }] });
    setTimeout(() => get().dismissToast(id), 5000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  command: async <T,>(cmd: Command) => {
    const api = get().api;
    if (!api) return { ok: false, error: 'api not ready' } as CommandResult<T>;
    let res: CommandResult<T>;
    try { res = await api.command<T>(cmd); }
    catch (error) { res = { ok: false, error: String(error) }; }
    if (!res.ok) get().toast({ kind: 'error', title: '操作失败', message: res.error });
    if (res.ok && ['point.write', 'slave.setValues', 'connection.connect', 'connection.disconnect', 'device.refresh'].includes(cmd.type)) dataCacheFor(api).invalidateLatest();
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

/** One data subscription; each view owns only its navigation and transient UI state. */
export const appStore = createAppStore();
export type AppStore = ReturnType<typeof createAppStore>;
export const AppStoreContext = createContext<AppStore | null>(null);
export const useViewStore = (): AppStore => useContext(AppStoreContext) ?? appStore;
export const useApp = Object.assign(function useApp<T>(selector: (state: AppState) => T): T {
  return useStore(useViewStore(), selector);
}, { getState: appStore.getState, setState: appStore.setState, subscribe: appStore.subscribe });

export function createViewStore(view: Pick<WorkbenchView, 'module' | 'selection'>) {
  const store = createAppStore();
  const sync = () => {
    const { snapshot, api, live, writeStates, dataEpoch } = appStore.getState();
    const previous = store.getState();
    if (previous.dataManaged && snapshot) {
      const reset = previous.dataEpoch !== dataEpoch;
      const retained = previous.snapshot;
      const beforeBlocks = retained?.blocks ?? {};
      let blocks: Record<string, BlockViewState> = reset ? {} : beforeBlocks;
      if (!reset) {
        for (const [key, block] of Object.entries(snapshot.blocks)) {
          const before = beforeBlocks[key];
          if (before && (before.status !== block.status || before.exceptionCode !== block.exceptionCode)) {
            if (blocks === beforeBlocks) blocks = { ...beforeBlocks };
            blocks[key] = { ...before, status: block.status, exceptionCode: block.exceptionCode };
          }
        }
      }
      const connections = retained && !connectionStatusChanged(retained.connections, snapshot.connections) ? retained.connections : snapshot.connections;
      store.setState({ snapshot: { ...snapshot, points: reset ? {} : retained?.points ?? {}, blocks, connections }, api, writeStates, dataEpoch,
        ...(reset ? { live: {}, dataBuffers: {} } : {}) });
    } else store.setState({ snapshot, api, live, writeStates, dataEpoch });
  };
  sync();
  store.setState({ module: view.module, sidebarWidth: appStore.getState().sidebarWidth, selection: { ...store.getState().selection, ...view.selection } });
  let stop: (() => void) | undefined;
  const connect = () => { sync(); stop ??= appStore.subscribe(sync); };
  const dispose = () => { stop?.(); stop = undefined; };
  return { store, connect, dispose };
}

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
export const usePrefs = (): Prefs | null => useApp((s) => s.snapshot?.prefs ?? null);
export const useHistoryDbPath = (): string => useApp((s) => s.snapshot?.historyDbPath ?? '');

/** Connection state of one connection as a primitive, so status dots do not re-render on value deltas. */
export const useConnectionState = (connectionId: string | null | undefined): ConnectionStateView['state'] =>
  useApp((s) => (connectionId ? s.snapshot?.connections[connectionId]?.state ?? 'offline' : 'offline'));

export function slaveCommunicationState(
  snapshot: Pick<AppSnapshot, 'connections' | 'slaveStates'> | null | undefined,
  slave?: SlaveDef,
): SlaveCommunicationState {
  if (!slave) return 'offline';
  if (!slave.enabled) return 'disabled';
  const state = snapshot?.slaveStates?.[slave.id]?.state;
  if (state) return state;
  const link = snapshot?.connections[slave.connectionId]?.state;
  return link === 'online' ? 'pending' : link === 'connecting' ? 'connecting' : 'offline';
}

export const useSlaveState = (slave?: SlaveDef): SlaveCommunicationState =>
  useApp(state => slaveCommunicationState(state.snapshot, slave));
