import type { ModbusApi } from '../../shared/preload-api';
import type { BlockViewState, PointViewState } from '../../shared/snapshot';
import type { BufferInfo, ColumnDataReadResult, DataPointRef, DataReadRequest, SeriesRead } from '../../shared/point-data';
import { pointKey } from '../../shared/point-key';
import { SeriesData, type SeriesDisplay, type SeriesProjection } from './series-data';

export interface HostSeriesNeed extends DataPointRef {
  windowMs?: number;
  endMs?: number;
  labels?: Record<string, string>;
}

export interface HostNeeds {
  points: DataPointRef[];
  blocks?: Array<{ slaveId: string; blockId: string }>;
  series?: HostSeriesNeed[];
  buffers?: DataPointRef[];
  intervalMs: number;
  active: boolean;
}
export interface CachedSeries extends BufferInfo {
  rangeStatus?: 'available' | 'partial' | 'expired';
  data: SeriesDisplay;
  metadataVersion: string;
  checkedAt: number;
  startMs: number;
  endMs?: number;
  nextSeq: number;
  hasMore: boolean;
  gap: boolean;
  pending?: Pick<SeriesRead, 'afterSeq' | 'throughSeq' | 'startMs' | 'endMs'>;
}
export interface HostValues {
  points: Record<string, PointViewState>;
  blocks: Record<string, BlockViewState>;
  series: Record<string, CachedSeries>;
  buffers: Record<string, BufferInfo>;
  error: string | null;
}
interface Host { id: string; needs: HostNeeds; deliver: (values: HostValues) => void; due: number; projections: Map<string, SeriesProjection> }
interface StoredSeries extends Omit<CachedSeries, 'data'> { data: SeriesData; pointKey: string }
interface Checked<T> { value: T; at: number }
interface SeriesMember { host: Host; index: number; ref: HostSeriesNeed; startMs: number; endMs: number }
interface SeriesPlan { id: string; key: string; ref: HostSeriesNeed; startMs: number; endMs?: number; members: SeriesMember[] }

function mergeRows<T>(arrays: T[][], sequence: (row: T) => number, time: (row: T) => number): T[] {
  const unique = new Map<number, T>();
  for (const rows of arrays) for (const row of rows) unique.set(sequence(row), row);
  return [...unique.values()].sort((left, right) => time(left) - time(right) || sequence(left) - sequence(right));
}

/** One shared read cache. Hosts publish independently, while overlapping requests are coalesced. */
export class FrontendDataCache {
  private hosts = new Map<string, Host>();
  private points = new Map<string, Checked<PointViewState>>();
  private blocks = new Map<string, Checked<BlockViewState>>();
  private series = new Map<string, StoredSeries>();
  private plans = new Map<string, SeriesPlan>();
  private planIds = new Map<string, string>();
  private planSequence = 0;
  private buffers = new Map<string, Checked<BufferInfo> & { version: string }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private epoch = 0;
  private registered = '';
  private renewAt = 0;
  private retryAt = 0;
  private clientId = `host-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  private error: string | null = null;
  readonly metrics = { requests: 0, cacheHits: 0, samples: 0, sampleBytes: 0 };

  constructor(private readonly api: ModbusApi, private readonly now: () => number = () => performance.now()) {}

  register(id: string, needs: HostNeeds, deliver: Host['deliver']): () => void {
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
    this.cleanupTimer = null;
    this.hosts.set(id, { id, needs, deliver, due: 0, projections: this.hosts.get(id)?.projections ?? new Map() });
    this.schedule(0);
    return () => {
      const current = this.hosts.get(id);
      if (current?.deliver !== deliver) return;
      this.hosts.delete(id);
      this.cleanupTimer = setTimeout(() => {
        this.cleanupTimer = null;
        this.prune();
        if (!this.hosts.size) {
          if (this.timer) clearTimeout(this.timer);
          this.timer = null; this.registered = '';
          void this.api.command({ type: 'data.demand', clientId: this.clientId, points: [] });
        } else this.schedule(0);
      }, 0);
    };
  }

  invalidate(): void {
    this.epoch++;
    this.points.clear(); this.blocks.clear(); this.series.clear(); this.buffers.clear();
    this.plans.clear(); this.planIds.clear();
    this.registered = ''; this.renewAt = 0;
    for (const host of this.hosts.values()) host.due = 0;
    this.schedule(0);
  }

  invalidateLatest(): void {
    for (const entry of this.points.values()) entry.at = -Infinity;
    for (const entry of this.blocks.values()) entry.at = -Infinity;
    for (const host of this.hosts.values()) host.due = 0;
    this.schedule(0);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
    this.timer = null; this.hosts.clear(); this.epoch++;
    void this.api.command({ type: 'data.demand', clientId: this.clientId, points: [] });
  }

  private prune(): void {
    const points = new Set<string>(); const series = new Set<string>(); const buffers = new Set<string>();
    for (const host of this.hosts.values()) {
      for (const ref of host.needs.points) points.add(pointKey(ref.slaveId, ref.pointId));
      for (const ref of host.needs.series ?? []) series.add(pointKey(ref.slaveId, ref.pointId));
      for (const ref of host.needs.buffers ?? []) buffers.add(pointKey(ref.slaveId, ref.pointId));
    }
    for (const key of this.points.keys()) if (!points.has(key)) this.points.delete(key);
    // Point reads carry block status even when raw memory was not requested.
    if (!this.hosts.size) this.blocks.clear();
    for (const [key, cached] of this.series) if (!series.has(cached.pointKey)) this.series.delete(key);
    for (const key of this.buffers.keys()) if (!buffers.has(key) && !series.has(key)) this.buffers.delete(key);
  }

  private schedule(delay: number): void {
    if (!this.hosts.size) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.pump(); }, delay);
  }

  private async renewDemands(): Promise<void> {
    const refs = new Map<string, DataPointRef>();
    for (const host of this.hosts.values()) {
      for (const ref of host.needs.series ?? []) refs.set(pointKey(ref.slaveId, ref.pointId), { slaveId: ref.slaveId, pointId: ref.pointId });
    }
    const signature = JSON.stringify([...refs.keys()].sort());
    if (signature === this.registered && this.now() < this.renewAt) return;
    const result = await this.api.command({ type: 'data.demand', clientId: this.clientId, points: [...refs.values()] });
    if (!result.ok) throw new Error(result.error);
    this.registered = signature; this.renewAt = this.now() + 20000;
  }

  private seriesPlans(hosts: Host[]): SeriesPlan[] {
    const grouped = new Map<string, SeriesMember[]>();
    const now = Date.now();
    for (const host of hosts) {
      (host.needs.series ?? []).forEach((ref, index) => {
        const key = pointKey(ref.slaveId, ref.pointId);
        const members = grouped.get(key) ?? [];
        members.push({ host, index, ref, startMs: (ref.endMs ?? now) - (ref.windowMs ?? 60000), endMs: ref.endMs ?? now });
        grouped.set(key, members);
      });
    }
    const plans: SeriesPlan[] = [];
    const signatures = new Map<string, string>();
    for (const [key, members] of grouped) {
      members.sort((left, right) => left.startMs - right.startMs);
      const ranges: SeriesMember[][] = [];
      let end = -Infinity;
      for (const member of members) {
        if (!ranges.length || member.startMs > end) ranges.push([]);
        ranges.at(-1)!.push(member);
        end = Math.max(end, member.endMs);
      }
      for (const range of ranges) {
        const signature = JSON.stringify([key, range.map(member => [member.host.id, member.index, member.ref.windowMs, member.ref.endMs, member.ref.labels]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
        const id = this.planIds.get(signature) ?? `series-${++this.planSequence}`;
        signatures.set(signature, id);
        plans.push({ id, key, ref: range[0]!.ref, startMs: Math.min(...range.map(member => member.startMs)),
          endMs: range.some(member => member.ref.endMs === undefined) ? undefined : Math.max(...range.map(member => member.endMs)), members: range });
      }
    }
    this.planIds = signatures;
    this.plans = new Map(plans.map(plan => [plan.id, plan]));
    for (const id of this.series.keys()) if (!this.plans.has(id)) this.series.delete(id);
    for (const host of this.hosts.values()) for (const id of host.projections.keys()) if (!this.plans.has(id)) host.projections.delete(id);
    return plans;
  }

  private requestFor(hosts: Host[]): DataReadRequest {
    const now = this.now();
    const points = new Map<string, DataPointRef>();
    const blocks = new Map<string, { slaveId: string; blockId: string }>();
    const plans = this.seriesPlans(hosts);
    const series = new Map<string, SeriesRead>();
    const buffers = new Map<string, DataPointRef>();
    for (const host of hosts) {
      const due = host.due <= now;
      for (const ref of host.needs.points) {
        const key = pointKey(ref.slaveId, ref.pointId);
        if (due && now - (this.points.get(key)?.at ?? -Infinity) >= host.needs.intervalMs) points.set(key, ref);
      }
      for (const ref of host.needs.blocks ?? []) {
        const key = pointKey(ref.slaveId, ref.blockId);
        if (due && now - (this.blocks.get(key)?.at ?? -Infinity) >= host.needs.intervalMs) blocks.set(key, ref);
      }
      for (const ref of host.needs.buffers ?? []) {
        const key = pointKey(ref.slaveId, ref.pointId);
        if (due && now - (this.buffers.get(key)?.at ?? -Infinity) >= host.needs.intervalMs) buffers.set(key, ref);
      }
    }
    for (const plan of plans) {
      const cached = this.series.get(plan.id);
      const due = plan.members.filter(member => member.host.due <= now);
      const interval = Math.min(...due.map(member => member.host.needs.intervalMs));
      const expand = Boolean(cached && (plan.startMs < cached.startMs || cached.endMs !== undefined && (plan.endMs === undefined || plan.endMs > cached.endMs)));
      if (cached?.hasMore || due.length && (expand || now - (cached?.checkedAt ?? -Infinity) >= interval)) {
        series.set(plan.id, { slaveId: plan.ref.slaveId, pointId: plan.ref.pointId, queryId: plan.id,
          generation: cached?.generation, metadataVersion: cached?.metadataVersion,
          startMs: plan.startMs, endMs: plan.endMs, afterSeq: expand ? undefined : cached?.nextSeq, limit: 2000, ...(cached?.pending ?? {}) });
      }
      buffers.delete(plan.key);
    }
    return { type: 'data.read', format: 'columns-v1', points: [...points.values()], blocks: [...blocks.values()],
      buffers: [...buffers.entries()].map(([key, ref]) => ({ ...ref, metadataVersion: this.buffers.get(key)?.version })), series: [...series.values()] };
  }

  private apply(result: ColumnDataReadResult, request: DataReadRequest): void {
    const now = this.now();
    for (const ref of request.points) {
      const key = pointKey(ref.slaveId, ref.pointId);
      const value = result.points[key];
      if (!value) { this.points.delete(key); continue; }
      const previous = this.points.get(key)?.value;
      this.points.set(key, { value: previous && JSON.stringify(previous) === JSON.stringify(value) ? previous : value, at: now });
    }
    for (const [key, value] of Object.entries(result.blocks)) {
      const previous = this.blocks.get(key);
      // Status-only responses must not make old raw memory look freshly read.
      const raw = value.registers !== undefined || value.bits !== undefined;
      this.blocks.set(key, { value: raw ? value : { ...previous?.value, ...value, registers: previous?.value.registers, bits: previous?.value.bits }, at: raw ? now : previous?.at ?? -Infinity });
    }
    for (const ref of request.series) {
      const key = ref.queryId ?? pointKey(ref.slaveId, ref.pointId);
      const plan = this.plans.get(key);
      const page = result.series[key] ?? result.series[pointKey(ref.slaveId, ref.pointId)];
      if (!plan) continue;
      if (!page) throw new Error('曲线读取响应缺少查询结果');
      const previous = this.series.get(key);
      const sameGeneration = previous?.generation === page.generation && !page.reset;
      const metadata = page.metadata ?? (sameGeneration ? previous : undefined);
      if (!metadata) throw new Error('缓冲元信息缺失，请重新打开页面');
      const startMs = plan.startMs;
      const data = sameGeneration ? previous.data : new SeriesData();
      data.update(page.columns, page.firstSeq, startMs, plan.ref.labels, plan.endMs);
      const info: BufferInfo = { generation: page.generation, capacity: metadata.capacity, references: metadata.references, error: metadata.error,
        count: page.count, firstSeq: page.firstSeq, lastSeq: page.lastSeq, firstTimeMs: page.firstTimeMs, lastTimeMs: page.lastTimeMs };
      const loadedStart = Math.max(startMs, Math.min(sameGeneration ? previous.startMs : Infinity, ref.startMs ?? -Infinity));
      // Continuation pages retain the snapshot's original freshness deadline.
      const checkedAt = sameGeneration && previous.pending ? previous.checkedAt : now;
      for (const [id, stored] of this.series) if (stored.pointKey === plan.key && stored.generation !== page.generation) this.series.delete(id);
      this.series.set(key, { ...info, pointKey: plan.key, rangeStatus: page.rangeStatus, metadataVersion: page.metadataVersion, hasMore: page.hasMore, data, startMs: loadedStart, endMs: ref.endMs, checkedAt,
        nextSeq: Math.max(sameGeneration ? previous.nextSeq : 0, page.nextSeq), gap: page.gap || sameGeneration && previous.gap,
        pending: page.hasMore ? { afterSeq: page.nextSeq, throughSeq: page.throughSeq, startMs: ref.startMs, endMs: ref.endMs } : undefined });
      this.buffers.set(plan.key, { value: info, version: page.metadataVersion, at: now });
      this.metrics.samples += page.columns.times.length;
    }
    this.metrics.sampleBytes += result.sampleBytes ?? 0;
    for (const [key, value] of Object.entries(result.buffers)) {
      const previous = this.buffers.get(key);
      const metadata = value.metadata ?? previous?.value;
      if (!metadata) throw new Error('缓冲元信息缺失，请重新打开页面');
      this.buffers.set(key, { value: { generation: value.generation, count: value.count, firstSeq: value.firstSeq, lastSeq: value.lastSeq, firstTimeMs: value.firstTimeMs, lastTimeMs: value.lastTimeMs,
        capacity: metadata.capacity, references: metadata.references, error: metadata.error }, version: value.metadataVersion, at: now });
    }
  }

  private publish(host: Host): void {
    const values: HostValues = { points: {}, blocks: {}, series: {}, buffers: {}, error: this.error };
    for (const ref of host.needs.points) {
      const key = pointKey(ref.slaveId, ref.pointId);
      const cached = this.points.get(key);
      if (cached) values.points[key] = cached.value;
    }
    // Blocks contain current communication state for the requested point instances.
    const slaves = new Set(host.needs.points.map(ref => ref.slaveId));
    for (const ref of host.needs.blocks ?? []) slaves.add(ref.slaveId);
    for (const [key, entry] of this.blocks) if (slaves.has(entry.value.slaveId)) values.blocks[key] = entry.value;
    const displayed = new Map<string, CachedSeries[]>();
    for (const plan of this.plans.values()) {
      const members = plan.members.filter(member => member.host.id === host.id);
      if (!members.length) continue;
      const cached = this.series.get(plan.id);
      if (cached) {
        const projection = cached.data.project(host.projections.get(plan.id), Math.min(...members.map(member => member.startMs)), Math.max(...members.map(member => member.endMs)));
        host.projections.set(plan.id, projection);
        const parts = displayed.get(plan.key) ?? [];
        parts.push({ ...cached, data: projection });
        displayed.set(plan.key, parts);
      }
    }
    for (const [key, parts] of displayed) {
      values.series[key] = parts.length === 1 ? parts[0]! : { ...parts[0]!, hasMore: parts.some(part => part.hasMore), gap: parts.some(part => part.gap), data: {
        revision: Math.max(...parts.map(part => part.data.revision)),
        samples: mergeRows(parts.map(part => part.data.samples), row => row[2], row => row[0]),
        events: mergeRows(parts.map(part => part.data.events), row => row.seq, row => row.t),
      } };
      const current = this.buffers.get(key)?.value;
      if (current) Object.assign(values.series[key]!, current);
    }
    for (const ref of [...(host.needs.buffers ?? []), ...(host.needs.series ?? [])]) {
      const key = pointKey(ref.slaveId, ref.pointId);
      const info = this.buffers.get(key)?.value;
      if (info) values.buffers[key] = info;
    }
    host.deliver(values);
    host.due = this.now() + host.needs.intervalMs;
  }

  private async pump(): Promise<void> {
    if (this.inFlight || !this.hosts.size) return;
    this.inFlight = true;
    const epoch = this.epoch;
    try {
      if (this.now() < this.retryAt) return;
      await this.renewDemands();
      const active = [...this.hosts.values()].filter(host => host.needs.active);
      const request = this.requestFor(active);
      if (request.points.length || request.blocks.length || request.series.length || request.buffers.length) {
        const batches = Math.max(Math.ceil(request.points.length / 128), Math.ceil(request.blocks.length / 32), Math.ceil(request.series.length / 32), Math.ceil(request.buffers.length / 32));
        for (let batch = 0; batch < batches; batch++) {
          const part: DataReadRequest = { type: 'data.read', format: 'columns-v1', points: request.points.slice(batch * 128, (batch + 1) * 128), blocks: request.blocks.slice(batch * 32, (batch + 1) * 32), series: request.series.slice(batch * 32, (batch + 1) * 32), buffers: request.buffers.slice(batch * 32, (batch + 1) * 32) };
          this.metrics.requests++;
          const result = await this.api.command<ColumnDataReadResult>(part);
          if (epoch !== this.epoch || !this.hosts.size) return;
          if (!result.ok) throw new Error(result.error);
          this.seriesPlans([...this.hosts.values()].filter(host => host.needs.active));
          this.apply(result.value, part);
        }
      } else if (active.some(host => host.due <= this.now())) this.metrics.cacheHits++;
      this.error = null;
      for (const host of this.hosts.values()) if (host.needs.active && host.due <= this.now()) this.publish(host);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.retryAt = this.now() + 1000;
      for (const host of this.hosts.values()) if (host.needs.active) this.publish(host);
    } finally {
      this.inFlight = false;
      const now = this.now();
      const active = [...this.hosts.values()].filter(host => host.needs.active);
      const filling = [...this.plans.keys()].some(key => !this.series.has(key) || this.series.get(key)?.hasMore);
      const due = Math.min(this.renewAt, ...active.map(host => host.due));
      this.schedule(Math.max(4, this.retryAt - now, filling ? 4 : due - now));
    }
  }
}

const clients = new WeakMap<ModbusApi, FrontendDataCache>();
export function dataCacheFor(api: ModbusApi): FrontendDataCache {
  let cache = clients.get(api);
  if (!cache) { cache = new FrontendDataCache(api); clients.set(api, cache); }
  return cache;
}
