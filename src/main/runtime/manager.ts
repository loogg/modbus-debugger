import { BlockCache, blockKey } from './block-cache';
import { ConnectionRuntime, type ConnectionState } from './connection-runtime';
import { DiagnosticsStore, type ConnectionHealth } from './diagnostics';
import { SerialTransport, TcpTransport, type Transport } from './transport';
import { HistoryStore, type EventRow, type SampleRow, type SessionDetail, type SessionSignalSchema, type SessionSummary } from '../services/history';
import { WorkspaceService } from '../services/workspace';
import type { AppDelta, AppSnapshot, BlockViewState, ConnectionStateView, PointViewState, RecordingView } from '../../shared/snapshot';
import type { Command, CommandResult } from '../../shared/commands';
import type { BlockDef, ConnectionDef, DeviceTemplate, PointDef, SlaveDef } from '../../domain/model';
import { decodeRaw, type DecodedRaw } from '../../domain/mapping';
import { engineeringToRaw, toEngineering } from '../../domain/scale';
import { systemClock, type Clock } from '../../domain/protocol';

export interface PointRef {
  slave: SlaveDef;
  block: BlockDef;
  point: PointDef;
  template: DeviceTemplate;
  connection: ConnectionDef;
}

export type TransportFactory = (config: ConnectionDef) => Transport;

export function defaultTransportFactory(config: ConnectionDef): Transport {
  if (config.transport === 'tcp' && config.tcp) return new TcpTransport(config.tcp);
  if (config.transport === 'rtu' && config.rtu) return new SerialTransport(config.rtu);
  throw new Error(`connection ${config.name} has no transport settings`);
}

function fmtNumber(v: number): string {
  if (!Number.isFinite(v)) return 'NaN';
  const rounded = Math.round(v * 1000) / 1000;
  return String(rounded);
}

export class RuntimeManager {
  readonly cache = new BlockCache();
  readonly diagnostics = new DiagnosticsStore();
  private runtimes = new Map<string, ConnectionRuntime>();
  private clock: Clock;
  private revision = 0;
  private sentTxCount = 0;
  private sentEventCount = 0;
  private sentCacheRev = new Map<string, number>();
  private sentWorkspaceRev = -1;
  private workspaceRev = 0;
  private connStateRev = 0;
  private connConfigHash = new Map<string, string>();
  private lastConnStates = new Map<string, ConnectionStateView>();
  private timer: NodeJS.Timeout | null = null;
  private transportFactory: TransportFactory;

  // recording
  private recording: { sessionId: string; groupId: string; groupName: string; startedMono: number; startedUtc: string; schema: SessionSignalSchema[]; last: Map<string, DecodedRaw>; sampleCount: number; eventCount: number } | null = null;
  private pendingSamples: SampleRow[] = [];
  private pendingEvents: EventRow[] = [];
  private sessionsRev = 0;
  private warnings: string[] = [];

  constructor(
    readonly workspaceService: WorkspaceService,
    private history: HistoryStore,
    opts: { clock?: Clock; transportFactory?: TransportFactory } = {},
  ) {
    this.clock = opts.clock ?? systemClock;
    this.transportFactory = opts.transportFactory ?? defaultTransportFactory;
  }

  setHistory(store: HistoryStore): void {
    this.history = store;
    this.sessionsRev++;
  }

  get historyStore(): HistoryStore {
    return this.history;
  }

  /* ---------------- lifecycle ---------------- */

  start(): void {
    this.rebuildRuntimes();
    this.timer = setInterval(() => this.tick(), 100);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.recording) this.stopRecording();
    for (const rt of this.runtimes.values()) await rt.stop();
    this.history.close();
    this.runtimes.clear();
    this.workspaceService.flushAutosave();
  }

  onDelta: ((delta: AppDelta) => void) | null = null;

  workspaceChanged(): void {
    this.workspaceRev++;
    this.rebuildRuntimes();
    this.workspaceService.scheduleAutosave();
  }

  private rebuildRuntimes(): void {
    const ws = this.workspaceService.current;
    const wanted = new Set(ws.connections.map((c) => c.id));
    for (const [id, rt] of [...this.runtimes.entries()]) {
      if (!wanted.has(id)) {
        void rt.stop();
        this.runtimes.delete(id);
        this.cache.removeSlave(id);
      }
    }
    for (const conn of ws.connections) {
      let rt = this.runtimes.get(conn.id);
      const configHash = JSON.stringify(conn);
      if (rt && this.connConfigHash.get(conn.id) !== configHash) {
        void rt.stop();
        this.runtimes.delete(conn.id);
        rt = undefined;
      }
      if (!rt) {
        this.connConfigHash.set(conn.id, configHash);
        rt = new ConnectionRuntime({
          config: conn,
          transport: this.transportFactory(conn),
          cache: this.cache,
          diagnostics: this.diagnostics,
          clock: this.clock,
          hooks: {
            onChange: () => {
              this.connStateRev++;
            },
            onState: (state: ConnectionState, detail?: string) => {
              this.connStateRev++;
              if (state === 'online') this.recordConnectionEvent(`${conn.name} 已连接`);
              if (state === 'error') this.recordConnectionEvent(`${conn.name} 连接异常：${detail ?? ''}`);
            },
          },
        });
        this.runtimes.set(conn.id, rt);
        void rt.start();
      }
      const targets = ws.slaves
        .filter((s) => s.connectionId === conn.id)
        .flatMap((slave) => {
          const template = ws.templates.find((t) => t.id === slave.templateId);
          if (!template) return [];
          return template.blocks.map((block) => ({ slave, block }));
        });
      rt.configure(targets);
    }
  }

  runtimeFor(connectionId: string): ConnectionRuntime | undefined {
    return this.runtimes.get(connectionId);
  }

  /* ---------------- point index & views ---------------- */

  pointIndex(): Map<string, PointRef> {
    const ws = this.workspaceService.current;
    const map = new Map<string, PointRef>();
    for (const slave of ws.slaves) {
      const connection = ws.connections.find((c) => c.id === slave.connectionId);
      const template = ws.templates.find((t) => t.id === slave.templateId);
      if (!connection || !template) continue;
      for (const block of template.blocks) {
        for (const point of template.points.filter((p) => p.blockId === block.id)) {
          map.set(point.id, { slave, block, point, template, connection });
        }
      }
    }
    return map;
  }

  private pointView(ref: PointRef): PointViewState {
    const key = blockKey(ref.slave.id, ref.block.id);
    const entry = this.cache.get(key);
    const base: PointViewState = {
      pointId: ref.point.id,
      rawText: '—',
      engText: '—',
      finite: true,
      rawNumber: null,
      engNumber: null,
      boolValue: null,
      stringValue: null,
      enumLabel: null,
      hasValue: false,
    };
    if (!entry || entry.status === 'idle' || entry.status === 'disabled') return base;
    let raw: DecodedRaw | null = null;
    try {
      raw = decodeRaw(entry.memory, ref.point.mapping);
    } catch {
      raw = null;
    }
    if (raw === null) return base;
    const view = { ...base, hasValue: true };
    const m = ref.point.mapping;
    if (typeof raw === 'boolean') {
      view.boolValue = raw;
      view.rawText = raw ? '1' : '0';
      view.engText = raw ? 'ON' : 'OFF';
      return view;
    }
    if (typeof raw === 'string') {
      view.stringValue = raw;
      view.rawText = raw;
      view.engText = raw;
      return view;
    }
    view.rawNumber = raw;
    if (m.rawType === 'BitField' || ref.point.enumMap && Object.keys(ref.point.enumMap).length > 0) {
      const label = ref.point.enumMap[String(raw)];
      if (label) {
        view.enumLabel = label;
        view.engText = label;
        view.rawText = String(raw);
        return view;
      }
    }
    if (ref.point.displayFormat === 'hex') {
      view.rawText = `0x${(raw >>> 0).toString(16).toUpperCase().padStart(m.rawType === 'UInt8' || m.rawType === 'Int8' ? 2 : 4, '0')}`;
    } else if (m.rawType === 'UInt8' || m.rawType === 'Int8') {
      view.rawText = `0x${(raw & 0xff).toString(16).toUpperCase().padStart(2, '0')}`;
    } else {
      view.rawText = String(raw);
    }
    const eng = toEngineering(raw, { scale: ref.point.scale, offset: ref.point.offset });
    view.engNumber = Number.isFinite(eng) ? eng : null;
    view.finite = Number.isFinite(eng);
    view.engText = Number.isFinite(eng) ? fmtNumber(eng) : '非有限数值';
    if (ref.point.displayFormat === 'hex' && Number.isFinite(eng)) view.engText = view.rawText;
    return view;
  }

  private blockView(key: string): BlockViewState | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    return {
      key,
      slaveId: entry.slaveId,
      blockId: entry.block.id,
      blockName: entry.block.name,
      area: entry.block.area,
      start: entry.block.start,
      length: entry.block.length,
      periodMs: entry.block.periodMs,
      status: entry.status,
      exceptionCode: entry.exceptionCode,
      lastUpdateUtc: entry.lastUpdateUtc,
      lastDurationMs: entry.lastDurationMs,
      revision: entry.revision,
    };
  }

  private connectionViews(): Record<string, ConnectionStateView> {
    const ws = this.workspaceService.current;
    const out: Record<string, ConnectionStateView> = {};
    for (const conn of ws.connections) {
      const rt = this.runtimes.get(conn.id);
      const lastResp = this.diagnostics
        .transactionsForConnection(conn.id, 50)
        .filter((t) => t.result === 'ok')
        .slice(-1)[0];
      out[conn.id] = {
        state: rt?.state ?? 'offline',
        detail: rt?.state === 'error' ? '连接异常' : null,
        lastResponseUtc: lastResp?.startUtc ?? null,
      };
    }
    return out;
  }

  /* ---------------- snapshot / delta ---------------- */

  buildSnapshot(): AppSnapshot {
    const ws = this.workspaceService.current;
    const index = this.pointIndex();
    const points: Record<string, PointViewState> = {};
    for (const [id, ref] of index.entries()) points[id] = this.pointView(ref);
    const blocks: Record<string, BlockViewState> = {};
    for (const entry of this.cache.all()) {
      const v = this.blockView(entry.key);
      if (v) blocks[entry.key] = v;
    }
    const health: Record<string, ConnectionHealth> = {};
    for (const conn of ws.connections) health[conn.id] = this.healthFor(conn.id);
    return {
      revision: this.revision,
      workspace: ws,
      workspacePath: this.workspaceService.currentPath,
      dirty: this.workspaceService.isDirty(),
      connections: this.connectionViews(),
      blocks,
      points,
      transactions: this.diagnostics.recentTransactions(500),
      parseEvents: this.diagnostics.recentParseEvents(200),
      health,
      recording: this.recordingView(),
      sessions: this.history.listSessions(),
      warnings: this.warnings,
      prefs: this.workspaceService.getPrefs(),
      historyDbPath: this.history.dbPath,
    };
  }

  healthFor(connectionId: string): ConnectionHealth {
    const ws = this.workspaceService.current;
    const blocks: Array<{ slaveId: string; blockId: string; blockName: string; configuredPeriodMs: number }> = [];
    for (const slave of ws.slaves.filter((s) => s.connectionId === connectionId)) {
      const template = ws.templates.find((t) => t.id === slave.templateId);
      if (!template) continue;
      for (const b of template.blocks) blocks.push({ slaveId: slave.id, blockId: b.id, blockName: b.name, configuredPeriodMs: b.periodMs });
    }
    return this.diagnostics.health(connectionId, this.clock.now(), blocks);
  }

  private recordingView(): RecordingView | null {
    if (!this.recording) return null;
    return {
      sessionId: this.recording.sessionId,
      groupId: this.recording.groupId,
      groupName: this.recording.groupName,
      startedUtc: this.recording.startedUtc,
      signalCount: this.recording.schema.length,
      elapsedMs: this.clock.now() - this.recording.startedMono,
      sampleCount: this.recording.sampleCount,
      eventCount: this.recording.eventCount,
    };
  }

  private tick(): void {
    this.sampleRecording();
    this.flushRecordingBuffers();
    this.checkWarnings();
    const delta = this.collectDelta();
    if (delta && this.onDelta) this.onDelta(delta);
  }

  private collectDelta(): AppDelta | null {
    const delta: AppDelta = { revision: this.revision };
    let changed = false;
    const ws = this.workspaceService.current;
    if (this.workspaceRev !== this.sentWorkspaceRev) {
      delta.workspace = ws;
      delta.workspacePath = this.workspaceService.currentPath;
      this.sentWorkspaceRev = this.workspaceRev;
      changed = true;
    }
    const connViews = this.connectionViews();
    const connChanged = Object.entries(connViews).some(([id, v]) => {
      const prev = this.lastConnStates.get(id);
      return !prev || prev.state !== v.state || prev.lastResponseUtc !== v.lastResponseUtc;
    });
    if (connChanged || this.lastConnStates.size !== Object.keys(connViews).length) {
      delta.connections = connViews;
      this.lastConnStates = new Map(Object.entries(connViews));
      changed = true;
    }
    const blocks: Record<string, BlockViewState> = {};
    const points: Record<string, PointViewState> = {};
    const index = this.pointIndex();
    const touchedSlaves = new Set<string>();
    for (const entry of this.cache.all()) {
      if ((this.sentCacheRev.get(entry.key) ?? -1) !== entry.revision) {
        const v = this.blockView(entry.key);
        if (v) blocks[entry.key] = v;
        this.sentCacheRev.set(entry.key, entry.revision);
        touchedSlaves.add(entry.slaveId);
        changed = true;
      }
    }
    if (touchedSlaves.size) {
      for (const [pointId, ref] of index.entries()) {
        if (touchedSlaves.has(ref.slave.id)) points[pointId] = this.pointView(ref);
      }
    }
    if (Object.keys(blocks).length) delta.blocks = blocks;
    if (Object.keys(points).length) delta.points = points;

    const txs = this.diagnostics.recentTransactions(5000);
    if (txs.length !== this.sentTxCount) {
      delta.transactions = txs.slice(this.sentTxCount);
      this.sentTxCount = txs.length;
      changed = true;
    }
    const evs = this.diagnostics.recentParseEvents(2000);
    if (evs.length !== this.sentEventCount) {
      delta.parseEvents = evs.slice(this.sentEventCount);
      this.sentEventCount = evs.length;
      changed = true;
    }
    if (changed || this.healthDirty) {
      const health: Record<string, ConnectionHealth> = {};
      for (const conn of ws.connections) health[conn.id] = this.healthFor(conn.id);
      delta.health = health;
      this.healthDirty = false;
      changed = true;
    }
    if (this.recordingViewChanged) {
      delta.recording = this.recordingView();
      this.recordingViewChanged = false;
      changed = true;
    }
    if (this.sessionsRev !== this.sentSessionsRev) {
      delta.sessions = this.history.listSessions();
      this.sentSessionsRev = this.sessionsRev;
      changed = true;
    }
    if (!changed) return null;
    this.revision++;
    delta.revision = this.revision;
    return delta;
  }

  private healthDirty = true;
  private recordingViewChanged = false;
  private sentSessionsRev = -1;

  private checkWarnings(): void {
    const warnings: string[] = [];
    if (this.history.overTenGb()) warnings.push(`history.db 已超过 10 GB（当前 ${(this.history.sizeBytes() / 1e9).toFixed(1)} GB），请考虑归档。`);
    const ws = this.workspaceService.current;
    for (const conn of ws.connections) {
      const h = this.healthFor(conn.id);
      if (h.busLoadPercent > 80) warnings.push(`连接 ${conn.name} 总线负载 ${h.busLoadPercent.toFixed(0)}%，请调整数据块周期。`);
    }
    if (JSON.stringify(warnings) !== JSON.stringify(this.warnings)) {
      this.warnings = warnings;
      this.healthDirty = true;
    }
  }

  /* ---------------- recording ---------------- */

  startRecording(groupId: string): CommandResult<RecordingView> {
    if (this.recording) return { ok: false, error: '已有记录会话正在进行' };
    const ws = this.workspaceService.current;
    const group = ws.trendGroups.find((g) => g.id === groupId);
    if (!group) return { ok: false, error: '趋势组不存在' };
    const index = this.pointIndex();
    const schema: SessionSignalSchema[] = group.signals.map((sig) => {
      const ref = index.get(sig.pointRef.pointId);
      const numeric = ref ? !['Bool', 'String'].includes(ref.point.mapping.rawType) && Object.keys(ref.point.enumMap).length === 0 : true;
      return {
        signalId: sig.id,
        pointId: sig.pointRef.pointId,
        pointName: ref?.point.name ?? sig.pointRef.pointId,
        connectionName: ref?.connection.name ?? '',
        slaveName: ref?.slave.name ?? '',
        blockName: ref?.block.name ?? '',
        rawType: ref?.point.mapping.rawType ?? 'UInt16',
        unit: ref?.point.unit ?? '',
        scale: ref?.point.scale ?? 1,
        offset: ref?.point.offset ?? 0,
        enumMap: ref?.point.enumMap ?? {},
        recordMode: numeric ? 'samples' : 'events',
      };
    });
    const sessionId = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.history.createSession(sessionId, group.id, group.name, schema);
    this.recording = {
      sessionId,
      groupId: group.id,
      groupName: group.name,
      startedMono: this.clock.now(),
      startedUtc: new Date().toISOString(),
      schema,
      last: new Map(),
      sampleCount: 0,
      eventCount: 0,
    };
    this.recordingViewChanged = true;
    this.sessionsRev++;
    return { ok: true, value: this.recordingView() as RecordingView };
  }

  stopRecording(): CommandResult<null> {
    if (!this.recording) return { ok: false, error: '没有正在进行的记录会话' };
    this.flushRecordingBuffers();
    this.history.endSession(this.recording.sessionId);
    this.recording = null;
    this.recordingViewChanged = true;
    this.sessionsRev++;
    return { ok: true, value: null };
  }

  private sampleRecording(): void {
    const rec = this.recording;
    if (!rec) return;
    const index = this.pointIndex();
    const tMs = Math.round(this.clock.now() - rec.startedMono);
    for (const sig of rec.schema) {
      const ref = index.get(sig.pointId);
      if (!ref) continue;
      const view = this.pointView(ref);
      if (!view.hasValue) continue;
      if (sig.recordMode === 'samples') {
        const value = view.engNumber;
        if (value === null) continue;
        this.pendingSamples.push({ signalId: sig.signalId, tMs, value });
        rec.sampleCount++;
      } else {
        const current: DecodedRaw = view.boolValue !== null ? view.boolValue : view.stringValue !== null ? view.stringValue : view.enumLabel ?? String(view.rawNumber);
        const prev = rec.last.get(sig.signalId);
        if (prev === undefined) {
          rec.last.set(sig.signalId, current);
          this.pendingEvents.push({ signalId: sig.signalId, tMs, kind: sig.rawType === 'Bool' ? 'bool' : sig.rawType === 'String' ? 'string' : 'enum', value: String(current) });
          rec.eventCount++;
        } else if (prev !== current) {
          rec.last.set(sig.signalId, current);
          this.pendingEvents.push({ signalId: sig.signalId, tMs, kind: sig.rawType === 'Bool' ? 'bool' : sig.rawType === 'String' ? 'string' : 'enum', value: String(current) });
          rec.eventCount++;
        }
      }
    }
    this.recordingViewChanged = true;
  }

  private flushRecordingBuffers(): void {
    if (!this.recording) return;
    if (this.pendingSamples.length) {
      this.history.insertSamples(this.recording.sessionId, this.pendingSamples);
      this.pendingSamples = [];
    }
    if (this.pendingEvents.length) {
      this.history.insertEvents(this.recording.sessionId, this.pendingEvents);
      this.pendingEvents = [];
    }
  }

  recordWriteEvent(text: string): void {
    if (!this.recording) return;
    this.pendingEvents.push({ signalId: '__session', tMs: Math.round(this.clock.now() - this.recording.startedMono), kind: 'write', value: text });
    this.recording.eventCount++;
  }

  private recordConnectionEvent(text: string): void {
    if (!this.recording) return;
    this.pendingEvents.push({ signalId: '__session', tMs: Math.round(this.clock.now() - this.recording.startedMono), kind: 'connection', value: text });
    this.recording.eventCount++;
  }

  /* ---------------- commands ---------------- */

  async handleCommand(cmd: Command): Promise<CommandResult> {
    const wsSvc = this.workspaceService;
    switch (cmd.type) {
      case 'workspace.new':
        wsSvc.newWorkspace();
        this.workspaceChanged();
        return { ok: true, value: null };
      case 'workspace.open': {
        const res = wsSvc.loadFrom(cmd.path);
        if (!res.ok) return { ok: false, error: res.error ?? 'open failed' };
        this.workspaceRev++;
        this.rebuildRuntimes();
        return { ok: true, value: wsSvc.currentPath };
      }
      case 'workspace.save': {
        const res = wsSvc.saveTo();
        return res.ok ? { ok: true, value: res.path } : { ok: false, error: res.error ?? 'save failed' };
      }
      case 'workspace.saveAs': {
        const res = wsSvc.saveTo(cmd.path);
        this.workspaceRev++;
        return res.ok ? { ok: true, value: res.path } : { ok: false, error: res.error ?? 'save failed' };
      }
      case 'workspace.export':
        return { ok: true, value: wsSvc.exportText() };
      case 'workspace.importText': {
        const res = wsSvc.importFromBuffer(cmd.text);
        if (!res.ok || !res.workspace) return { ok: false, error: res.error ?? 'import failed' };
        wsSvc.adopt(res.workspace, null);
        this.workspaceChanged();
        return { ok: true, value: null };
      }
      case 'workspace.apply':
        wsSvc.set(cmd.workspace);
        this.workspaceChanged();
        return { ok: true, value: null };
      case 'connection.connect': {
        const rt = this.runtimes.get(cmd.connectionId);
        if (!rt) return { ok: false, error: 'connection runtime missing' };
        await rt.start();
        return { ok: true, value: null };
      }
      case 'connection.disconnect': {
        const rt = this.runtimes.get(cmd.connectionId);
        if (!rt) return { ok: false, error: 'connection runtime missing' };
        await rt.stop();
        return { ok: true, value: null };
      }
      case 'point.write':
        return this.writePoint(cmd);
      case 'device.scan': {
        const rt = this.runtimes.get(cmd.connectionId);
        if (!rt) return { ok: false, error: 'connection runtime missing' };
        const found = await rt.scanUnits({ from: cmd.from, to: cmd.to }, 150);
        return { ok: true, value: found };
      }
      case 'device.temporaryRead': {
        const rt = this.runtimes.get(cmd.connectionId);
        if (!rt) return { ok: false, error: 'connection runtime missing' };
        const outcome = await rt.temporaryRead(cmd.unitId, cmd.area, cmd.start, cmd.quantity);
        return { ok: true, value: outcome };
      }
      case 'trend.startRecording':
        return this.startRecording(cmd.groupId);
      case 'trend.stopRecording':
        return this.stopRecording();
      case 'history.sessions':
        return { ok: true, value: this.history.listSessions() };
      case 'history.session':
        return { ok: true, value: this.history.getSession(cmd.sessionId) };
      case 'history.sessionData': {
        const detail = this.history.getSession(cmd.sessionId);
        if (!detail) return { ok: false, error: 'session not found' };
        return {
          ok: true,
          value: {
            detail,
            samples: this.history.readSamples(cmd.sessionId),
            events: this.history.readEvents(cmd.sessionId),
            rawComm: this.workspaceService.getPrefs().persistRawComm ? this.history.readRawComm(cmd.sessionId) : [],
          },
        };
      }
      case 'prefs.set': {
        const prefs = wsSvc.updatePrefs(cmd.patch as Partial<import('../services/workspace').Prefs>);
        return { ok: true, value: prefs };
      }
      case 'diagnostics.clear':
        this.diagnostics.clear();
        this.sentTxCount = 0;
        this.sentEventCount = 0;
        return { ok: true, value: null };
      default:
        return { ok: false, error: `unhandled command ${(cmd as { type: string }).type}` };
    }
  }

  private async writePoint(cmd: Extract<Command, { type: 'point.write' }>): Promise<CommandResult> {
    const index = this.pointIndex();
    const ref = index.get(cmd.pointId);
    if (!ref) return { ok: false, error: '点位不存在' };
    const rt = this.runtimes.get(ref.connection.id);
    if (!rt || rt.state !== 'online') return { ok: false, error: '连接不在线' };
    if (ref.point.access !== 'rw') return { ok: false, error: '点位为只读' };
    const m = ref.point.mapping;

    let rawValue: number | boolean | string;
    if (m.rawType === 'Bool') {
      if (cmd.boolValue === null) return { ok: false, error: 'Bool 点位需要布尔值' };
      rawValue = cmd.boolValue;
    } else if (m.rawType === 'String') {
      if (cmd.stringValue === null) return { ok: false, error: 'String 点位需要文本值' };
      rawValue = cmd.stringValue;
    } else if (Object.keys(ref.point.enumMap).length > 0 && cmd.engineering !== null) {
      rawValue = Math.round(cmd.engineering);
    } else {
      if (cmd.engineering === null) return { ok: false, error: '缺少工程值' };
      const conv = engineeringToRaw(cmd.engineering, { scale: ref.point.scale, offset: ref.point.offset }, m.rawType, m.bitWidth);
      if (!conv.ok) return { ok: false, error: conv.reason };
      rawValue = conv.value;
    }

    const outcome = await rt.writePoint({
      slave: ref.slave,
      block: ref.block,
      mapping: m,
      rawValue,
      pointId: ref.point.id,
      readBackRange: { start: ref.block.start, length: ref.block.length },
    });
    this.recordWriteEvent(`${ref.point.name} ← ${cmd.boolValue !== null ? cmd.boolValue : cmd.stringValue ?? cmd.engineering}`);
    this.healthDirty = true;
    if (outcome.result === 'ok') return { ok: true, value: { result: 'ok' } };
    if (outcome.result === 'exception') return { ok: true, value: { result: 'exception', exceptionCode: outcome.exceptionCode } };
    if (outcome.result === 'timeout') return { ok: true, value: { result: 'timeout' } };
    return { ok: true, value: { result: outcome.result } };
  }

  sessions(): SessionSummary[] {
    return this.history.listSessions();
  }

  sessionDetail(id: string): SessionDetail | null {
    return this.history.getSession(id);
  }
}