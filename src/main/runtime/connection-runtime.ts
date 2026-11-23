import log from 'electron-log';
import { BlockCache, blockKey } from './block-cache';
import { DiagnosticsStore, type ResultKind, type SourceKind, type TransactionRecord } from './diagnostics';
import { Transport } from './transport';
import { encodeRequestPdu, buildRtuAdu, buildTcpAdu, expectedResponseAduLength, RtuStreamingFramer, TcpStreamingFramer, validateAdu, type Framer, type FramerEvent, type Clock, systemClock, type RequestContext, type AduVerdict } from '../../domain/protocol';
import type { ModbusRequest, ReadFC } from '../../domain/protocol';
import { ExceptionCode } from '../../domain/protocol/types';
import type { BlockDef, ConnectionDef, SlaveDef } from '../../domain/model';
import { DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_RECONNECT_INTERVAL_MS } from '../../domain/model';
import { encodeRaw, type PointMapping, type RawMemory } from '../../domain/mapping';
import type { ScanRow, ScanStateView, SlaveStateView } from '../../shared/snapshot';
import { scanOptionsSchema, type ScanOverrides } from '../../shared/scan-options';
import type { RequestOutcome } from '../../shared/contracts';
import { mappingWidth, partialRegister, planBlockReads, type ReadRange } from '../../domain/point-access';

export type { RequestOutcome } from '../../shared/contracts';

export type ConnectionState = 'offline' | 'connecting' | 'online' | 'error';

export interface PollTarget {
  slave: SlaveDef;
  block: BlockDef;
  readRanges?: ReadRange[];
}

export interface RuntimeHooks {
  onChange(): void;
  onState(state: ConnectionState, detail?: string): void;
  onSlaveStateChange?(slaveId: string): void;
}

interface PendingWaiter {
  ctx: RequestContext;
  traceId: string;
  sourceKind: SourceKind;
  resolve(verdict: AduVerdict, adu: Uint8Array): void;
  abort(result: ResultKind, reason: string): void;
}

interface SlaveCommunication {
  slave: SlaveDef;
  readableBlocks: Map<string, number>;
  failedPolls: Map<string, number>;
  lastResponseUtc: string | null;
  offline: boolean;
}

const PRIORITY = { write: 0, manual: 1, poll: 2 } as const;
const DEFAULT_RETRY_DELAY_MS = 50;
const FAILED_POLLS_TO_GO_OFFLINE = 3;

function receivedTargetResponse({ result, exceptionCode }: RequestOutcome): boolean {
  return result === 'ok' || (result === 'exception' && exceptionCode !== null
    && exceptionCode !== ExceptionCode.GatewayPathUnavailable && exceptionCode !== ExceptionCode.GatewayTargetFailed);
}

function waitForDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, Math.ceil(ms));
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function responsePduHex(aduHex: string, transport: 'rtu' | 'tcp'): string {
  const adu = Buffer.from(aduHex, 'hex');
  return transport === 'rtu' ? hex(adu.subarray(1, -2)) : hex(adu.subarray(7));
}

export class ConnectionRuntime {
  readonly connectionId: string;
  state: ConnectionState = 'offline';
  detail: string | null = null;
  private transport: Transport;
  private readonly config: ConnectionDef;
  private framer: Framer;
  private cache: BlockCache;
  private diagnostics: DiagnosticsStore;
  private clock: Clock;
  private hooks: RuntimeHooks;

  private targets: PollTarget[] = [];
  private slaveCommunications = new Map<number, SlaveCommunication>();
  private targetVersions = new Map<string, { owner: object; generation: number }>();
  private due = new Map<string, number>();
  private pollRetries = new Map<string, { readyAt: number; attempt: number; generation: number }>();
  private pollOrder = new Map<string, number>();
  private pollProgress = new Map<string, { index: number; nextDue: number; generation: number; responded: boolean }>();
  private queue: Array<{ priority: number; seq: number; label: string; run: () => Promise<void>; cancel: (error: Error) => void }> = [];
  private queueSeq = 0;
  private busy = false;
  private timer: NodeJS.Timeout | null = null;
  private pump: NodeJS.Immediate | null = null;
  private dueTimer: NodeJS.Timeout | null = null;
  private wakeAt = Infinity;
  private requestAbort = new AbortController();
  private waiter: PendingWaiter | null = null;
  private tidCounter = 0;
  private scanning = false;
  private scanController: AbortController | null = null;
  private scanState: ScanStateView | null = null;
  private timedOutRequest: { traceId: string; unitId: number; functionCode: number; sourceKind: SourceKind } | null = null;
  private reconnectAt: number | null = null;
  private stopped = false;
  private lastRequestEnd = -Infinity;
  private lastRtuActivity = -Infinity;
  private readonly rtuCharacterMs: number;
  private readonly rtuQuietMs: number;
  private expectedLen: number | null = null;

  constructor(opts: {
    config: ConnectionDef;
    transport: Transport;
    cache: BlockCache;
    diagnostics: DiagnosticsStore;
    clock?: Clock;
    hooks: RuntimeHooks;
  }) {
    this.connectionId = opts.config.id;
    this.transport = opts.transport;
    this.config = opts.config;
    this.cache = opts.cache;
    this.diagnostics = opts.diagnostics;
    this.clock = opts.clock ?? systemClock;
    this.hooks = opts.hooks;
    const baud = opts.config.rtu?.baudRate ?? 9600;
    const serial = opts.config.rtu;
    const bitsPerCharacter = 1 + (serial?.dataBits ?? 8) + (serial?.parity && serial.parity !== 'none' ? 1 : 0) + (serial?.stopBits ?? 1);
    this.rtuCharacterMs = bitsPerCharacter * 1000 / baud;
    this.rtuQuietMs = baud > 19200 ? 1.75 : 3.5 * this.rtuCharacterMs;
    this.framer =
      opts.config.transport === 'rtu'
        ? new RtuStreamingFramer({ clock: this.clock, baudRate: baud, expectedAduLength: () => this.expectedLen })
        : new TcpStreamingFramer({ clock: this.clock, expectedAduLength: () => this.expectedLen });
    this.transport.setHandlers({
      onData: (chunk) => this.onData(chunk),
      onOpen: () => this.setState('online'),
      onError: (err) => this.handleTransportFailure(err),
      onClose: () => this.handleTransportFailure(new Error('connection closed')),
    });
  }

  get config_transport(): 'rtu' | 'tcp' {
    return this.transport.kind;
  }

  configure(targets: PollTarget[], slaves = targets.map(target => target.slave)): void {
    const previous = new Map(this.targets.map(t => [blockKey(t.slave.id, t.block.id), t]));
    this.targets = targets;
    const versions = new Map<string, { owner: object; generation: number }>();
    const communications = new Map<number, SlaveCommunication>();
    const readableBlocks = new Map<number, Map<string, number>>();
    for (const slave of slaves) {
      if (!slave.enabled || communications.has(slave.unitId)) continue;
      const current = this.slaveCommunications.get(slave.unitId);
      communications.set(slave.unitId, current?.slave.id === slave.id && current.slave.templateId === slave.templateId
        ? current : { slave, readableBlocks: new Map(), failedPolls: new Map(), lastResponseUtc: null, offline: false });
      readableBlocks.set(slave.unitId, new Map());
    }
    const now = this.clock.now();
    for (const t of targets) {
      const key = blockKey(t.slave.id, t.block.id);
      const old = previous.get(key);
      if (!this.due.has(key) || old?.block.periodMs !== t.block.periodMs || old?.slave.enabled !== t.slave.enabled || old?.slave.unitId !== t.slave.unitId || old?.block.start !== t.block.start) this.due.set(key, now + t.block.periodMs);
      const owner = this.targetVersions.get(key)?.owner ?? {};
      const entry = this.cache.ensure(t.slave, t.block, owner, t.readRanges ?? planBlockReads(t.block, []));
      if (entry.readRanges.length) readableBlocks.get(t.slave.unitId)?.set(key, entry.generation);
      if (!t.slave.enabled || this.pollProgress.get(key)?.generation !== entry.generation) this.pollProgress.delete(key);
      versions.set(key, { owner, generation: entry.generation });
      const retry = this.pollRetries.get(key);
      if (retry && (retry.generation !== entry.generation || !t.slave.enabled || old?.block.periodMs !== t.block.periodMs)) this.pollRetries.delete(key);
    }
    for (const [unitId, communication] of communications) {
      const blocks = readableBlocks.get(unitId)!;
      for (const key of communication.failedPolls.keys()) {
        if (blocks.get(key) !== communication.readableBlocks.get(key)) communication.failedPolls.delete(key);
      }
      communication.readableBlocks = blocks;
    }
    this.slaveCommunications = communications;
    this.targetVersions = versions;
    const keys = new Set(targets.map((t) => blockKey(t.slave.id, t.block.id)));
    for (const key of [...this.due.keys()]) if (!keys.has(key)) this.due.delete(key);
    for (const key of this.pollRetries.keys()) if (!keys.has(key)) this.pollRetries.delete(key);
    for (const key of this.pollOrder.keys()) if (!keys.has(key)) this.pollOrder.delete(key);
    for (const key of this.pollProgress.keys()) if (!keys.has(key)) this.pollProgress.delete(key);
    this.requestTick();
  }

  slaveState(slave: SlaveDef): SlaveStateView {
    const communication = this.slaveCommunications.get(slave.unitId);
    const lastResponseUtc = communication?.lastResponseUtc ?? null;
    if (!slave.enabled) return { state: 'disabled', lastResponseUtc: null };
    if (this.state !== 'online' || this.stopped) {
      return { state: this.state === 'connecting' && !this.stopped ? 'connecting' : 'offline', lastResponseUtc };
    }
    return { state: communication?.offline ? 'offline' : lastResponseUtc ? 'online' : 'pending', lastResponseUtc };
  }

  private recordFailedPoll(unitId: number, key: string): void {
    const communication = this.slaveCommunications.get(unitId);
    if (!communication?.readableBlocks.has(key) || communication.offline) return;
    const count = communication.failedPolls.get(key) ?? 0;
    communication.failedPolls.set(key, Math.min(count + 1, FAILED_POLLS_TO_GO_OFFLINE));
    // Every readable block must exhaust its polls. A faster block cannot mask
    // replies arriving on a slower block on the same device.
    if (communication.failedPolls.size === communication.readableBlocks.size
      && [...communication.failedPolls.values()].every(failures => failures >= FAILED_POLLS_TO_GO_OFFLINE)) {
      communication.offline = true;
      this.hooks.onSlaveStateChange?.(communication.slave.id);
      this.hooks.onChange();
    }
  }

  private targetIsCurrent(key: string, generation: number | undefined): boolean {
    return !this.stopped && generation !== undefined
      && this.targetVersions.get(key)?.generation === generation
      && this.cache.get(key)?.generation === generation
      && this.targets.some(target => blockKey(target.slave.id, target.block.id) === key && target.slave.enabled);
  }

  private requireCurrentTarget(key: string, generation: number | undefined): void {
    if (!this.targetIsCurrent(key, generation)) throw new Error('设备或数据块配置已改变，旧操作已取消；请核对当前设备后重试');
  }

  async start(): Promise<void> {
    this.stopped = false;
    // idempotent: a second start() must not stack a second scheduler interval
    if (!this.timer) this.timer = setInterval(() => this.tick(), 5);
    this.reconnectAt = null;
    if (this.state === 'connecting' || this.state === 'online') return;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopScan();
    this.stopped = true;
    this.reconnectAt = null;
    this.requestAbort.abort();
    this.failWaiter('transport', 'connection stopped');
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.pump) clearImmediate(this.pump);
    this.pump = null;
    this.clearWake();
    this.pollRetries.clear();
    this.pollProgress.clear();
    for (const item of this.queue.splice(0)) item.cancel(new Error('Connection stopped before the queued request was sent'));
    await this.transport.close().catch(() => undefined);
    this.setState('offline');
  }

  private setState(state: ConnectionState, detail?: string): void {
    if (this.state === state) return;
    this.state = state;
    this.detail = detail ?? null;
    this.hooks.onState(state, detail);
    for (const communication of this.slaveCommunications.values()) this.hooks.onSlaveStateChange?.(communication.slave.id);
    this.hooks.onChange();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    for (const communication of this.slaveCommunications.values()) {
      communication.lastResponseUtc = null;
      communication.failedPolls.clear();
      communication.offline = false;
    }
    this.setState('connecting');
    this.requestAbort = new AbortController();
    this.framer.reset();
    this.timedOutRequest = null;
    this.lastRtuActivity = -Infinity;
    this.lastRequestEnd = -Infinity;
    this.pollRetries.clear();
    this.pollProgress.clear();
    try {
      await this.transport.close();
      if (this.stopped) return;
      await this.transport.connect(this.config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
      if (this.stopped) {
        await this.transport.close().catch(() => undefined);
        return;
      }
      this.setState('online');
      const now = this.clock.now();
      for (const t of this.targets) this.due.set(blockKey(t.slave.id, t.block.id), now);
      this.requestTick();
    } catch (err) {
      if (this.stopped) return;
      this.setState('error', String(err));
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.config.reconnect === 'manual' || this.reconnectAt !== null) return;
    this.reconnectAt = this.clock.now() + (this.config.reconnectIntervalMs ?? DEFAULT_RECONNECT_INTERVAL_MS);
  }

  private handleTransportFailure(err: Error): void {
    if (this.stopped) return;
    this.requestAbort.abort();
    this.pollRetries.clear();
    this.pollProgress.clear();
    for (const item of this.queue.splice(0)) item.cancel(err);
    this.stopScan();
    this.failWaiter('transport', err.message);
    this.setState('error', err.message);
    this.scheduleReconnect();
  }

  /* ------------------------- receive path ------------------------- */

  private onData(chunk: Uint8Array): void {
    if (this.transport.kind === 'rtu' && chunk.length > 0) this.lastRtuActivity = Math.max(this.lastRtuActivity, this.clock.now());
    const events = this.framer.push(chunk);
    this.handleFramerEvents(events);
  }

  private handleFramerEvents(events: FramerEvent[]): void {
    for (const ev of events) {
      if (ev.type === 'parse-error') {
        const waiter = this.waiter;
        const expired = this.timedOutRequest;
        this.diagnostics.recordParseEvent({
          connectionId: this.connectionId,
          kind: ev.kind,
          reason: ev.reason,
          rawHex: hex(ev.raw),
          discarded: ev.discarded,
          recoveredCount: ev.recovered.length,
          traceId: waiter?.traceId ?? expired?.traceId ?? null,
          unitId: waiter?.ctx.unitId ?? expired?.unitId ?? null,
          functionCode: waiter?.ctx.fc ?? expired?.functionCode ?? null,
          sourceKind: waiter?.sourceKind ?? expired?.sourceKind ?? null,
          utc: new Date().toISOString(),
          mono: this.clock.now(),
        });
        this.hooks.onChange();
        // Recovered bytes are also emitted as ADU events by the framer; deliver exactly once.
      } else {
        this.deliverAdu(ev.bytes);
      }
    }
  }

  private deliverAdu(adu: Uint8Array): void {
    const waiter = this.waiter;
    if (!waiter) {
      // No in-flight request: late/unsolicited frame. Record for diagnosis only.
      this.diagnostics.recordParseEvent({
        connectionId: this.connectionId,
        kind: 'unexpected',
        reason: 'frame received with no in-flight request (late response)',
        rawHex: hex(adu),
        discarded: adu.length,
        recoveredCount: 0,
        traceId: this.timedOutRequest?.traceId ?? null,
        unitId: this.timedOutRequest?.unitId ?? null,
        functionCode: this.timedOutRequest?.functionCode ?? null,
        sourceKind: this.timedOutRequest?.sourceKind ?? null,
        utc: new Date().toISOString(),
        mono: this.clock.now(),
      });
      this.hooks.onChange();
      return;
    }
    const verdict = validateAdu(adu, waiter.ctx);
    this.logTrace('rx ' + hex(adu) + ' -> ' + verdict.type);
    if (verdict.type === 'unexpected') {
      this.diagnostics.recordParseEvent({
        connectionId: this.connectionId,
        kind: 'unexpected',
        reason: verdict.reason,
        rawHex: hex(adu),
        discarded: 0,
        recoveredCount: 0,
        traceId: waiter.traceId,
        unitId: waiter.ctx.unitId,
        functionCode: waiter.ctx.fc,
        sourceKind: waiter.sourceKind,
        utc: new Date().toISOString(),
        mono: this.clock.now(),
      });
      this.hooks.onChange();
      return;
    }
    if (verdict.type === 'crc-error' || verdict.type === 'malformed') {
      this.diagnostics.recordParseEvent({
        connectionId: this.connectionId,
        kind: verdict.type === 'crc-error' ? 'crc' : 'malformed',
        reason: verdict.type === 'crc-error' ? 'CRC mismatch on candidate ADU' : verdict.reason,
        rawHex: hex(adu),
        discarded: adu.length,
        recoveredCount: 0,
        traceId: waiter.traceId,
        unitId: waiter.ctx.unitId,
        functionCode: waiter.ctx.fc,
        sourceKind: waiter.sourceKind,
        utc: new Date().toISOString(),
        mono: this.clock.now(),
      });
      this.hooks.onChange();
      return;
    }
    const w = waiter;
    this.waiter = null;
    this.expectedLen = null;
    w.resolve(verdict, adu);
  }

  private failWaiter(result: ResultKind, reason: string): void {
    const w = this.waiter;
    if (!w) return;
    this.waiter = null;
    this.expectedLen = null;
    w.abort(result, reason);
  }

  /* ------------------------- request core ------------------------- */

  private nextTid(): number {
    this.tidCounter = (this.tidCounter + 1) & 0xffff;
    return this.tidCounter;
  }

  private logTrace(msg: string): void {
    if (this.config.logLevel === 'debug') log.debug('[conn ' + this.connectionId + '] ' + msg);
  }

  private async attemptRequest(
    unitId: number,
    req: ModbusRequest,
    opts: { sourceKind: SourceKind; sourceId: string | null; timeoutMs?: number; signal: AbortSignal; guard?: () => void; pollCycleStart?: boolean },
  ): Promise<RequestOutcome> {
    // Recheck after sleeping because unsolicited serial bytes move the quiet boundary.
    for (;;) {
      if (opts.signal.aborted || this.stopped || this.state !== 'online') throw new Error('Connection stopped before the request was sent');
      const readyAt = Math.max(
        this.lastRequestEnd + this.config.interFrameMs,
        this.transport.kind === 'rtu' ? this.lastRtuActivity + this.rtuQuietMs : -Infinity,
      );
      const gap = readyAt - this.clock.now();
      if (gap <= 0) break;
      await waitForDelay(gap, opts.signal);
    }
    // Discard incomplete bytes received between transactions before arming a new waiter.
    if (this.transport.kind === 'rtu') this.framer.reset();
    this.timedOutRequest = null;
    opts.guard?.();
    const communication = this.slaveCommunications.get(unitId);
    const session = this.requestAbort.signal;
    const startedMono = this.clock.now();
    const startedUtc = new Date().toISOString();
    const traceId = this.diagnostics.nextTraceId();
    const tid = this.transport.kind === 'tcp' ? this.nextTid() : null;
    const pdu = encodeRequestPdu(req);
    const adu = this.transport.kind === 'rtu' ? buildRtuAdu(unitId, pdu) : buildTcpAdu(tid as number, unitId, pdu);
    const ctx: RequestContext = {
      transport: this.transport.kind,
      unitId,
      fc: req.fc,
      expectedAduLength: expectedResponseAduLength(req, this.transport.kind),
      tid: tid ?? undefined,
      request: req,
    };
    // The connection's configured timeout governs every request path (poll, temporary read,
    // RMW and write). Only the unit scanner passes an explicit shorter probe timeout.
    const timeoutMs = opts.timeoutMs ?? this.config.timeoutMs;

    const outcome = await new Promise<RequestOutcome>((resolve) => {
      let settled = false;
      const finish = (o: RequestOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(o);
      };
      const timer = setTimeout(() => {
        if (this.waiter?.traceId === traceId) {
          this.waiter = null;
          this.expectedLen = null;
        }
        if (this.transport.kind === 'rtu') {
          // The response timeout ends this transaction. Clear its partial bytes immediately.
          this.framer.reset();
          this.timedOutRequest = { traceId, unitId, functionCode: req.fc, sourceKind: opts.sourceKind };
        }
        finish({
          result: 'timeout',
          response: null,
          exceptionCode: null,
          durationMs: this.clock.now() - startedMono,
          requestAduHex: hex(adu),
          responseAduHex: null,
          traceId,
        });
      }, timeoutMs);

      this.expectedLen = ctx.expectedAduLength;
      this.waiter = {
        ctx,
        traceId,
        sourceKind: opts.sourceKind,
        abort: (result, reason) => {
          finish({
            result,
            response: null,
            exceptionCode: null,
            durationMs: this.clock.now() - startedMono,
            requestAduHex: hex(adu),
            responseAduHex: null,
            traceId,
          });
          void reason;
        },
        resolve: (verdict, responseAdu) => {
          const durationMs = this.clock.now() - startedMono;
          if (verdict.type === 'ok') {
            finish({ result: 'ok', response: verdict.response, exceptionCode: null, durationMs, requestAduHex: hex(adu), responseAduHex: hex(responseAdu), traceId });
          } else if (verdict.type === 'exception') {
            finish({
              result: 'exception',
              response: verdict.response,
              exceptionCode: verdict.response.kind === 'exception' ? verdict.response.code : null,
              durationMs,
              requestAduHex: hex(adu),
              responseAduHex: hex(responseAdu),
              traceId,
            });
          } else {
            finish({ result: 'unexpected', response: null, exceptionCode: null, durationMs, requestAduHex: hex(adu), responseAduHex: hex(verdict.raw), traceId });
          }
        },
      };

      this.logTrace('tx ' + hex(adu));
      if (this.transport.kind === 'rtu') this.lastRtuActivity = startedMono + adu.length * this.rtuCharacterMs;
      this.transport.write(adu).catch((err: Error) => {
        if (this.waiter?.traceId === traceId) {
          this.waiter = null;
          this.expectedLen = null;
        }
        finish({
          result: 'transport',
          response: null,
          exceptionCode: null,
          durationMs: this.clock.now() - startedMono,
          requestAduHex: hex(adu),
          responseAduHex: null,
          traceId,
        });
        void err;
      });
    });

    if (communication && receivedTargetResponse(outcome) && !session.aborted
      && communication === this.slaveCommunications.get(unitId)) {
      const becameOnline = communication.offline || communication.lastResponseUtc === null;
      communication.lastResponseUtc = new Date().toISOString();
      communication.failedPolls.clear();
      communication.offline = false;
      if (becameOnline) this.hooks.onSlaveStateChange?.(communication.slave.id);
    }
    const rec: TransactionRecord = {
      traceId,
      connectionId: this.connectionId,
      unitId,
      functionCode: req.fc,
      sourceKind: opts.sourceKind,
      sourceId: opts.sourceId,
      ...(opts.pollCycleStart !== undefined ? { pollCycleStart: opts.pollCycleStart } : {}),
      startUtc: startedUtc,
      startMono: startedMono,
      durationMs: outcome.durationMs,
      requestAduHex: outcome.requestAduHex,
      responseAduHex: outcome.responseAduHex,
      requestPduHex: hex(pdu),
      responsePduHex: outcome.responseAduHex ? responsePduHex(outcome.responseAduHex, this.transport.kind) : null,
      result: outcome.result,
      exceptionCode: outcome.exceptionCode,
      mbapTransactionId: tid,
      summary: summarizeRequest(req),
    };
    this.diagnostics.recordTransaction(rec);
    this.lastRequestEnd = this.clock.now();
    this.hooks.onChange();
    return outcome;
  }

  /**
   * Retry policy:
   * - reads (poll / temporary / scanner / RMW read): retry on timeout / transport,
   *   up to config.retries extra attempts with a small backoff. Exception responses are NEVER
   *   retried (the device explicitly refused).
   * - writes: NEVER retried automatically. A transport error from write() may occur
   *   after bytes were queued or transmitted, so delivery cannot be assumed false.
   */
  async executeRequest(
    unitId: number,
    req: ModbusRequest,
    opts: { sourceKind: SourceKind; sourceId: string | null; timeoutMs?: number; retries?: number; signal?: AbortSignal; guard?: () => void; pollCycleStart?: boolean },
  ): Promise<RequestOutcome> {
    const isRead = req.kind === 'read';
    const signal = opts.signal ? AbortSignal.any([this.requestAbort.signal, opts.signal]) : this.requestAbort.signal;
    const maxAttempts = isRead ? 1 + Math.max(0, opts.retries ?? this.config.retries ?? 0) : 1;
    let last: RequestOutcome | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      last = await this.attemptRequest(unitId, req, { ...opts, signal, pollCycleStart: opts.pollCycleStart === undefined ? undefined : opts.pollCycleStart && attempt === 0 });
      const retryable = isRead && (last.result === 'timeout' || last.result === 'transport');
      this.logTrace(`attempt ${attempt + 1}/${maxAttempts} ${summarizeRequest(req)} -> ${last.result}`);
      if (!retryable || attempt === maxAttempts - 1 || signal.aborted || this.stopped) break;
      this.logTrace(`retrying ${summarizeRequest(req)} after ${last.result}`);
      await waitForDelay(this.config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS, signal);
      if (signal.aborted || this.stopped) break;
    }
    return last as RequestOutcome;
  }
  /* ------------------------- scheduler ------------------------- */

  private clearWake(): void {
    if (this.dueTimer) clearTimeout(this.dueTimer);
    this.dueTimer = null;
    this.wakeAt = Infinity;
  }

  private requestTick(): void {
    if (this.stopped || !this.timer || this.pump) return;
    this.clearWake();
    // Yield to I/O even when a transport completes synchronously and periodMs is zero.
    this.pump = setImmediate(() => {
      this.pump = null;
      this.tick();
    });
  }

  private wakeForPoll(at: number): void {
    if (!Number.isFinite(at) || this.wakeAt <= at) return;
    this.clearWake();
    this.wakeAt = at;
    this.dueTimer = setTimeout(() => {
      this.dueTimer = null;
      this.wakeAt = Infinity;
      this.tick();
    }, Math.max(1, Math.ceil(at - this.clock.now())));
  }

  private tick(): void {
    const now = this.clock.now();
    if (this.state === 'error' || this.state === 'offline') {
      if (this.reconnectAt !== null && now >= this.reconnectAt) {
        this.reconnectAt = null;
        void this.connect();
      }
    }
    if (this.state !== 'online') return;
    const events = this.framer.tick(now);
    if (events.length) this.handleFramerEvents(events);
    if (this.busy || this.waiter) return;
    const item = this.takeNext(now);
    if (!item) return;
    this.clearWake();
    this.busy = true;
    item
      .run()
      .catch(() => undefined)
      .finally(() => {
        this.busy = false;
        this.requestTick();
      });
  }

  private takeNext(now: number) {
    if (this.scanning) return null;
    this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    const manual = this.queue.shift();
    if (manual) return manual;
    let best: PollTarget | null = null;
    let bestDue = Infinity;
    let bestOrder = Infinity;
    let nextDue = Infinity;
    for (const t of this.targets) {
      if (!t.slave.enabled || !this.cache.get(blockKey(t.slave.id, t.block.id))?.readRanges.length) continue;
      const key = blockKey(t.slave.id, t.block.id);
      const due = this.pollRetries.get(key)?.readyAt ?? this.due.get(key) ?? now;
      nextDue = Math.min(nextDue, due);
      const order = this.pollOrder.get(key) ?? 0;
      if (due <= now && (due < bestDue || (due === bestDue && order < bestOrder))) {
        best = t;
        bestDue = due;
        bestOrder = order;
      }
    }
    if (!best) {
      this.wakeForPoll(nextDue);
      return null;
    }
    const target = best;
    const key = blockKey(target.slave.id, target.block.id);
    const generation = this.targetVersions.get(key)?.generation;
    const retry = this.pollRetries.get(key);
    if (!this.pollProgress.has(key)) this.pollProgress.set(key, { index: 0, nextDue: now + target.block.periodMs, generation: generation!, responded: false });
    this.pollOrder.set(key, ++this.queueSeq);
    return {
      priority: PRIORITY.poll,
      seq: this.queueSeq++,
      label: `poll ${target.block.name}`,
      run: async () => {
        await this.pollBlock(target, generation, retry?.attempt ?? 0);
      },
    };
  }

  private async pollBlock(target: PollTarget, generation: number | undefined, scheduledAttempt?: number): Promise<void> {
    const { slave, block } = target;
    const session = this.requestAbort.signal;
    const key = blockKey(slave.id, block.id);
    this.requireCurrentTarget(key, generation);
    const ranges = this.cache.get(key)?.readRanges ?? [];
    if (scheduledAttempt === undefined) {
      const communication = this.slaveCommunications.get(slave.unitId);
      let responded = false;
      for (const range of ranges) {
        const outcome = await this.pollRange(target, generation, range);
        responded = receivedTargetResponse(outcome) || responded;
      }
      if (!responded && !session.aborted && this.targetIsCurrent(key, generation)
        && communication === this.slaveCommunications.get(slave.unitId)) this.recordFailedPoll(slave.unitId, key);
      return;
    }
    const progress = this.pollProgress.get(key);
    const range = progress && ranges[progress.index];
    if (!progress || !range) return;
    const outcome = await this.pollRange(target, generation, range, scheduledAttempt);
    if (session.aborted || this.pollProgress.get(key) !== progress || !this.targetIsCurrent(key, generation)) return;
    progress.responded ||= receivedTargetResponse(outcome);
    this.pollRetries.delete(key);
    if ((outcome.result === 'timeout' || outcome.result === 'transport') && scheduledAttempt < this.config.retries && this.state === 'online') {
      this.pollRetries.set(key, { readyAt: this.clock.now() + (this.config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS), attempt: scheduledAttempt + 1, generation: generation! });
      return;
    }
    progress.index++;
    if (progress.index < ranges.length) this.due.set(key, this.clock.now());
    else {
      this.pollProgress.delete(key);
      this.due.set(key, progress.nextDue);
      if (!progress.responded) this.recordFailedPoll(slave.unitId, key);
    }
  }

  private async pollRange(target: PollTarget, generation: number | undefined, range: ReadRange, scheduledAttempt?: number): Promise<RequestOutcome> {
    const { slave, block } = target;
    const session = this.requestAbort.signal;
    const key = blockKey(slave.id, block.id);
    this.requireCurrentTarget(key, generation);
    const outcome = await this.executeRequest(slave.unitId, { kind: 'read', fc: block.area as ReadFC, address: block.start + range.offset, quantity: range.length }, {
      sourceKind: 'poll', sourceId: block.id, guard: () => this.requireCurrentTarget(key, generation),
      pollCycleStart: range === this.cache.get(key)?.readRanges[0] && (scheduledAttempt ?? 0) === 0,
      retries: scheduledAttempt === undefined ? undefined : 0,
    });
    // A legitimate response still belongs to the old binding after a configuration edit.
    if (session !== this.requestAbort.signal || !this.targetIsCurrent(key, generation)) return outcome;
    if (outcome.result === 'ok' && outcome.response) {
      this.cache.applyReadResult(key, outcome.response, outcome.durationMs, range.offset, range.length);
    } else if (outcome.result === 'exception') {
      this.cache.markError(key, 'exception', outcome.exceptionCode, range);
    } else if (outcome.result === 'timeout') {
      this.cache.markError(key, 'timeout', null, range);
    } else {
      this.cache.markError(key, 'transport-error', null, range);
    }
    this.hooks.onChange();
    return outcome;
  }

  enqueue(priority: number, label: string, run: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        const index = this.queue.indexOf(task);
        if (index < 0) return;
        this.queue.splice(index, 1);
        task.cancel(signal?.reason ?? new Error('请求已停止'));
      };
      const task = {
        priority,
        seq: this.queueSeq++,
        label,
        cancel: (error: Error) => {
          signal?.removeEventListener('abort', abort);
          reject(error);
        },
        run: async () => {
          signal?.removeEventListener('abort', abort);
          try {
            signal?.throwIfAborted();
            await run();
            resolve();
          } catch (err) {
            reject(err as Error);
          }
        },
      };
      if (signal?.aborted) { reject(signal.reason); return; }
      signal?.addEventListener('abort', abort, { once: true });
      this.queue.push(task);
      this.requestTick();
    });
  }

  /* ------------------------- high level ops ------------------------- */

  async refresh(slaveId: string, blockId?: string): Promise<void> {
    if (this.state !== 'online' || this.stopped) throw new Error('Connection is offline');
    const targets = this.targets.filter(target => target.slave.id === slaveId && target.slave.enabled && (!blockId || target.block.id === blockId))
      .map(target => ({ target, generation: this.targetVersions.get(blockKey(target.slave.id, target.block.id))?.generation }));
    if (!targets.length) throw new Error('No enabled blocks to refresh');
    await this.enqueue(PRIORITY.manual, 'refresh', async () => {
      for (const { target, generation } of targets) await this.pollBlock(target, generation);
    });
  }

  /** Single request at manual/diagnostic priority; pauses nothing else but jumps the queue. */
  temporaryRead(unitId: number, area: 1 | 2 | 3 | 4, start: number, quantity: number): Promise<RequestOutcome> {
    if (this.stopped || this.state !== 'online') return Promise.reject(new Error('Connection is offline; connect before reading'));
    return new Promise((resolve, reject) => {
      this.queue.push({
        priority: PRIORITY.manual,
        seq: this.queueSeq++,
        label: 'temporary-read',
        cancel: reject,
        run: async () => {
          try {
            const outcome = await this.executeRequest(
              unitId,
              { kind: 'read', fc: area as ReadFC, address: start, quantity },
              { sourceKind: 'temporary-read', sourceId: null },
            );
            resolve(outcome);
          } catch (error) { reject(error); }
        },
      });
    });
  }

  /** Atomic write sequence: [optional fresh RMW read] -> write response. */
  async writePoint(opts: {
    slave: SlaveDef;
    block: BlockDef;
    mapping: PointMapping;
    rawValue: number | boolean | string;
    access?: 'rw' | 'wo';
    guard?: () => void;
    signal?: AbortSignal;
    pointId: string;
    readBackRange?: { start: number; length: number };
  }): Promise<{ result: ResultKind; exceptionCode: number | null; readBack: RequestOutcome | null; writeSent: boolean }> {
    const key = blockKey(opts.slave.id, opts.block.id);
    const generation = this.targetVersions.get(key)?.generation;
    const guard = () => { this.requireCurrentTarget(key, generation); opts.guard?.(); };
    const beforeSend = () => { opts.signal?.throwIfAborted(); guard(); };
    let writeSent = false;
    const box: { outcome: RequestOutcome | null; readBack: RequestOutcome | null } = { outcome: null, readBack: null };
    await this.enqueue(PRIORITY.write, `write ${opts.pointId}`, async () => {
      const { slave, block, mapping } = opts;
      beforeSend();
      const partial = block.area === 3 && partialRegister(mapping);
      const needsRmw = partial && opts.access !== 'wo';
      let baseMemory: RawMemory | null = null;
      if (needsRmw) {
        // Read latest register; never RMW from stale cache.
        const read = await this.executeRequest(slave.unitId, { kind: 'read', fc: 0x03, address: block.start + mapping.offset, quantity: 1 }, { sourceKind: 'rmw-read', sourceId: opts.pointId, guard: beforeSend, signal: opts.signal });
        if (read.result === 'ok' && read.response && read.response.kind === 'registers') {
          baseMemory = placeAt(read.response.registers, mapping.offset, mapping.registerCount);
        } else {
          box.outcome = read;
          return;
        }
      }

      beforeSend();
      const width = mappingWidth(block.area, mapping);
      const scratch: RawMemory = { kind: 'registers', registers: new Uint16Array(mapping.offset + width) };
      let req: ModbusRequest;
      if (block.area === 1) {
        req = { kind: 'writeCoil', fc: 0x05, address: block.start + mapping.offset, value: opts.rawValue === true };
      } else if (partial && opts.access === 'wo') {
        const mask = mapping.rawType === 'Bool' ? 1 << mapping.bitOffset : mapping.rawType === 'BitField' ? ((1 << mapping.bitWidth) - 1) << mapping.bitOffset : mapping.byteSelector === 'high' ? 0xff00 : 0xff;
        const encoded = encodeRaw(scratch, mapping, opts.rawValue);
        req = { kind: 'maskWrite', fc: 0x16, address: block.start + mapping.offset, andMask: ~mask & 0xffff, orMask: encoded.kind === 'registers' ? encoded.registers[mapping.offset]! & mask : 0 };
      } else if (width === 1) {
        const base = baseMemory ?? scratch;
        const merged = encodeRaw(base, mapping, opts.rawValue);
        const reg = merged.kind === 'registers' ? (merged.registers[mapping.offset] as number) : 0;
        req = { kind: 'writeRegister', fc: 0x06, address: block.start + mapping.offset, value: reg };
      } else {
        const base = baseMemory ?? scratch;
        const merged = encodeRaw(base, mapping, opts.rawValue);
        const regs = merged.kind === 'registers' ? Array.from(merged.registers.slice(mapping.offset, mapping.offset + width)) : [];
        req = { kind: 'writeRegisters', fc: 0x10, address: block.start + mapping.offset, values: regs };
      }

      writeSent = true;
      box.outcome = await this.executeRequest(slave.unitId, req, { sourceKind: 'write', sourceId: opts.pointId, guard: beforeSend, signal: opts.signal });
      guard();
    }, opts.signal);
    return { result: box.outcome?.result ?? 'transport', exceptionCode: box.outcome?.exceptionCode ?? null, readBack: box.readBack, writeSent };
  }

  get scan(): ScanStateView | null {
    return this.scanState;
  }

  stopScan(): void {
    if (!this.scanController || this.scanController.signal.aborted) return;
    this.scanController.abort();
    if (this.scanState) this.scanState = { ...this.scanState, phase: 'stopping' };
    this.hooks.onChange();
  }

  async scanUnits(range: { from: number; to: number }, overrides: ScanOverrides = {}): Promise<ScanRow[]> {
    if (!Number.isInteger(range.from) || !Number.isInteger(range.to) || range.from < 1 || range.to > 247 || range.from > range.to) {
      throw new Error('Scan range must satisfy 1 <= from <= to <= 247');
    }
    if (this.scanning) throw new Error('Scan already running on this connection');
    if (this.stopped || this.state !== 'online') throw new Error('Connection must be online to scan');
    const parsed = scanOptionsSchema.parse(overrides);
    const options = { ...parsed, retries: parsed.retries ?? this.config.retries };
    const found: ScanRow[] = [];
    const controller = new AbortController();
    this.scanController = controller;
    this.scanning = true;
    const started = this.clock.now();
    let checked = 0;
    let ownsSlot = false;
    const active = () => !controller.signal.aborted && !this.stopped && this.state === 'online';
    const update = (phase: ScanStateView['phase'], currentUnit: number | null) => {
      this.scanState = { phase, ...range, options, currentUnit, checked, found: [...found], elapsedMs: this.clock.now() - started };
      this.hooks.onChange();
    };
    update('running', null);
    try {
      // Block new scheduler work, but let the current poll or atomic RMW/write group finish.
      while (active() && (this.busy || this.waiter)) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (!active()) return found;
      this.busy = true;
      ownsSlot = true;
      for (let unit = range.from; unit <= range.to; unit++) {
        if (!active()) break;
        update('running', unit);
        const outcome = await this.executeRequest(unit, { kind: 'read', fc: options.fc, address: options.start, quantity: 1 }, { sourceKind: 'scanner', sourceId: null, timeoutMs: options.timeoutMs, retries: options.retries, signal: controller.signal });
        checked++;
        if (receivedTargetResponse(outcome)) {
          found.push({ unitId: unit, responseMs: outcome.durationMs, exceptionCode: outcome.exceptionCode });
        }
        update(controller.signal.aborted ? 'stopping' : 'running', unit);
      }
    } catch (error) {
      if (active()) throw error;
    } finally {
      if (ownsSlot) this.busy = false;
      this.scanning = false;
      this.scanController = null;
      update(active() && checked === range.to - range.from + 1 ? 'completed' : 'stopped', null);
      this.requestTick();
    }
    return found;
  }
}

/** Place freshly read registers at their absolute offset inside a scratch memory. */
function placeAt(values: number[], offset: number, count: number): RawMemory {
  const regs = new Uint16Array(offset + count);
  values.slice(0, count).forEach((r, i) => {
    regs[offset + i] = r;
  });
  return { kind: 'registers', registers: regs };
}

export function summarizeRequest(req: ModbusRequest): string {
  switch (req.kind) {
    case 'read':
      return `Start ${req.address} · Qty ${req.quantity}`;
    case 'writeCoil':
      return `地址 ${req.address} ← ${req.value ? 'ON' : 'OFF'}`;
    case 'writeCoils':
      return `地址 ${req.address} ← ${req.values.length} coils`;
    case 'writeRegister':
      return `地址 ${req.address} ← ${req.value}`;
    case 'writeRegisters':
      return `地址 ${req.address} ← ${req.values.length} regs`;
    case 'maskWrite':
      return `地址 ${req.address} · AND ${req.andMask.toString(16)} · OR ${req.orMask.toString(16)}`;
  }
}
