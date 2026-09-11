import log from 'electron-log';
import { BlockCache, blockKey } from './block-cache';
import { DiagnosticsStore, type ResultKind, type SourceKind, type TransactionRecord } from './diagnostics';
import { Transport } from './transport';
import { encodeRequestPdu, buildRtuAdu, buildTcpAdu, expectedResponseAduLength, RtuStreamingFramer, TcpStreamingFramer, validateAdu, type Framer, type FramerEvent, type Clock, systemClock, type RequestContext, type AduVerdict } from '../../domain/protocol';
import type { ModbusRequest, ModbusResponse, ReadFC } from '../../domain/protocol';
import type { BlockDef, ConnectionDef, SlaveDef } from '../../domain/model';
import { encodeRaw, type PointMapping, type RawMemory } from '../../domain/mapping';

export type ConnectionState = 'offline' | 'connecting' | 'online' | 'error';

export interface PollTarget {
  slave: SlaveDef;
  block: BlockDef;
}

export interface RequestOutcome {
  result: ResultKind;
  response: ModbusResponse | null;
  exceptionCode: number | null;
  durationMs: number;
  requestAduHex: string;
  responseAduHex: string | null;
  traceId: string;
}

export interface RuntimeHooks {
  onChange(): void;
  onState(state: ConnectionState, detail?: string): void;
}

interface PendingWaiter {
  ctx: RequestContext;
  traceId: string;
  resolve(verdict: AduVerdict): void;
  abort(result: ResultKind, reason: string): void;
}

const PRIORITY = { write: 0, manual: 1, poll: 2 } as const;
const RETRY_BACKOFF_MS = 50;

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export class ConnectionRuntime {
  readonly connectionId: string;
  state: ConnectionState = 'offline';
  private transport: Transport;
  private readonly config: ConnectionDef;
  private framer: Framer;
  private cache: BlockCache;
  private diagnostics: DiagnosticsStore;
  private clock: Clock;
  private hooks: RuntimeHooks;

  private targets: PollTarget[] = [];
  private due = new Map<string, number>();
  private queue: Array<{ priority: number; seq: number; label: string; run: () => Promise<void> }> = [];
  private queueSeq = 0;
  private busy = false;
  private timer: NodeJS.Timeout | null = null;
  private waiter: PendingWaiter | null = null;
  private tidCounter = 0;
  private scanning = false;
  private drainUntil = 0;
  private reconnectAt = 0;
  private reconnectDelay = 1000;
  private stopped = false;
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

  configure(targets: PollTarget[]): void {
    this.targets = targets;
    const now = this.clock.now();
    for (const t of targets) {
      const key = blockKey(t.slave.id, t.block.id);
      if (!this.due.has(key)) this.due.set(key, now + t.block.periodMs);
      this.cache.ensure(t.slave, t.block);
    }
    const keys = new Set(targets.map((t) => blockKey(t.slave.id, t.block.id)));
    for (const key of [...this.due.keys()]) if (!keys.has(key)) this.due.delete(key);
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.timer = setInterval(() => this.tick(), 5);
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.queue = [];
    await this.transport.close().catch(() => undefined);
    this.setState('offline');
  }

  private setState(state: ConnectionState, detail?: string): void {
    if (this.state === state) return;
    this.state = state;
    this.hooks.onState(state, detail);
    this.hooks.onChange();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.setState('connecting');
    try {
      await this.transport.connect();
      this.reconnectDelay = 1000;
      this.setState('online');
      const now = this.clock.now();
      for (const t of this.targets) this.due.set(blockKey(t.slave.id, t.block.id), now);
    } catch (err) {
      this.setState('error', String(err));
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.reconnectAt = this.clock.now() + this.reconnectDelay;
    this.reconnectDelay = Math.min(10000, this.reconnectDelay * 2);
  }

  private handleTransportFailure(err: Error): void {
    if (this.stopped) return;
    this.failWaiter('transport', err.message);
    this.setState('error', err.message);
    this.scheduleReconnect();
  }

  /* ------------------------- receive path ------------------------- */

  private onData(chunk: Uint8Array): void {
    const events = this.framer.push(chunk);
    this.handleFramerEvents(events);
  }

  private handleFramerEvents(events: FramerEvent[]): void {
    for (const ev of events) {
      if (ev.type === 'parse-error') {
        this.diagnostics.recordParseEvent({
          connectionId: this.connectionId,
          kind: ev.kind,
          reason: ev.reason,
          rawHex: hex(ev.raw),
          discarded: ev.discarded,
          recoveredCount: ev.recovered.length,
          traceId: this.waiter?.traceId ?? null,
          utc: new Date().toISOString(),
          mono: this.clock.now(),
        });
        this.hooks.onChange();
        for (const recovered of ev.recovered) this.deliverAdu(recovered);
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
        discarded: 0,
        recoveredCount: 0,
        traceId: null,
        utc: new Date().toISOString(),
        mono: this.clock.now(),
      });
      this.hooks.onChange();
      return;
    }
    if (this.clock.now() < this.drainUntil) {
      // Quiet recovery: do not associate bytes with the next request.
      this.diagnostics.recordParseEvent({
        connectionId: this.connectionId,
        kind: 'unexpected',
        reason: 'frame discarded during bounded drain / quiet recovery',
        rawHex: hex(adu),
        discarded: adu.length,
        recoveredCount: 0,
        traceId: waiter.traceId,
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
        utc: new Date().toISOString(),
        mono: this.clock.now(),
      });
      this.hooks.onChange();
      return;
    }
    const w = waiter;
    this.waiter = null;
    this.expectedLen = null;
    w.resolve(verdict);
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
    opts: { sourceKind: SourceKind; sourceId: string | null; timeoutMs?: number },
  ): Promise<RequestOutcome> {
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
    };
    const timeoutMs = opts.timeoutMs ?? 500;

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
          // Bounded drain / quiet recovery before the next request may use the line.
          this.framer.reset();
          this.drainUntil = this.clock.now() + 20;
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
        resolve: (verdict) => {
          const durationMs = this.clock.now() - startedMono;
          if (verdict.type === 'ok') {
            finish({ result: 'ok', response: verdict.response, exceptionCode: null, durationMs, requestAduHex: hex(adu), responseAduHex: null, traceId });
          } else if (verdict.type === 'exception') {
            finish({
              result: 'exception',
              response: verdict.response,
              exceptionCode: verdict.response.kind === 'exception' ? verdict.response.code : null,
              durationMs,
              requestAduHex: hex(adu),
              responseAduHex: null,
              traceId,
            });
          } else {
            finish({ result: 'unexpected', response: null, exceptionCode: null, durationMs, requestAduHex: hex(adu), responseAduHex: hex(verdict.raw), traceId });
          }
        },
      };

      this.logTrace('tx ' + hex(adu));
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

    const rec: TransactionRecord = {
      traceId,
      connectionId: this.connectionId,
      unitId,
      functionCode: req.fc,
      sourceKind: opts.sourceKind,
      sourceId: opts.sourceId,
      startUtc: startedUtc,
      startMono: startedMono,
      durationMs: outcome.durationMs,
      requestAduHex: outcome.requestAduHex,
      responseAduHex: outcome.responseAduHex,
      result: outcome.result,
      exceptionCode: outcome.exceptionCode,
      mbapTransactionId: tid,
      summary: summarizeRequest(req),
    };
    this.diagnostics.recordTransaction(rec);
    this.hooks.onChange();
    return outcome;
  }

  /**
   * Retry policy:
   * - reads (poll / temporary / scanner / read-back / RMW read): retry on timeout / transport,
   *   up to config.retries extra attempts with a small backoff. Exception responses are NEVER
   *   retried (the device explicitly refused).
   * - writes: NEVER retried on timeout / CRC (the write may already have been applied; the
   *   mandatory read-back resolves the true state). Retried only when nothing was sent (transport).
   */
  async executeRequest(
    unitId: number,
    req: ModbusRequest,
    opts: { sourceKind: SourceKind; sourceId: string | null; timeoutMs?: number },
  ): Promise<RequestOutcome> {
    const isRead = req.kind === 'read';
    const maxAttempts = 1 + Math.max(0, this.config.retries ?? 0);
    let last: RequestOutcome | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      last = await this.attemptRequest(unitId, req, opts);
      const retryable = isRead
        ? last.result === 'timeout' || last.result === 'transport'
        : last.result === 'transport';
      this.logTrace(`attempt ${attempt + 1}/${maxAttempts} ${summarizeRequest(req)} -> ${last.result}`);
      if (!retryable || attempt === maxAttempts - 1) break;
      this.logTrace(`retrying ${summarizeRequest(req)} after ${last.result}`);
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
    }
    return last as RequestOutcome;
  }
  /* ------------------------- scheduler ------------------------- */

  private tick(): void {
    const now = this.clock.now();
    if (this.state === 'error' || this.state === 'offline') {
      if (this.reconnectAt && now >= this.reconnectAt) {
        this.reconnectAt = 0;
        void this.connect();
      }
    }
    if (this.state !== 'online') return;
    const events = this.framer.tick(now);
    if (events.length) this.handleFramerEvents(events);
    if (this.transport.kind === 'rtu' && this.drainUntil && now >= this.drainUntil) {
      this.drainUntil = 0;
      // Drop anything the drain window absorbed so it can never reach a later request.
      this.framer.reset();
    }
    if (this.busy || this.waiter) return;
    const item = this.takeNext(now);
    if (!item) return;
    this.busy = true;
    item
      .run()
      .catch(() => undefined)
      .finally(() => {
        this.busy = false;
      });
  }

  private takeNext(now: number) {
    this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    const manual = this.queue.shift();
    if (manual) return manual;
    if (this.scanning) return null;
    let best: PollTarget | null = null;
    let bestDue = Infinity;
    for (const t of this.targets) {
      if (!t.slave.enabled) continue;
      const key = blockKey(t.slave.id, t.block.id);
      const due = this.due.get(key) ?? now;
      if (due <= now && due < bestDue) {
        best = t;
        bestDue = due;
      }
    }
    if (!best) return null;
    const target = best;
    const key = blockKey(target.slave.id, target.block.id);
    this.due.set(key, now + target.block.periodMs);
    return {
      priority: PRIORITY.poll,
      seq: this.queueSeq++,
      label: `poll ${target.block.name}`,
      run: async () => {
        await this.pollBlock(target);
      },
    };
  }

  private async pollBlock(target: PollTarget): Promise<void> {
    const { slave, block } = target;
    const req: ModbusRequest = {
      kind: 'read',
      fc: block.area as ReadFC,
      address: block.start,
      quantity: block.length,
    };
    const outcome = await this.executeRequest(slave.unitId, req, { sourceKind: 'poll', sourceId: block.id });
    const key = blockKey(slave.id, block.id);
    if (outcome.result === 'ok' && outcome.response) {
      this.cache.applyReadResult(key, outcome.response, outcome.durationMs);
    } else if (outcome.result === 'exception') {
      this.cache.markError(key, 'exception', outcome.exceptionCode);
    } else if (outcome.result === 'timeout') {
      this.cache.markError(key, 'timeout');
    } else {
      this.cache.markError(key, 'transport-error');
    }
    this.hooks.onChange();
  }

  enqueue(priority: number, label: string, run: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        priority,
        seq: this.queueSeq++,
        label,
        run: async () => {
          try {
            await run();
            resolve();
          } catch (err) {
            reject(err as Error);
          }
        },
      });
    });
  }

  /* ------------------------- high level ops ------------------------- */

  /** Single request at manual/diagnostic priority; pauses nothing else but jumps the queue. */
  temporaryRead(unitId: number, area: 1 | 2 | 3 | 4, start: number, quantity: number): Promise<RequestOutcome> {
    return new Promise((resolve) => {
      this.queue.push({
        priority: PRIORITY.manual,
        seq: this.queueSeq++,
        label: 'temporary-read',
        run: async () => {
          const outcome = await this.executeRequest(
            unitId,
            { kind: 'read', fc: area as ReadFC, address: start, quantity },
            { sourceKind: 'temporary-read', sourceId: null },
          );
          resolve(outcome);
        },
      });
    });
  }

  /** Atomic write sequence: [optional RMW read] -> write -> read back. */
  async writePoint(opts: {
    slave: SlaveDef;
    block: BlockDef;
    mapping: PointMapping;
    rawValue: number | boolean | string;
    pointId: string;
    readBackRange: { start: number; length: number };
  }): Promise<{ result: ResultKind; exceptionCode: number | null; readBack: RequestOutcome | null }> {
    const box: { outcome: RequestOutcome | null } = { outcome: null };
    await this.enqueue(PRIORITY.write, `write ${opts.pointId}`, async () => {
      const { slave, block, mapping } = opts;
      const key = blockKey(slave.id, block.id);
      const needsRmw = block.area === 3 && mapping.rawType !== 'Float32' && mapping.rawType !== 'Float64' && mapping.registerCount === 1 && (mapping.rawType === 'Bool' || mapping.rawType === 'BitField' || mapping.rawType === 'Int8' || mapping.rawType === 'UInt8');
      let baseMemory: RawMemory | null = null;
      if (needsRmw) {
        // Read latest register; never RMW from stale cache.
        const read = await this.executeRequest(slave.unitId, { kind: 'read', fc: 0x03, address: block.start + mapping.offset, quantity: 1 }, { sourceKind: 'rmw-read', sourceId: opts.pointId });
        if (read.result === 'ok' && read.response && read.response.kind === 'registers') {
          baseMemory = placeAt(read.response.registers, mapping.offset, mapping.registerCount);
        } else {
          box.outcome = read;
          return;
        }
      } else if (block.area === 3 && mapping.registerCount > 1) {
        const read = await this.executeRequest(slave.unitId, { kind: 'read', fc: 0x03, address: block.start + mapping.offset, quantity: mapping.registerCount }, { sourceKind: 'rmw-read', sourceId: opts.pointId });
        if (read.result === 'ok' && read.response && read.response.kind === 'registers') {
          baseMemory = placeAt(read.response.registers, mapping.offset, mapping.registerCount);
        } else {
          box.outcome = read;
          return;
        }
      }

      let req: ModbusRequest;
      if (block.area === 1) {
        req = { kind: 'writeCoil', fc: 0x05, address: block.start + mapping.offset, value: opts.rawValue === true };
      } else if (mapping.registerCount === 1 && (mapping.rawType === 'Bool' || mapping.rawType === 'BitField' || mapping.rawType === 'Int8' || mapping.rawType === 'UInt8' || mapping.rawType === 'Int16' || mapping.rawType === 'UInt16')) {
        const base = baseMemory ?? this.cache.get(key)?.memory ?? { kind: 'registers', registers: new Uint16Array(1) };
        const merged = encodeRaw(base, mapping, opts.rawValue);
        const reg = merged.kind === 'registers' ? (merged.registers[mapping.offset] as number) : 0;
        req = { kind: 'writeRegister', fc: 0x06, address: block.start + mapping.offset, value: reg };
      } else {
        const base = baseMemory ?? this.cache.get(key)?.memory ?? { kind: 'registers', registers: new Uint16Array(mapping.registerCount) };
        const merged = encodeRaw(base, mapping, opts.rawValue);
        const regs = merged.kind === 'registers' ? Array.from(merged.registers.slice(mapping.offset, mapping.offset + mapping.registerCount)) : [];
        req = { kind: 'writeRegisters', fc: 0x10, address: block.start + mapping.offset, values: regs };
      }

      box.outcome = await this.executeRequest(slave.unitId, req, { sourceKind: 'write', sourceId: opts.pointId });
      if (box.outcome.result !== 'ok') return;

      // Read back: confirms the device value and refreshes every shared point.
      const rb = await this.executeRequest(
        slave.unitId,
        block.area === 1 || block.area === 2
          ? { kind: 'read', fc: block.area as ReadFC, address: opts.readBackRange.start, quantity: opts.readBackRange.length }
          : { kind: 'read', fc: 0x03, address: opts.readBackRange.start, quantity: opts.readBackRange.length },
        { sourceKind: 'readback', sourceId: opts.pointId },
      );
      if (rb.result === 'ok' && rb.response) {
        this.cache.applyReadResult(key, rb.response, rb.durationMs);
        this.hooks.onChange();
      }
    });
    return { result: box.outcome?.result ?? 'transport', exceptionCode: box.outcome?.exceptionCode ?? null, readBack: box.outcome };
  }

  async scanUnits(range: { from: number; to: number }, timeoutMs = 150): Promise<Array<{ unitId: number; responseMs: number }>> {
    const found: Array<{ unitId: number; responseMs: number }> = [];
    this.scanning = true;
    try {
      for (let unit = range.from; unit <= range.to; unit++) {
        if (this.stopped || this.state !== 'online') break;
        const outcome = await this.executeRequest(unit, { kind: 'read', fc: 0x03, address: 0, quantity: 1 }, { sourceKind: 'scanner', sourceId: null, timeoutMs });
        if (outcome.result === 'ok' || outcome.result === 'exception') {
          found.push({ unitId: unit, responseMs: outcome.durationMs });
        }
      }
    } finally {
      this.scanning = false;
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
  }
}