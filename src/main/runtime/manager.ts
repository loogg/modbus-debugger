import { CanvasSignals } from './canvas-signals';
import type { CanvasSignalState } from '../../domain/canvas-script';
import type { UpdateState } from '../../shared/update';
import fs from 'node:fs';
import { templateSchema, workspaceSchema } from '../../domain/model';
import { copyTemplate } from '../../domain/template-copy';
import { removeTemplateBlock, removeTemplatePoint } from '../../domain/template-edit';
import { mutateWorkspace } from '../../domain/workspace-mutations';
import { applyCanvasChanges } from '../../domain/canvas';
import { checkInputBinding, validateCanvasBindings } from '../../domain/canvas-binding';
import { BlockCache, blockKey } from './block-cache';
import { SampleBuffers } from './sample-buffers';
import { bufferCapacity, validateBufferBudget, withBufferConfigs } from '../../domain/point-buffers';
import { MAX_READ_SAMPLES, MAX_READ_SAMPLE_BYTES, type ColumnDataReadResult, type DataReadResult } from '../../shared/point-data';
import { sampleColumnBytes } from '../../shared/sample-columns';
import { canReadPoint, canWritePoint, mappingWidth, planBlockReads } from '../../domain/point-access';
import { scriptGraphBlocks, serializeScriptFile, type MasterScript, type ScriptPointRef } from '../../domain/master-script';
import { preparePointWrite } from '../../domain/point-write-value';
import { MasterScriptRunner, StepFailure, type ScriptPointBinding } from './master-script-runner';
import { ScriptRuns } from './script-runs';
import { loadScriptLua } from './script-lua-handle';
import { RuntimeNotifications } from './runtime-notifications';
import { scriptIsActive, type ScriptRunView } from '../../shared/script-run';
import type { PointWriteReceipt } from '../../shared/contracts';
import { ConnectionRuntime } from './connection-runtime';
import { SlaveRuntime } from './slave-runtime';
import { DiagnosticsStore, type ConnectionHealth } from './diagnostics';
import { SerialTransport, TcpTransport, type Transport } from './transport';
import { HistoryStore, type SessionDetail, type SessionSummary } from '../services/history';
import { exportTextToFile, WorkspaceService } from '../services/workspace';
import type { AppDelta, AppSnapshot, BlockViewState, ConnectionStateView, PointViewState, SlaveStateView } from '../../shared/snapshot';
import type { Command, CommandResult } from '../../shared/commands';
import type { BlockDef, ConnectionDef, DeviceTemplate, PointDef, SlaveDef } from '../../domain/model';
import { decodeRaw, type DecodedRaw } from '../../domain/mapping';
import { toEngineering } from '../../domain/scale';
import { formatEngineeringNumber } from '../../domain/point-format';
import { systemClock, type Clock } from '../../domain/protocol';
import { pointKey } from '../../shared/point-key';
import type { PointWriteResult } from '../../shared/contracts';

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
  if (config.transport === 'rtu' && config.rtu) return new SerialTransport(config.rtu, undefined, config.rtsControl);
  throw new Error(`connection ${config.name} has no transport settings`);
}

export class RuntimeManager {
  private readonly signals: CanvasSignals;
  private sentSignals?: CanvasSignalState;
  readonly cache = new BlockCache();
  readonly diagnostics = new DiagnosticsStore();
  readonly sampleBuffers: SampleBuffers;
  private readonly notifications = new RuntimeNotifications();
  private readonly scripts: ScriptRuns;
  private sentScriptRun: ScriptRunView | null = null;
  private runtimes = new Map<string, ConnectionRuntime | SlaveRuntime>();
  private shutdownByConnection = new Map<string, Promise<void>>();
  private stopping = false;
  private clock: Clock;
  private updateState: UpdateState | undefined;
  private updateRevision = 0;
  private sentUpdateRevision = 0;
  setUpdateState(state: UpdateState): void { this.updateState = state; this.updateRevision++; }

  private revision = 0;
  private diagRev = 0;
  private sentDiagRev = 0;
  private sentCacheRev = new Map<string, number>();
  private sentWorkspaceRev = -1;
  private workspaceRev = 0;
  private workspaceMetadataOnly = false;
  private connStateRev = 0;
  private connConfigHash = new Map<string, string>();
  /** Connections the user explicitly disconnected; survives runtime re-creation. */
  private userOffline = new Set<string>();
  private lastConnStates = new Map<string, ConnectionStateView>();
  private lastSlaveStates = new Map<string, SlaveStateView>();
  private pointIndexCache: { rev: number; map: Map<string, PointRef> } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private transportFactory: TransportFactory;

  private sessionsRev = 0;
  private warnings: string[] = [];

  constructor(
    readonly workspaceService: WorkspaceService,
    private history: HistoryStore,
    opts: { clock?: Clock; transportFactory?: TransportFactory } = {},
  ) {
    this.clock = opts.clock ?? systemClock;
    this.transportFactory = opts.transportFactory ?? defaultTransportFactory;
    this.sampleBuffers = new SampleBuffers(this.cache, this.clock);
    this.signals = new CanvasSignals(() => this.workspaceService.current, (event, pressId) => {
      if (event.binding.kind === 'workspace') this.notifications.publish(event.binding);
      return this.scripts.dispatch(event, pressId);
    });
    this.scripts = new ScriptRuns(() => new MasterScriptRunner({
      signals: this.signals, checkInput: binding => checkInputBinding(this.workspaceService.current, binding),
      point: (ref, access) => this.scriptPoint(ref, access),
      slave: id => this.scriptSlave(id),
      write: async (ref, fields, signal) => {
        signal.throwIfAborted();
        const result = await this.writePoint({ type: 'point.write', ...ref, ...fields }, signal);
        if (!result.ok) throw new StepFailure(result.error, ['not-sent']);
        return result.value;
      },
    }, new RuntimeNotifications(this.notifications)));
    this.cache.onConfirmed = (entry, range, origin) => {
      this.sampleBuffers.confirmed(entry, this.workspaceService.current, range);
      this.notifications.publish({ kind: 'sample', blockKey: entry.key, range, origin });
    };
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
    this.stopping = false;
    this.rebuildRuntimes();
    this.timer = setInterval(() => this.tick(), 100);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.scripts.stopAll();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const rt of this.runtimes.values()) await rt.stop();
    await Promise.all(this.shutdownByConnection.values());
    await this.scripts.settle();
    this.history.close();
    this.runtimes.clear();
    this.workspaceService.flushAutosave();
  }

  onDelta: ((delta: AppDelta) => void) | null = null;

  workspaceChanged(): void {
    this.scripts.stopAll();
    this.workspaceMetadataOnly = false;
    this.workspaceRev++;
    this.sentCacheRev.clear();
    this.rebuildRuntimes();
    this.workspaceService.scheduleAutosave();
    // Publish authoritative edits before the command resolves, so immediate follow-up actions use the new workspace.
    this.revision++;
    const delta = this.collectDelta();
    if (delta) this.onDelta?.(delta);
  }

  private publishWorkspaceMetadata(): void {
    this.sampleBuffers.reconcile(this.workspaceService.current);
    this.workspaceMetadataOnly = this.sentWorkspaceRev >= 0;
    this.workspaceRev++;
    this.revision++;
    const delta = this.collectDelta();
    if (delta) this.onDelta?.(delta);
  }

  private scheduleRuntimeStop(connectionId: string, runtime: ConnectionRuntime | SlaveRuntime): Promise<void> {
    const previous = this.shutdownByConnection.get(connectionId) ?? Promise.resolve();
    const shutdown = previous.catch(() => undefined).then(() => runtime.stop());
    this.shutdownByConnection.set(connectionId, shutdown);
    void shutdown.then(() => {
      if (this.shutdownByConnection.get(connectionId) === shutdown) this.shutdownByConnection.delete(connectionId);
    }, () => {
      if (this.shutdownByConnection.get(connectionId) === shutdown) this.shutdownByConnection.delete(connectionId);
    });
    return shutdown;
  }

  private rebuildRuntimes(): void {
    const ws = this.workspaceService.current;
    const bindings = this.pointIndex();
    for (const [key, ref] of bindings) {
      const identity = this.writeIdentity(ref);
      if (this.writeBindings.get(key)?.identity !== identity) this.writeBindings.set(key, { identity, epoch: ++this.writeBindingSequence });
    }
    for (const key of this.writeBindings.keys()) if (!bindings.has(key)) this.writeBindings.delete(key);
    this.sampleBuffers.reconcile(ws);
    for (const [key, record] of this.writeReceipts) {
      const current = this.pointIndex().get(key);
      if (!current || record.identity !== this.writeIdentity(current)) this.writeReceipts.delete(key);
    }
    const wanted = new Set(ws.connections.map((c) => c.id));
    for (const [id, rt] of [...this.runtimes.entries()]) {
      if (!wanted.has(id)) {
        void this.scheduleRuntimeStop(id, rt);
        this.runtimes.delete(id);
      }
    }
    for (const conn of ws.connections) {
      let rt = this.runtimes.get(conn.id);
      const configHash = JSON.stringify(conn);
      if (rt && this.connConfigHash.get(conn.id) !== configHash) {
        void this.scheduleRuntimeStop(conn.id, rt);
        this.runtimes.delete(conn.id);
        rt = undefined;
      }
      if (!rt) {
        this.connConfigHash.set(conn.id, configHash);
        const hooks = {
          onChange: () => { this.connStateRev++; },
          onState: () => { this.connStateRev++; },
          onSlaveStateChange: (slaveId: string) => this.notifications.publish({ kind: 'slaveState', slaveId }),
        };
        rt = conn.role === 'slave' ? new SlaveRuntime({ config: conn, cache: this.cache, diagnostics: this.diagnostics, clock: this.clock, hooks,
          serial: conn.transport === 'rtu' ? this.transportFactory(conn) : undefined,
        }) : new ConnectionRuntime({
          config: conn,
          transport: this.transportFactory(conn),
          cache: this.cache,
          diagnostics: this.diagnostics,
          clock: this.clock,
          hooks,
        });
        this.runtimes.set(conn.id, rt);
        // A runtime recreated after a config edit must honour an explicit disconnect:
        // it stays offline until the user presses 连接 again.
        if (conn.role !== 'slave' && !this.userOffline.has(conn.id)) {
          const nextRuntime = rt;
          const shutdown = this.shutdownByConnection.get(conn.id);
          const startIfCurrent = () => {
            if (!this.stopping && this.runtimes.get(conn.id) === nextRuntime && !this.userOffline.has(conn.id)) void nextRuntime.start();
          };
          if (shutdown) void shutdown.then(startIfCurrent, () => undefined);
          else startIfCurrent();
        }
      }
      const slaves = ws.slaves.filter(s => s.connectionId === conn.id);
      const targets = slaves.flatMap((slave) => {
        const template = ws.templates.find((t) => t.id === slave.templateId);
        if (!template) return [];
        return template.blocks.map((block) => ({ slave, block, readRanges: planBlockReads(block, template.points) }));
      });
      if (rt instanceof ConnectionRuntime) rt.configure(targets, slaves);
      else rt.configure(targets);
    }
    const validKeys = new Set(ws.slaves.flatMap(slave => (ws.templates.find(t => t.id === slave.templateId)?.blocks ?? []).map(block => blockKey(slave.id, block.id))));
    for (const entry of this.cache.all()) if (!validKeys.has(entry.key)) this.cache.remove(entry.slaveId, entry.block.id);
    this.sampleBuffers.reconcile(ws);
  }

  runtimeFor(connectionId: string): ConnectionRuntime | undefined {
    const rt = this.runtimes.get(connectionId);
    return rt instanceof ConnectionRuntime ? rt : undefined;
  }

  slaveRuntimeFor(connectionId: string): SlaveRuntime | undefined {
    const rt = this.runtimes.get(connectionId);
    return rt instanceof SlaveRuntime ? rt : undefined;
  }

  /* ---------------- point index & views ---------------- */

  /**
   * Every addressable point, keyed by point id. The workspace object is replaced (never
   * mutated in place) on each edit, so the map is cached against WorkspaceService.revision
   * rather than rebuilt ten times a second by the scheduler tick.
   */
  pointIndex(): Map<string, PointRef> {
    const rev = this.workspaceService.revision;
    const hit = this.pointIndexCache;
    if (hit && hit.rev === rev) return hit.map;
    const ws = this.workspaceService.current;
    const connById = new Map(ws.connections.map((c) => [c.id, c]));
    const tplById = new Map(ws.templates.map((t) => [t.id, t]));
    const map = new Map<string, PointRef>();
    for (const slave of ws.slaves) {
      const connection = connById.get(slave.connectionId);
      const template = tplById.get(slave.templateId);
      if (!connection || !template) continue;
      const byBlock = new Map<string, PointDef[]>();
      for (const point of template.points) {
        const list = byBlock.get(point.blockId);
        if (list) list.push(point);
        else byBlock.set(point.blockId, [point]);
      }
      for (const block of template.blocks) {
        for (const point of byBlock.get(block.id) ?? []) {
          map.set(pointKey(slave.id, point.id), { slave, block, point, template, connection });
        }
      }
    }
    this.pointIndexCache = { rev, map };
    return map;
  }

  private pointView(ref: PointRef): PointViewState {
    const key = blockKey(ref.slave.id, ref.block.id);
    const entry = this.cache.get(key);
    const lastWrite = this.receiptFor(ref);
    const base: PointViewState = {
      ...(lastWrite ? { lastWrite } : {}),
      pointId: ref.point.id,
      slaveId: ref.slave.id,
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
    if (!canReadPoint(ref.point) || !entry || !entry.lastUpdateUtc || entry.status === 'idle' || entry.status === 'disabled' || !this.cache.mappingValid(entry, ref.point.mapping)) return base;
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
    view.engText = formatEngineeringNumber(eng, ref.point.decimalPlaces);
    if (ref.point.displayFormat === 'hex' && Number.isFinite(eng)) view.engText = view.rawText;
    return view;
  }

  private blockView(key: string, includeMemory = true): BlockViewState | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    return {
      key,
      ...(includeMemory ? { valid: [...entry.valid] } : {}),
      slaveId: entry.slaveId,
      registers: includeMemory && entry.lastUpdateUtc && entry.memory.kind === 'registers' ? Array.from(entry.memory.registers) : undefined,
      bits: includeMemory && entry.lastUpdateUtc && entry.memory.kind === 'bits' ? [...entry.memory.bits] : undefined,
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
      out[conn.id] = {
        state: rt?.state ?? 'offline',
        detail: rt?.detail ?? null,
        lastResponseUtc: this.diagnostics.lastOkUtcFor(conn.id),
        scan: rt instanceof ConnectionRuntime ? rt.scan : null,
        clientCount: rt instanceof SlaveRuntime ? rt.clientCount : undefined,
      };
    }
    return out;
  }

  private slaveViews(): Map<string, SlaveStateView> {
    const states = new Map<string, SlaveStateView>();
    for (const slave of this.workspaceService.current.slaves) {
      const runtime = this.runtimes.get(slave.connectionId);
      if (runtime instanceof ConnectionRuntime) {
        states.set(slave.id, runtime.slaveState(slave));
      } else {
        const listener = runtime?.state;
        const state = !slave.enabled ? 'disabled' : listener === 'online' || listener === 'connecting' ? listener : 'offline';
        states.set(slave.id, { state, lastResponseUtc: null });
      }
    }
    return states;
  }

  /* ---------------- snapshot / delta ---------------- */

  private snapshotPrimed = false;

  buildSnapshot(options?: { includeDiagnostics?: boolean }): AppSnapshot {
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
    // Match block revisions to the initial snapshot. Diagnostic readers own their cursors.
    if (!this.snapshotPrimed) {
      for (const entry of this.cache.all()) this.sentCacheRev.set(entry.key, entry.revision);
    }
    const snapshot: AppSnapshot = {
      revision: this.revision,
      update: this.updateState,
      scriptRun: this.scripts.lastRun, scriptRuns: this.scripts.snapshots(), canvasSignals: this.signals.snapshot,
      workspace: ws,
      workspacePath: this.workspaceService.currentPath,
      dirty: this.workspaceService.isDirty(),
      connections: this.connectionViews(),
      slaveStates: Object.fromEntries(this.slaveViews()),
      blocks,
      points,
      transactions: options?.includeDiagnostics === false ? [] : this.diagnostics.recentTransactions(500),
      parseEvents: options?.includeDiagnostics === false ? [] : this.diagnostics.recentParseEvents(200),
      diagRev: this.diagRev,
      health,
      sessions: this.history.listSessions(),
      warnings: this.warnings,
      prefs: this.workspaceService.getPrefs(),
      historyDbPath: this.history.dbPath,
    };
    // Align the prefs/dirty trackers with the snapshot so the first tick does not re-emit them.
    if (!this.snapshotPrimed) {
      this.sentPrefsRev = this.workspaceService.prefsRevision;
      this.sentDirty = snapshot.dirty;
      this.snapshotPrimed = true;
    }
    return snapshot;
  }

  /**
   * Health is recomputed at most once per second per connection and each recomputation is
   * recorded as a trend sample, so the 连接健康 chart shows real measurements rather than
   * a placeholder series.
   */
  healthForCached(connectionId: string): ConnectionHealth {
    const now = Date.now();
    const hit = this.healthCache.get(connectionId);
    if (hit && now - hit.at < 1000) return hit.health;
    const health = this.healthFor(connectionId);
    this.healthCache.set(connectionId, { at: now, health });
    this.diagnostics.recordHealthSample(connectionId, {
      t: now,
      busLoadPercent: health.busLoadPercent,
      p95Ms: health.p95Ms,
      requestRatePerSec: health.requestRatePerSec,
      throughputBytesPerSec: health.throughputBytesPerSec,
    });
    return health;
  }

  healthFor(connectionId: string): ConnectionHealth {
    const ws = this.workspaceService.current;
    const blocks: Array<{ slaveId: string; unitId: number; blockId: string; blockName: string; configuredPeriodMs: number }> = [];
    for (const slave of ws.slaves.filter((s) => s.connectionId === connectionId && ws.connections.find(connection => connection.id === connectionId)?.role !== 'slave')) {
      const template = ws.templates.find((t) => t.id === slave.templateId);
      if (!template) continue;
      for (const b of template.blocks) blocks.push({ slaveId: slave.id, unitId: slave.unitId, blockId: b.id, blockName: b.name, configuredPeriodMs: b.periodMs });
    }
    return this.diagnostics.health(connectionId, this.clock.now(), blocks, 60, ws.connections.find(connection => connection.id === connectionId));
  }

  private tick(): void {
    this.diagnostics.pruneHealth(this.clock.now());
    this.sampleBuffers.expire(this.workspaceService.current);
    this.checkWarnings();
    const delta = this.collectDelta();
    if (delta && this.onDelta) this.onDelta(delta);
  }

  private collectDelta(): AppDelta | null {
    const delta: AppDelta = { revision: this.revision };
    let changed = false;
    if (this.updateRevision !== this.sentUpdateRevision) {
      delta.update = this.updateState; this.sentUpdateRevision = this.updateRevision; changed = true;
    }
    const changes = this.scripts.delta();
    if (this.sentSignals !== this.signals.snapshot) {
      this.sentSignals = delta.canvasSignals = this.signals.snapshot;
      changed = true;
    }
    if (changes) { delta.scriptRuns = changes; changed = true; }
    const scriptRun = this.scripts.lastRun;
    if (scriptRun !== this.sentScriptRun) {
      delta.scriptRun = scriptRun;
      this.sentScriptRun = scriptRun;
      changed = true;
    }
    const ws = this.workspaceService.current;
    if (this.workspaceRev !== this.sentWorkspaceRev) {
      delta.workspace = ws;
      if (this.workspaceMetadataOnly) delta.workspaceMetadataOnly = true;
      this.workspaceMetadataOnly = false;
      delta.workspacePath = this.workspaceService.currentPath;
      this.sentWorkspaceRev = this.workspaceRev;
      changed = true;
    }
    const connViews = this.connectionViews();
    const connChanged = Object.entries(connViews).some(([id, v]) => {
      const prev = this.lastConnStates.get(id);
      return !prev || prev.state !== v.state || prev.detail !== v.detail || prev.clientCount !== v.clientCount || prev.lastResponseUtc !== v.lastResponseUtc || prev.scan !== v.scan;
    });
    if (connChanged || this.lastConnStates.size !== Object.keys(connViews).length) {
      delta.connections = connViews;
      this.lastConnStates = new Map(Object.entries(connViews));
      changed = true;
    }
    const slaveViews = this.slaveViews();
    const slaveChanges = new Map<string, SlaveStateView | null>();
    for (const [id, view] of slaveViews) {
      const before = this.lastSlaveStates.get(id);
      if (before?.state !== view.state || before.lastResponseUtc !== view.lastResponseUtc) slaveChanges.set(id, view);
    }
    for (const id of this.lastSlaveStates.keys()) {
      if (!slaveViews.has(id)) slaveChanges.set(id, null);
    }
    if (slaveChanges.size) {
      delta.slaveStates = Object.fromEntries(slaveChanges);
      this.lastSlaveStates = slaveViews;
      changed = true;
    }
    const blocks: Record<string, BlockViewState> = {};
    for (const entry of this.cache.all()) {
      if ((this.sentCacheRev.get(entry.key) ?? -1) !== entry.revision) {
        const v = this.blockView(entry.key, false);
        if (v) blocks[entry.key] = v;
        this.sentCacheRev.set(entry.key, entry.revision);
        changed = true;
      }
    }
    if (Object.keys(blocks).length) delta.blocks = blocks;

    if (this.pendingWrites.size) {
      delta.pointWrites = Object.fromEntries([...this.pendingWrites].filter(([key]) => this.writeReceipts.has(key)));
      this.pendingWrites.clear();
      changed = true;
    }
    if (this.healthDirty) {
      const health: Record<string, ConnectionHealth> = {};
      for (const conn of ws.connections) {
        health[conn.id] = this.healthForCached(conn.id);
        // Record the cache generation as delivered, otherwise the next tick re-emits it.
        this.healthEmittedAt.set(conn.id, this.healthCache.get(conn.id)?.at ?? 0);
      }
      delta.health = health;
      this.healthDirty = false;
      changed = true;
    } else {
      const fresh: Record<string, ConnectionHealth> = {};
      let any = false;
      for (const conn of ws.connections) {
        const h = this.healthForCached(conn.id);
        const cachedAt = this.healthCache.get(conn.id)?.at ?? 0;
        if ((this.healthEmittedAt.get(conn.id) ?? -1) === cachedAt) continue;
        this.healthEmittedAt.set(conn.id, cachedAt);
        fresh[conn.id] = h;
        any = true;
      }
      if (any) {
        delta.health = fresh;
        changed = true;
      }
    }
    if (this.diagRev !== this.sentDiagRev) {
      delta.diagRev = this.diagRev;
      this.sentDiagRev = this.diagRev;
      changed = true;
    }
    if (this.sessionsRev !== this.sentSessionsRev) {
      delta.sessions = this.history.listSessions();
      this.sentSessionsRev = this.sessionsRev;
      changed = true;
    }
    // prefs, dirty and warnings live in Main and change independently of the workspace
    // revision, so each needs its own change tracking. Without these the renderer kept the
    // values from the initial snapshot forever: 时区 / 语言 changes were written to prefs.json
    // but never reached the store, and the unsaved-workspace flag never updated.
    if (this.workspaceService.prefsRevision !== this.sentPrefsRev) {
      this.sentPrefsRev = this.workspaceService.prefsRevision;
      delta.prefs = this.workspaceService.getPrefs();
      changed = true;
    }
    const dirty = this.workspaceService.isDirty();
    if (dirty !== this.sentDirty) {
      this.sentDirty = dirty;
      delta.dirty = dirty;
      changed = true;
    }
    if (this.warningsDirty) {
      this.warningsDirty = false;
      delta.warnings = this.warnings;
      changed = true;
    }
    if (!changed) return null;
    this.revision++;
    delta.revision = this.revision;
    return delta;
  }

  private healthDirty = true;
  private healthCache = new Map<string, { at: number; health: ConnectionHealth }>();
  private lastWarnCheck = 0;
  private sentSessionsRev = -1;
  private sentPrefsRev = -1;
  private sentDirty: boolean | null = null;
  private warningsDirty = false;

  private healthEmittedAt = new Map<string, number>();

  private checkWarnings(): void {
    const now = Date.now();
    if (now - this.lastWarnCheck < 5000) return;
    this.lastWarnCheck = now;
    const warnings: string[] = [];
    if (this.workspaceService.lastPathWarning) warnings.push(this.workspaceService.lastPathWarning);
    if (this.history.overTenGb()) warnings.push(`history.db 已超过 10 GB（当前 ${(this.history.sizeBytes() / 1e9).toFixed(1)} GB），请考虑归档。`);
    const ws = this.workspaceService.current;
    for (const conn of ws.connections) {
      const h = this.healthForCached(conn.id);
      if (h.busLoadPercent > 80) warnings.push(`连接 ${conn.name} 总线负载 ${h.busLoadPercent.toFixed(0)}%，请调整数据块周期。`);
    }
    if (JSON.stringify(warnings) !== JSON.stringify(this.warnings)) {
      this.warnings = warnings;
      this.healthDirty = true;
      this.warningsDirty = true;
    }
  }

  /* ---------------- commands ---------------- */

  async handleCommand(cmd: Command): Promise<CommandResult> {
    const wsSvc = this.workspaceService;
    switch (cmd.type) {
      case 'data.demand':
        this.sampleBuffers.setDemand(cmd.clientId, cmd.points, wsSvc.current);
        return { ok: true, value: null };
      case 'data.read': {
        const queryIds = cmd.series.flatMap(query => query.queryId ? [query.queryId] : []);
        if (new Set(queryIds).size !== queryIds.length) return { ok: false, error: '曲线查询 ID 重复' };
        const result: DataReadResult = { checkedAtMs: Date.now(), points: {}, blocks: {}, series: {}, buffers: {} };
        const index = this.pointIndex();
        for (const requested of cmd.points) {
          const key = pointKey(requested.slaveId, requested.pointId);
          const ref = index.get(key);
          if (!ref) continue;
          result.points[key] = this.pointView(ref);
          const block = this.blockView(blockKey(ref.slave.id, ref.block.id), false);
          if (block && !result.blocks[block.key]) result.blocks[block.key] = block;
        }
        for (const requested of cmd.blocks) {
          const block = this.blockView(blockKey(requested.slaveId, requested.blockId));
          if (block) result.blocks[block.key] = block;
        }
        const share = Math.max(1, Math.floor(MAX_READ_SAMPLES / Math.max(1, cmd.series.length)));
        if (cmd.format === 'columns-v1') {
          const columns: ColumnDataReadResult = { ...result, format: 'columns-v1', series: {}, buffers: {}, sampleBytes: 0 };
          for (const ref of cmd.buffers) columns.buffers[pointKey(ref.slaveId, ref.pointId)] = this.sampleBuffers.infoColumns(ref);
          const requests = [...new Map(cmd.series.map(request => [request.queryId ?? pointKey(request.slaveId, request.pointId), request])).entries()];
          const budget = cmd.sampleBytes ?? MAX_READ_SAMPLE_BYTES;
          let remainingSamples = MAX_READ_SAMPLES;
          for (let index = 0; index < requests.length; index++) {
            const [key, request] = requests[index]!;
            const remaining = requests.length - index;
            const page = this.sampleBuffers.readColumns(request, Math.max(1, Math.floor(remainingSamples / remaining)), Math.floor((budget - columns.sampleBytes) / remaining), budget - columns.sampleBytes);
            columns.series[key] = page;
            columns.sampleBytes += sampleColumnBytes(page.columns);
            remainingSamples -= page.columns.times.length;
          }
          return { ok: true, value: columns };
        }
        for (const request of cmd.series) {
          const key = request.queryId ?? pointKey(request.slaveId, request.pointId);
          if (!result.series[key]) result.series[key] = this.sampleBuffers.read(request, share);
        }
        for (const ref of cmd.buffers) result.buffers[pointKey(ref.slaveId, ref.pointId)] = this.sampleBuffers.info(ref);
        return { ok: true, value: result };
      }
      case 'buffer.configure': {
        const current = bufferCapacity(wsSvc.current, cmd.config);
        if (cmd.expectedCapacity !== undefined && cmd.expectedCapacity !== current) return { ok: false, error: '共享缓冲容量已被其他页面修改，请重新确认当前容量' };
        wsSvc.set(workspaceSchema.parse(withBufferConfigs(wsSvc.current, [cmd.config])));
        const saved = wsSvc.saveManaged();
        this.publishWorkspaceMetadata();
        if (!saved.ok) return { ok: false, error: `容量已更新，但工作区保存失败：${saved.error}` };
        return { ok: true, value: this.sampleBuffers.info(cmd.config) };
      }
      case 'buffer.export':
        return { ok: true, value: await this.sampleBuffers.exportCsv(cmd.points, cmd.path, cmd.startMs, cmd.endMs) };
      case 'workbench.saveLayout':
        wsSvc.set({ ...wsSvc.current, schemaVersion: 2, workbench: cmd.layout });
        this.publishWorkspaceMetadata();
        return { ok: true, value: null };
      case 'canvas.interact': {
        try { return { ok: true, value: this.signals.interact(cmd) }; }
        catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      }
      case 'variable.save':
      case 'variable.delete': {
        try {
          const variables = wsSvc.current.variables ?? [];
          const id = cmd.type === 'variable.save' ? cmd.variable.id : cmd.expected.id;
          const current = variables.find(v => v.id === id) ?? null;
          if (JSON.stringify(current) !== JSON.stringify(cmd.expected)) throw new Error('工作区变量已在其他页面修改，请重试');
          if (cmd.type === 'variable.save' && current && current.type !== cmd.variable.type) throw new Error('已有变量的类型不能更改');
          if (cmd.type === 'variable.delete' && (wsSvc.current.canvases?.some(c => c.widgets.some(w => w.binding && 'variableId' in w.binding && w.binding.variableId === id))
            || wsSvc.current.masterScripts?.some(s => [...scriptGraphBlocks(s.graph)].some(b => b.fields?.TAG === id)))) throw new Error('变量仍被画布或脚本引用，请先更换绑定');
          const next = cmd.type === 'variable.delete' ? variables.filter(v => v.id !== id)
            : current ? variables.map(v => v.id === id ? cmd.variable : v) : [...variables, cmd.variable];
          const liveValue = current ? this.signals.read(id) : undefined;
          const result = wsSvc.saveManaged({ ...wsSvc.current, variables: next });
          if (!result.ok) throw new Error(result.error ?? '保存工作区变量失败');
          this.signals.definitionChanged(id, cmd.type === 'variable.delete' ? undefined : liveValue);
          this.scripts.recheckInputs();
          this.publishWorkspaceMetadata();
          return { ok: true, value: null };
        } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      }
      case 'script.save':
      case 'script.delete': {
        try {
          const scripts = wsSvc.current.masterScripts ?? [];
          const scriptId = cmd.type === 'script.save' ? cmd.script.id : cmd.scriptId;
          const current = scripts.find(script => script.id === scriptId);
          if ((current?.revision ?? null) !== cmd.expectedRevision) return { ok: false, error: '流程已在其他页面修改，请重新打开后编辑' };
          if (cmd.type === 'script.delete' && scriptIsActive(this.scripts.forScript(scriptId)?.snapshot))
            return { ok: false, error: '请先停止该流程再删除' };
          let saved: MasterScript | null = null;
          let next = scripts.filter(script => script.id !== scriptId);
          if (cmd.type === 'script.save') {
            saved = { ...current, ...cmd.script, revision: current ? current.revision + 1 : 0 };
            next = current ? scripts.map(script => script.id === scriptId ? saved! : script) : [...scripts, saved];
          }
          const result = wsSvc.saveManaged({ ...wsSvc.current, schemaVersion: 2, masterScripts: next });
          if (!result.ok) return { ok: false, error: result.error ?? '保存流程失败' };
          if (cmd.type === 'script.delete') this.scripts.remove(scriptId);
          this.publishWorkspaceMetadata();
          return { ok: true, value: saved ? wsSvc.current.masterScripts!.find(item => item.id === scriptId)! : null };
        } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      }
      case 'script.plan':
      case 'script.start': {
        const epoch = this.scripts.epoch;
        if (cmd.type === 'script.start') {
          try { await loadScriptLua(); } catch (error) { return { ok: false, error: `Lua 初始化失败 · ${String(error)}` }; }
          if (this.stopping || epoch !== this.scripts.epoch) return { ok: false, error: '工作区已切换或正在停止' };
        }
        const script = wsSvc.current.masterScripts?.find(item => item.id === cmd.scriptId);
        if (!script || script.revision !== cmd.revision) return { ok: false, error: '流程已变更，请重新保存后运行' };
        try {
          if (cmd.type === 'script.plan') return { ok: true, value: this.scripts.plan(script) };
          return { ok: true, value: this.scripts.start(script, cmd.approval, cmd.debug) };
        } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      }
      case 'script.pause':
        return this.scripts.forRun(cmd.runId)?.pause(cmd.runId) ? { ok: true, value: null } : { ok: false, error: '流程当前无法暂停' };
      case 'script.resume':
        return this.scripts.forRun(cmd.runId)?.resume(cmd.runId, cmd.token, cmd.mode) ? { ok: true, value: null } : { ok: false, error: '本次暂停已结束' };
      case 'script.breakpoint':
        return this.scripts.forRun(cmd.runId)?.setBreakpoint(cmd.runId, cmd.blockId, cmd.enabled) ? { ok: true, value: null } : { ok: false, error: '此步骤不在当前运行的流程中' };
      case 'script.stop':
        this.scripts.forRun(cmd.runId)?.stop(cmd.runId);
        return { ok: true, value: null };
      case 'script.confirmWrite':
        return this.scripts.forRun(cmd.runId)?.confirmWrite(cmd.runId, cmd.token)
          ? { ok: true, value: null } : { ok: false, error: '本次写入确认已失效' };
      case 'script.exportFile': {
        const script = wsSvc.current.masterScripts?.find(item => item.id === cmd.scriptId);
        if (!script) return { ok: false, error: '流程已不存在' };
        const result = exportTextToFile(cmd.path, serializeScriptFile(script));
        return result.ok ? { ok: true, value: result.path } : { ok: false, error: result.error ?? '导出流程失败' };
      }
      case 'canvas.create':
      case 'canvas.edit':
      case 'canvas.delete': {
        try {
          let canvases = wsSvc.current.canvases ?? [];
          if (cmd.type === 'canvas.create') {
            if (canvases.some(c => c.id === cmd.canvas.id)) throw new Error('画布 ID 已存在');
            validateCanvasBindings(wsSvc.current, cmd.canvas.widgets);
            canvases = [...canvases, { ...cmd.canvas, revision: 0 }];
          } else {
            const current = canvases.find(c => c.id === cmd.canvasId);
            if (!current) throw new Error('画布已删除，当前草稿仍保留');
            if (current.revision !== cmd.expectedRevision) throw new Error('画布已在其他页面修改。草稿已保留，请重新载入最新版本后再编辑。');
            if (cmd.type === 'canvas.delete') canvases = canvases.filter(c => c.id !== cmd.canvasId);
            else {
              // Existing broken references remain visible and repairable after template edits.
              validateCanvasBindings(wsSvc.current, cmd.changes.upsertWidgets.filter(w => {
                const old = current.widgets.find(x => x.id === w.id);
                return !old || old.kind !== w.kind || old.inputMode !== w.inputMode || JSON.stringify(old.binding) !== JSON.stringify(w.binding) || JSON.stringify(old.signals) !== JSON.stringify(w.signals);
              }));
              const changed = applyCanvasChanges(current, cmd.expectedRevision, cmd.changes);
              canvases = canvases.map(c => c.id === changed.id ? changed : c);
            }
          }
          const next = workspaceSchema.parse({ ...wsSvc.current, schemaVersion: 2, canvases });
          validateBufferBudget(next, wsSvc.current);
          const previous = wsSvc.current.canvases ?? [];
          const saved = wsSvc.saveManaged(next);
          if (!saved.ok) return { ok: false, error: saved.error ?? '保存画布失败' };
          if (cmd.type !== 'canvas.create') {
            const old = previous.find(c => c.id === cmd.canvasId);
            const current = canvases.find(c => c.id === cmd.canvasId);
            for (const widget of old?.widgets ?? []) {
              const after = current?.widgets.find(w => w.id === widget.id);
              if (!after || after.kind !== widget.kind || after.inputMode !== widget.inputMode || JSON.stringify(after.binding) !== JSON.stringify(widget.binding))
                this.signals.forgetControl(cmd.canvasId, widget.id);
            }
            this.scripts.recheckInputs();
          }
          this.publishWorkspaceMetadata();
          return { ok: true, value: canvases };
        } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      }
      case 'template.save': {
        const template = wsSvc.current.templates.find(t => t.id === cmd.templateId);
        if (!template || (cmd.blockId !== undefined && !template.blocks.some(b => b.id === cmd.blockId))) return {ok:false,error:'模板或数据块不存在'};
        const result = wsSvc.saveManaged();
        if (result.ok) this.workspaceRev++;
        return result.ok ? {ok:true,value:result.path} : {ok:false,error:result.error ?? '保存失败'};
      }
      case 'template.rename': {
        if (!wsSvc.current.templates.some(t => t.id === cmd.templateId)) return {ok:false,error:'模板不存在'};
        if (cmd.expectedName !== undefined && wsSvc.current.templates.find(t => t.id === cmd.templateId)?.name !== cmd.expectedName) return { ok: false, error: '模板名称已被其他页面修改，请重新载入后编辑。' };
        wsSvc.set(workspaceSchema.parse({...wsSvc.current,templates:wsSvc.current.templates.map(t => t.id === cmd.templateId ? {...t,name:cmd.name} : t)}));
        this.workspaceChanged();
        return {ok:true,value:null};
      }
      case 'template.deleteBlock': {
        try { wsSvc.set(workspaceSchema.parse(removeTemplateBlock(wsSvc.current,cmd.templateId,cmd.blockId)));this.workspaceChanged();return {ok:true,value:null}; }
        catch(error){return {ok:false,error:String(error)};}
      }
      case 'template.deletePoint': {
        try { wsSvc.set(workspaceSchema.parse(removeTemplatePoint(wsSvc.current,cmd.templateId,cmd.pointId)));this.workspaceChanged();return {ok:true,value:null}; }
        catch(error){return {ok:false,error:String(error)};}
      }
      case 'template.importFile': {
        try {
          const parsed = templateSchema.parse(JSON.parse(fs.readFileSync(cmd.path, 'utf8')));
          const template = copyTemplate(parsed, `tpl-${Date.now().toString(36)}`, parsed.name);
          wsSvc.set(workspaceSchema.parse({ ...wsSvc.current, templates: [...wsSvc.current.templates, template] }));
          this.workspaceChanged();
          return { ok: true, value: template.id };
        } catch (error) { return { ok: false, error: String(error) }; }
      }
      case 'history.addNote': {
        const session = this.history.getSession(cmd.sessionId);
        if (!session) return { ok: false, error: 'session not found' };
        const duration = Math.max(0, new Date(session.endUtc ?? new Date().toISOString()).getTime() - new Date(session.startUtc).getTime());
        if (cmd.tMs > duration) return { ok: false, error: 'Note is outside the session' };
        this.history.addNote(cmd.sessionId, cmd.tMs, cmd.text);
        this.sessionsRev++;
        return { ok: true, value: null };
      }
      case 'workspace.new':
        this.scripts.clear();
        this.signals.reset();
        this.sampleBuffers.reset();
        wsSvc.newWorkspace();
        this.workspaceChanged();
        return { ok: true, value: null };
      case 'workspace.open': {
        const res = wsSvc.loadFrom(cmd.path);
        if (!res.ok) return { ok: false, error: res.error ?? 'open failed' };
        this.scripts.clear();
        this.signals.reset();
        this.sampleBuffers.reset();
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
      case 'workspace.exportFile': {
        const res = wsSvc.exportToFile(cmd.path);
        return res.ok ? { ok: true, value: res.path } : { ok: false, error: res.error ?? 'export failed' };
      }
      case 'workspace.importText': {
        const res = wsSvc.importFromBuffer(cmd.text);
        if (!res.ok || !res.workspace) return { ok: false, error: res.error ?? 'import failed' };
        wsSvc.adopt(res.workspace, null);
        this.scripts.clear();
        this.signals.reset();
        this.sampleBuffers.reset();
        this.workspaceChanged();
        return { ok: true, value: null };
      }
      case 'workspace.apply':
        wsSvc.set(cmd.workspace);
        this.scripts.clear();
        this.signals.reset();
        this.sampleBuffers.reset();
        this.workspaceChanged();
        return { ok: true, value: null };
      case 'connection.upsert':
      case 'slave.upsert':
      case 'template.add':
      case 'template.copy':
      case 'template.upsertBlock':
      case 'template.patchBlock':
      case 'template.importContent':
      case 'template.upsertPoint':
      case 'trend.upsertGroup':
      case 'trend.deleteGroup':
      case 'trend.addSignals':
      case 'trend.removeSignal':
      case 'trend.setSignalVisible':
      case 'trend.setWindow':
        try {
          let next = mutateWorkspace(wsSvc.current, cmd);
          if (cmd.type === 'trend.addSignals' && cmd.buffers) next = workspaceSchema.parse(withBufferConfigs(next, cmd.buffers, wsSvc.current));
          if (cmd.type.startsWith('trend.')) validateBufferBudget(next, wsSvc.current);
          wsSvc.set(next);
          if (cmd.type.startsWith('trend.')) { wsSvc.scheduleAutosave(); this.publishWorkspaceMetadata(); }
          else this.workspaceChanged();
          return { ok: true, value: null };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      case 'connection.connect': {
        if (!this.runtimes.has(cmd.connectionId)) return { ok: false, error: 'connection runtime missing' };
        this.userOffline.delete(cmd.connectionId);
        // A config edit may have replaced the runtime while its old serial port is
        // still closing. Never let a manual connect bypass that shutdown barrier.
        while (this.shutdownByConnection.has(cmd.connectionId)) {
          await this.shutdownByConnection.get(cmd.connectionId);
        }
        if (this.stopping) return { ok: false, error: 'runtime manager is stopping' };
        const rt = this.runtimes.get(cmd.connectionId);
        if (!rt) return { ok: false, error: 'connection runtime missing' };
        if (rt instanceof SlaveRuntime || rt.state === 'offline' || rt.state === 'error') await rt.start();
        if (rt.state === 'error') return { ok: false, error: rt.detail ?? '连接或启动失败' };
        return { ok: true, value: null };
      }
      case 'connection.disconnect': {
        const rt = this.runtimes.get(cmd.connectionId);
        if (!rt) return { ok: false, error: 'connection runtime missing' };
        // Remember the intent: a later config edit recreates the runtime, and the new
        // instance must stay offline until the user connects again.
        this.userOffline.add(cmd.connectionId);
        await rt.stop();
        return { ok: true, value: null };
      }
      case 'point.write':
        return this.writePoint(cmd);
      case 'slave.setValues': {
        const slave = wsSvc.current.slaves.find(item => item.id === cmd.slaveId);
        const rt = slave && this.slaveRuntimeFor(slave.connectionId);
        if (!rt) return { ok: false, error: '此操作仅适用于本机从站' };
        try { rt.setValues(cmd.slaveId, cmd.blockId, cmd.offset, cmd.values); const delta = this.collectDelta(); if (delta) this.onDelta?.(delta); return { ok: true, value: null }; }
        catch (error) { return { ok: false, error: String(error) }; }
      }
      case 'slave.saveInitialValues': {
        const slave = wsSvc.current.slaves.find(item => item.id === cmd.slaveId);
        const rt = slave && this.slaveRuntimeFor(slave.connectionId);
        if (!rt || !slave) return { ok: false, error: '此操作仅适用于本机从站' };
        wsSvc.set(mutateWorkspace(wsSvc.current, { type: 'slave.upsert', slave: { ...slave, initialValues: rt.initialValues(slave.id) } }));
        const saved = wsSvc.saveManaged();
        this.workspaceChanged();
        return saved.ok ? { ok: true, value: null } : { ok: false, error: saved.error ?? '初始值保存失败' };
      }
      case 'device.scan': {
        const rt = this.runtimes.get(cmd.connectionId);
        if (!rt) return { ok: false, error: 'connection runtime missing' };
        if (!(rt instanceof ConnectionRuntime)) return { ok: false, error: '从站连接不执行主站扫描' };
        const found = await rt.scanUnits({ from: cmd.from, to: cmd.to }, cmd.options);
        return { ok: true, value: found };
      }
      case 'device.temporaryRead': {
        const rt = this.runtimes.get(cmd.connectionId);
        if (!rt) return { ok: false, error: 'connection runtime missing' };
        if (!(rt instanceof ConnectionRuntime)) return { ok: false, error: '从站连接不执行临时读取' };
        const outcome = await rt.temporaryRead(cmd.unitId, cmd.area, cmd.start, cmd.quantity);
        return { ok: true, value: outcome };
      }
      case 'device.stopScan': {
        const rt = this.runtimes.get(cmd.connectionId);
        if (!rt) return { ok: false, error: 'connection runtime missing' };
        if (!(rt instanceof ConnectionRuntime)) return { ok: false, error: '从站连接不执行主站扫描' };
        rt.stopScan();
        return { ok: true, value: null };
      }
      case 'device.refresh': {
        const slave = wsSvc.current.slaves.find(s => s.id === cmd.slaveId);
        const rt = slave ? this.runtimes.get(slave.connectionId) : undefined;
        if (!rt) return { ok: false, error: 'connection runtime missing' };
        if (!(rt instanceof ConnectionRuntime)) return { ok: false, error: '本机从站使用实际内存，不执行轮询刷新' };
        await rt.refresh(cmd.slaveId, cmd.blockId);
        return { ok: true, value: null };
      }
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
            rawComm: this.history.readRawComm(cmd.sessionId),
          },
        };
      }
      case 'prefs.set': {
        const prefs = wsSvc.updatePrefs(cmd.patch as Partial<import('../services/workspace').Prefs>);
        return { ok: true, value: prefs };
      }
      case 'diagnostics.healthSeries':
        return { ok: true, value: this.diagnostics.healthSeriesFor(cmd.connectionId, cmd.windowMs) };
      case 'diagnostics.clear':
        this.diagnostics.clear();
        this.healthCache.clear();
        this.healthDirty = true;
        this.diagRev += 1;
        return { ok: true, value: null };
      case 'diagnostics.read':
        return { ok: true, value: this.diagnostics.read(cmd) };
      default:
        return { ok: false, error: `unhandled command ${(cmd as { type: string }).type}` };
    }
  }

  private scriptSlave(slaveId: string) {
    const workspace = this.workspaceService.current;
    const slave = workspace.slaves.find(item => item.id === slaveId);
    const connection = workspace.connections.find(item => item.id === slave?.connectionId);
    if (!slave || !connection || connection.role === 'slave') throw new Error('请选择工作区中的主站从站');
    return {
      label: `${connection.name} / ${slave.name} (Unit ${slave.unitId})`,
      state: () => this.runtimeFor(connection.id)?.slaveState(slave).state ?? (slave.enabled ? 'offline' : 'disabled'),
    };
  }

  private scriptPoint(reference: ScriptPointRef, access: 'read' | 'write'): ScriptPointBinding {
    const ref = this.pointIndex().get(pointKey(reference.slaveId, reference.pointId));
    if (!ref || ref.slave.id !== reference.slaveId || ref.point.id !== reference.pointId || ref.connection.role === 'slave') throw new Error('积木绑定的主站点位已失效，请重新选择');
    const label = `${ref.connection.name} / ${ref.slave.name} (Unit ${ref.slave.unitId}) / ${ref.point.name}`;
    if (!ref.slave.enabled) throw new Error(`${label} · 从站已停用`);
    if (access === 'read' ? !canReadPoint(ref.point) : !canWritePoint(ref.point)) {
      throw new Error(`${label} · ${access === 'read' ? '点位为只写' : '点位为只读'}`);
    }
    const key = blockKey(ref.slave.id, ref.block.id);
    const span = { offset: ref.point.mapping.offset, length: mappingWidth(ref.block.area, ref.point.mapping) };
    return {
      ref: reference, blockKey: key, label, span, type: ref.point.mapping.rawType, highRisk: ref.point.highRisk,
      identity: JSON.stringify([this.writeIdentity(ref), label, this.writeBindings.get(pointKey(reference.slaveId, reference.pointId))?.epoch]),
      validateWrite: fields => { preparePointWrite(ref.point, fields); },
      read: () => {
        if (this.runtimeFor(ref.connection.id)?.state !== 'online') return { detail: '连接离线' };
        const failure = this.cache.readFailure(key, span);
        if (failure) return { detail: failure.status === 'exception' && failure.code !== null
          ? `读取异常 0x${failure.code.toString(16).toUpperCase().padStart(2, '0')}` : failure.status === 'timeout' ? '读取超时' : '传输异常' };
        const point = this.pointView(ref);
        if (!point.hasValue) return { detail: '点位尚无确认值' };
        const numeric = Object.keys(ref.point.enumMap).length ? point.rawNumber : point.engNumber;
        const value = point.boolValue ?? point.stringValue ?? numeric;
        if (value === null || (typeof value === 'number' && !Number.isFinite(value))) return { detail: '设备值无效' };
        return { value, detail: point.engText || '空字符串', sampledAtMs: this.cache.confirmedAt(key, span) };
      },
    };
  }

  private async writePoint(cmd: Extract<Command, { type: 'point.write' }>, signal?: AbortSignal): Promise<CommandResult<PointWriteResult>> {
    const index = this.pointIndex();
    const ref = index.get(pointKey(cmd.slaveId, cmd.pointId));
    if (!ref) return { ok: false, error: '点位不存在' };
    const rt = this.runtimes.get(ref.connection.id);
    if (!rt || (!(rt instanceof SlaveRuntime) && rt.state !== 'online')) return { ok: false, error: '连接不在线' };
    if (!ref.slave.enabled) return { ok: false, error: '从站未启用' };
    if (!canWritePoint(ref.point)) return { ok: false, error: '点位为只读' };
    const m = ref.point.mapping;

    let rawValue: number | boolean | string;
    try { rawValue = preparePointWrite(ref.point, cmd); }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }

    if (rt instanceof SlaveRuntime) {
      try {
        rt.setPoint(ref.slave.id, ref.block.id, m, rawValue);
        const delta = this.collectDelta(); if (delta) this.onDelta?.(delta);
        const result: PointWriteResult = { phase: 'confirmed', result: 'ok', exceptionCode: null };
        this.recordWrite(ref, rawValue, cmd, result);
        return { ok: true, value: result };
      } catch (error) { return { ok: false, error: String(error) }; }
    }
    const identity = this.writeIdentity(ref);
    const bindingEpoch = this.writeBindings.get(pointKey(cmd.slaveId, cmd.pointId))?.epoch;
    const outcome = await rt.writePoint({
      slave: ref.slave,
      block: ref.block,
      mapping: m,
      rawValue,
      pointId: ref.point.id,
      access: ref.point.access as 'rw' | 'wo',
      signal,
      guard: () => {
        const current = this.pointIndex().get(pointKey(cmd.slaveId, cmd.pointId));
        if (!current || this.writeIdentity(current) !== identity || this.writeBindings.get(pointKey(cmd.slaveId, cmd.pointId))?.epoch !== bindingEpoch || this.runtimes.get(ref.connection.id) !== rt) throw new Error('点位配置已改变，请核对原设备的写入结果');
      },
    });
    this.healthDirty = true;
    const value: PointWriteResult = {
      phase: !outcome.writeSent ? 'not-sent' : outcome.result === 'exception' ? 'rejected' : outcome.result === 'ok' ? 'confirmed' : 'unknown',
      result: outcome.result,
      exceptionCode: outcome.exceptionCode,
    };
    this.recordWrite(ref, rawValue, cmd, value);
    return { ok: true, value };
  }

  private writeReceipts = new Map<string, { identity: string; receipt: PointWriteReceipt }>();
  private pendingWrites = new Map<string, PointWriteReceipt>();
  private writeBindings = new Map<string, { identity: string; epoch: number }>();
  private writeBindingSequence = 0;

  private writeIdentity(ref: PointRef): string {
    return JSON.stringify([ref.connection, ref.slave.unitId, ref.block.area, ref.block.start, ref.point.mapping, ref.point.access, ref.point.scale, ref.point.offset, ref.point.enumMap]);
  }

  private receiptFor(ref: PointRef): PointWriteReceipt | undefined {
    const record = this.writeReceipts.get(pointKey(ref.slave.id, ref.point.id));
    return record && record.identity === this.writeIdentity(ref) ? record.receipt : undefined;
  }

  private recordWrite(ref: PointRef, raw: number | boolean | string, cmd: Extract<Command, { type: 'point.write' }>, result: PointWriteResult): void {
    const atMs = Date.now();
    const engineering = typeof raw === 'number' ? Object.keys(ref.point.enumMap).length ? raw : toEngineering(raw, ref.point) : null;
    const text = typeof raw === 'boolean' ? raw ? 'ON' : 'OFF' : typeof raw === 'string' ? raw : ref.point.enumMap[String(raw)] ?? formatEngineeringNumber(engineering!, ref.point.decimalPlaces);
    const previous = this.receiptFor(ref);
    const receipt: PointWriteReceipt = { phase: result.phase, result: result.result, attempted: String(cmd.stringValue ?? cmd.boolValue ?? cmd.engineering), atMs, exceptionCode: result.exceptionCode,
      accepted: result.phase === 'confirmed' ? { value: raw, engineering, text, atMs } : previous?.accepted };
    this.writeReceipts.set(pointKey(ref.slave.id, ref.point.id), { identity: this.writeIdentity(ref), receipt });
    this.pendingWrites.set(pointKey(ref.slave.id, ref.point.id), receipt);
  }

  sessions(): SessionSummary[] {
    return this.history.listSessions();
  }

  sessionDetail(id: string): SessionDetail | null {
    return this.history.getSession(id);
  }
}
