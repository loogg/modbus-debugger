import net from 'node:net';
import log from 'electron-log';
import type { ConnectionDef, SlaveDef } from '../../domain/model';
import { buildRtuAdu, buildTcpAdu, parseMbap, splitRtuAdu, RtuStreamingFramer, TcpStreamingFramer, systemClock, type Clock, type Framer, type FramerEvent } from '../../domain/protocol';
import { decodeSlaveRequest, executeSlaveRequest, SlaveRequestError, slaveExceptionPdu, slaveRequestRange, type SlaveMemory } from '../../domain/protocol/slave';
import { encodeRaw, type PointMapping } from '../../domain/mapping';
import { BlockCache, blockKey, type BlockCacheEntry } from './block-cache';
import type { ConnectionState, PollTarget, RuntimeHooks } from './connection-runtime';
import { DiagnosticsStore } from './diagnostics';
import type { Transport } from './transport';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const MAX_CLIENTS = 32;
const MAX_SEND_BYTES = 65536;

/** Passive device runtime. All local and network writes share Main's confirmed Block Cache. */
export class SlaveRuntime {
  state: ConnectionState = 'offline';
  detail: string | null = null;
  private server: net.Server | null = null;
  private clients = new Map<net.Socket, Framer>();
  private targets: PollTarget[] = [];
  private owners = new Map<string, object>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private opening: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private serialQueue = Promise.resolve();
  private serialPending = 0;
  private serialFramer: Framer;
  private retryAt = 0;
  private retryDelay = 1000;
  private closing = false;
  readonly clock: Clock;

  constructor(private readonly opts: {
    config: ConnectionDef; cache: BlockCache; diagnostics: DiagnosticsStore; hooks: RuntimeHooks;
    serial?: Transport; clock?: Clock;
  }) {
    this.clock = opts.clock ?? systemClock;
    this.serialFramer = new RtuStreamingFramer({ clock: this.clock, requestFrames: true });
    opts.serial?.setHandlers({
      onData: bytes => { if (!this.stopped) this.handleEvents(this.serialFramer.push(bytes)); },
      onOpen: () => undefined,
      onClose: () => { if (!this.stopped && !this.closing) this.fail(new Error('串口已关闭')); },
      onError: error => { if (!this.stopped && !this.closing) this.fail(error); },
    });
  }

  get clientCount(): number { return this.clients.size; }
  get connectionId(): string { return this.opts.config.id; }

  configure(targets: PollTarget[]): void {
    this.targets = targets;
    const nextOwners = new Map<string, object>();
    for (const { slave, block } of targets) {
      const key = blockKey(slave.id, block.id);
      const owner = this.owners.get(key) ?? {};
      nextOwners.set(key, owner);
      const entry = this.opts.cache.ensure(slave, block, owner);
      if (!entry.lastUpdateUtc) {
        const initial = slave.initialValues?.find(value => value.blockId === block.id && value.area === block.area && value.start === block.start && value.values.length === block.length);
        const values = initial?.values ?? Array<number>(block.length).fill(0);
        this.commit(entry, values);
      }
      if (!slave.enabled && entry.status !== 'disabled') this.opts.cache.setDisabled(slave.id, true);
      if (slave.enabled && entry.status === 'disabled') this.commit(entry, this.values(entry));
    }
    this.owners = nextOwners;
    this.opts.hooks.onChange();
  }

  private values(entry: BlockCacheEntry): number[] {
    return entry.memory.kind === 'bits' ? entry.memory.bits.map(Number) : Array.from(entry.memory.registers);
  }

  private commit(entry: BlockCacheEntry, values: number[]): void {
    this.opts.cache.applyReadResult(entry.key, entry.block.area <= 2
      ? { kind: 'bits', fc: entry.block.area, bits: values.map(Boolean) }
      : { kind: 'registers', fc: entry.block.area, registers: values }, 0);
  }

  private memory(slave: SlaveDef): SlaveMemory {
    // Resolve and validate every segment before changing any block, including cross-block writes.
    const segments = (area: number, start: number, quantity: number) => {
      const out: Array<{ entry: BlockCacheEntry; offset: number; length: number }> = [];
      let position = start;
      while (position < start + quantity) {
        const target = this.targets.find(item => item.slave.id === slave.id && item.slave.enabled && item.block.area === area && item.block.start <= position && item.block.start + item.block.length > position);
        const entry = target && this.opts.cache.get(blockKey(slave.id, target.block.id));
        if (!entry) return null;
        const length = Math.min(start + quantity - position, entry.block.start + entry.block.length - position);
        out.push({ entry, offset: position - entry.block.start, length });
        position += length;
      }
      return out;
    };
    return {
      read: (area, start, quantity) => {
        const parts = segments(area, start, quantity);
        return parts ? parts.flatMap(part => this.values(part.entry).slice(part.offset, part.offset + part.length)) : null;
      },
      write: (area, start, values) => {
        const parts = segments(area, start, values.length);
        if (!parts) return false;
        let offset = 0;
        for (const part of parts) {
          const next = this.values(part.entry);
          next.splice(part.offset, part.length, ...values.slice(offset, offset + part.length));
          this.commit(part.entry, next);
          offset += part.length;
        }
        return true;
      },
    };
  }

  setValues(slaveId: string, blockId: string, offset: number, values: number[]): void {
    const target = this.targets.find(item => item.slave.id === slaveId && item.block.id === blockId);
    if (!target?.slave.enabled) throw new Error('本机从站不存在或未启用');
    const entry = this.opts.cache.get(blockKey(slaveId, blockId));
    if (!entry || !Number.isInteger(offset) || offset < 0 || offset + values.length > target.block.length || !values.length
      || values.some(value => !Number.isInteger(value) || value < 0 || value > (target.block.area <= 2 ? 1 : 65535))) throw new Error('数值或地址超出本机数据块范围');
    const next = this.values(entry);
    next.splice(offset, values.length, ...values);
    this.commit(entry, next);
    this.opts.hooks.onChange();
  }

  setPoint(slaveId: string, blockId: string, mapping: PointMapping, rawValue: number | boolean | string): void {
    const entry = this.opts.cache.get(blockKey(slaveId, blockId));
    if (!entry) throw new Error('数据块不存在');
    // This is the actual local device memory, so partial-byte/bit edits use it atomically.
    const encoded = encodeRaw(entry.memory, mapping, rawValue);
    this.setValues(slaveId, blockId, 0, encoded.kind === 'bits' ? encoded.bits.map(Number) : Array.from(encoded.registers));
  }

  initialValues(slaveId: string): NonNullable<SlaveDef['initialValues']> {
    return this.targets.filter(target => target.slave.id === slaveId).map(({ block }) => {
      const entry = this.opts.cache.get(blockKey(slaveId, block.id));
      if (!entry) throw new Error('数据块不存在');
      return { blockId: block.id, area: block.area, start: block.start, values: this.values(entry) };
    });
  }

  async start(): Promise<void> {
    if (this.stopping) await this.stopping;
    if (this.opening) return this.opening;
    if (this.state === 'online') return;
    this.stopped = false;
    this.retryAt = 0;
    if (!this.timer) this.timer = setInterval(() => this.tick(), 25);
    this.opening = this.open();
    try { await this.opening; } finally { this.opening = null; }
  }

  private async open(): Promise<void> {
    await this.closeResources();
    if (this.stopped) return;
    this.setState('connecting');
    try {
      if (this.opts.config.transport === 'tcp') {
        const settings = this.opts.config.tcp;
        if (!settings?.host.trim()) throw new Error('请填写本机监听地址');
        const server = net.createServer(socket => this.accept(socket));
        this.server = server;
        await new Promise<void>((resolve, reject) => {
          const failed = (error: Error) => reject(error);
          server.once('error', failed);
          server.listen({ host: settings.host, port: settings.port, exclusive: true }, () => {
            server.off('error', failed);
            server.on('error', error => { if (!this.stopped) this.fail(error); });
            resolve();
          });
        });
      } else {
        if (!this.opts.serial) throw new Error('缺少串口配置');
        this.serialFramer.reset();
        await this.opts.serial.connect();
      }
      if (this.stopped) { await this.closeResources(); return; }
      this.retryDelay = 1000;
      this.setState('online');
    } catch (error) {
      await this.closeResources();
      if (!this.stopped) this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private accept(socket: net.Socket): void {
    if (this.stopped || this.clients.size >= MAX_CLIENTS) { socket.destroy(); return; }
    socket.setNoDelay(true);
    const framer = new TcpStreamingFramer({ clock: this.clock });
    this.clients.set(socket, framer);
    socket.on('data', bytes => { if (!this.stopped) this.handleEvents(framer.push(bytes), socket); });
    socket.on('error', error => this.parseError('malformed', `TCP 客户端：${error.message}`, new Uint8Array()));
    socket.on('close', () => { this.clients.delete(socket); this.opts.hooks.onChange(); });
    this.opts.hooks.onChange();
  }

  private tick(): void {
    if (this.stopped) return;
    if (this.retryAt && this.clock.now() >= this.retryAt && !this.opening) { void this.start(); return; }
    if (this.state !== 'online') return;
    this.handleEvents(this.serialFramer.tick());
    for (const [socket, framer] of this.clients) this.handleEvents(framer.tick(), socket);
  }

  private fail(error: Error): void {
    this.setState('error', error.message);
    if (this.opts.config.reconnect === 'auto') {
      this.retryAt = this.clock.now() + this.retryDelay;
      this.retryDelay = Math.min(10000, this.retryDelay * 2);
    }
  }

  private setState(state: ConnectionState, detail: string | null = null): void {
    if (this.state === state && this.detail === detail) return;
    this.state = state;
    this.detail = detail;
    this.opts.hooks.onState(state, detail ?? undefined);
    this.opts.hooks.onChange();
  }

  private handleEvents(events: FramerEvent[], socket?: net.Socket): void {
    for (const event of events) {
      if (event.type === 'parse-error') this.parseError(event.kind, event.reason, event.raw, event.discarded, event.recovered.length);
      else this.respond(event.bytes, socket);
    }
  }

  private parseError(kind: 'crc' | 'malformed' | 'truncated' | 'overflow', reason: string, raw: Uint8Array, discarded = raw.length, recoveredCount = 0): void {
    this.opts.diagnostics.recordParseEvent({ connectionId: this.connectionId, kind, reason, rawHex: hex(raw), discarded, recoveredCount,
      traceId: null, unitId: null, functionCode: null, sourceKind: 'slave', utc: new Date().toISOString(), mono: this.clock.now() });
    this.opts.hooks.onChange();
  }

  private respond(adu: Uint8Array, socket?: net.Socket): void {
    const tcp = Boolean(socket);
    const parts = tcp ? parseMbap(adu) : splitRtuAdu(adu);
    const broadcast = !tcp && parts.unitId === 0;
    const slaves = [...new Map(this.targets.filter(target => target.slave.enabled && (broadcast || target.slave.unitId === parts.unitId)).map(target => [target.slave.id, target.slave])).values()];
    if (!slaves.length) return;
    if (parts.pdu.length === 0) { this.parseError('malformed', 'Empty request PDU', adu); return; }
    const at = this.clock.now();
    const utc = new Date().toISOString();
    let responsePdu: Uint8Array;
    let exceptionCode: number | null = null;
    let sourceId: string | null = null;
    let summary = `FC${parts.pdu[0]!.toString(16).toUpperCase().padStart(2, '0')} 请求`;
    try {
      const request = decodeSlaveRequest(parts.pdu);
      const range = slaveRequestRange(request);
      summary = `${range.start}–${range.start + range.quantity - 1} · ${range.write ? '写入' : '读取'} ${range.quantity} 项`;
      if (broadcast && !range.write) return;
      for (const slave of slaves) {
        try { responsePdu = executeSlaveRequest(request, this.memory(slave)); }
        catch (error) { if (!broadcast) throw error; }
      }
      const target = this.targets.find(target => target.slave.id === slaves[0]!.id && target.block.area === range.area && target.block.start <= range.start && target.block.start + target.block.length > range.start);
      sourceId = target?.block.id ?? null;
      // Broadcast has no response, including validation failures on individual devices.
      responsePdu = broadcast ? new Uint8Array() : responsePdu!;
    } catch (error) {
      exceptionCode = error instanceof SlaveRequestError ? error.code : 4;
      responsePdu = slaveExceptionPdu(parts.pdu[0]!, exceptionCode);
    }
    const tid = tcp ? parseMbap(adu).transactionId : null;
    const response = broadcast ? null : tcp ? buildTcpAdu(tid!, parts.unitId, responsePdu) : buildRtuAdu(parts.unitId, responsePdu);
    const record = (error?: Error | null) => {
      this.opts.diagnostics.recordTransaction({ traceId: this.opts.diagnostics.nextTraceId(), connectionId: this.connectionId, unitId: parts.unitId,
        functionCode: parts.pdu[0]!, sourceKind: 'slave', sourceId, startUtc: utc, startMono: at, durationMs: this.clock.now() - at,
        requestAduHex: hex(adu), responseAduHex: response && !error ? hex(response) : null, requestPduHex: hex(parts.pdu), responsePduHex: response && !error ? hex(responsePdu) : null,
        result: error ? 'transport' : exceptionCode !== null ? 'exception' : 'ok', exceptionCode, mbapTransactionId: tid,
        summary: error ? error.message : broadcast ? `广播写入（不响应） · ${summary}` : summary });
      if (this.opts.config.logLevel === 'debug') log.debug(`[Slave ${this.connectionId}] RX ${hex(adu)} TX ${response ? hex(response) : '(broadcast)'} ${error?.message ?? ''}`);
      this.opts.hooks.onChange();
    };
    if (!response) { record(); return; }
    if (socket) {
      if (socket.destroyed || socket.writableLength + response.length > MAX_SEND_BYTES) { record(new Error('TCP 客户端发送积压超限')); socket.destroy(); return; }
      socket.write(response, error => record(error));
    } else {
      if (this.serialPending >= 128) { record(new Error('串口响应队列超限')); return; }
      this.serialPending++;
      this.serialQueue = this.serialQueue.then(async () => {
        if (this.stopped) { record(new Error('从站已停止')); return; }
        try { await this.opts.serial!.write(response); record(); }
        catch (error) { record(error instanceof Error ? error : new Error(String(error))); }
      }).finally(() => { this.serialPending--; });
    }
  }

  private async closeResources(): Promise<void> {
    this.closing = true;
    for (const socket of this.clients.keys()) socket.destroy();
    this.clients.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await this.opts.serial?.close().catch(() => undefined);
    this.serialFramer.reset();
    this.closing = false;
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.retryAt = 0;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const shutdown = this.finishStop();
    this.stopping = shutdown;
    void shutdown.then(() => { if (this.stopping === shutdown) this.stopping = null; });
    return shutdown;
  }

  private async finishStop(): Promise<void> {
    // Wait for an in-progress open before closing it, including slow serial drivers.
    await this.opening;
    await this.closeResources();
    await this.serialQueue;
    this.setState('offline');
  }
}
