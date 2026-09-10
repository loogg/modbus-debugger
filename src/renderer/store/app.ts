import { create } from 'zustand';
import type { AppDelta, AppSnapshot } from '../../shared/snapshot';
import type { Command, CommandResult } from '../../shared/commands';
import type { ModbusApi } from '../../shared/preload-api';

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
  live: Record<string, { samples: Array<[number, number]>; events: Array<{ t: number; value: string }> }>;
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

function appendLive(live: Record<string, { samples: Array<[number, number]>; events: Array<{ t: number; value: string }> }>, points: AppSnapshot['points'] | undefined) {
  if (!points) return live;
  const now = Date.now();
  const out = { ...live };
  for (const [id, view] of Object.entries(points)) {
    if (!view.hasValue) continue;
    const cur = out[id] ?? { samples: [], events: [] };
    const next = { samples: cur.samples, events: cur.events };
    if (view.engNumber !== null) {
      next.samples = [...cur.samples, [now, view.engNumber] as [number, number]].slice(-5000);
    } else {
      const value = view.boolValue !== null ? String(view.boolValue) : view.stringValue ?? view.enumLabel ?? String(view.rawNumber);
      const last = cur.events[cur.events.length - 1];
      if (!last || last.value !== value) {
        next.events = [...cur.events, { t: now, value }].slice(-2000);
      }
    }
    out[id] = next;
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
    set({ api, snapshot, sidebarWidth: snapshot.prefs.sidebarWidth || 244 });
    api.onDelta((d) => get().applyDelta(d));
  },

  applyDelta: (d) => {
    const prev = get().snapshot;
    if (!prev) return;
    const next: AppSnapshot = {
      ...prev,
      revision: d.revision,
      workspace: d.workspace ?? prev.workspace,
      workspacePath: d.workspacePath !== undefined ? d.workspacePath : prev.workspacePath,
      dirty: d.dirty !== undefined ? d.dirty : prev.dirty,
      connections: d.connections ? { ...prev.connections, ...d.connections } : prev.connections,
      blocks: d.blocks ? { ...prev.blocks, ...d.blocks } : prev.blocks,
      points: d.points ? { ...prev.points, ...d.points } : prev.points,
      transactions: d.transactions ? [...prev.transactions, ...d.transactions].slice(-500) : prev.transactions,
      parseEvents: d.parseEvents ? [...prev.parseEvents, ...d.parseEvents].slice(-200) : prev.parseEvents,
      health: d.health ? { ...prev.health, ...d.health } : prev.health,
      recording: d.recording !== undefined ? d.recording : prev.recording,
      sessions: d.sessions ?? prev.sessions,
      warnings: d.warnings ?? prev.warnings,
      prefs: d.prefs ?? prev.prefs,
    };
    // derive transient write states from newly appended transactions
    if (d.transactions) {
      const writeStates = { ...get().writeStates };
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
      for (const [k, v] of Object.entries(writeStates)) {
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