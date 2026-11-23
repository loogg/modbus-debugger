import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Workspace, PointDef, SlaveDef } from '../../domain/model';
import { decodeRaw } from '../../domain/mapping';
import { toEngineering } from '../../domain/scale';
import { bufferCapacity, bufferReferences } from '../../domain/point-buffers';
import { pointKey } from '../../shared/point-key';
import type { BufferExportResult, BufferInfo, ColumnBufferInfo, ColumnSeriesPage, DataPointRef, PointSample, SeriesPage, SeriesRead } from '../../shared/point-data';
import { MAX_TOTAL_BUFFER_CAPACITY } from '../../shared/point-data';
import { sampleColumns, sampleValueBytes } from '../../shared/sample-columns';
import { canReadPoint, mappingWidth, type ReadRange } from '../../domain/point-access';
import type { BlockCache, BlockCacheEntry } from './block-cache';
import { blockKey } from './block-cache';
import type { Clock } from '../../domain/protocol';

interface Target { point: PointDef; slave: SlaveDef; references: string[]; capacity: number; signature: string }

class SampleRing {
  private rows: Array<PointSample | undefined>;
  private head = 0;
  count = 0;
  lastSeq = 0;
  private orderedTime = true;
  constructor(public capacity: number, readonly generation: string, readonly signature: string) {
    this.rows = new Array(capacity);
  }
  append(timeMs: number, monoMs: number, value: PointSample['value']): void {
    if (timeMs < (this.at(this.lastSeq)?.timeMs ?? -Infinity)) this.orderedTime = false;
    this.rows[this.head] = { seq: ++this.lastSeq, timeMs, monoMs, value };
    this.head = (this.head + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
  }
  get firstSeq(): number { return this.lastSeq - this.count + 1; }
  rangeStatus(start?: number, end?: number): SeriesPage['rangeStatus'] {
    if (!this.count || !this.orderedTime) return undefined;
    const first = this.at(this.firstSeq)!.timeMs;
    if (end !== undefined && end < first) return 'expired';
    if (this.firstSeq > 1 && start !== undefined && start < first) return 'partial';
    return 'available';
  }
  at(sequence: number): PointSample | undefined {
    if (sequence < this.firstSeq || sequence > this.lastSeq) return undefined;
    const firstIndex = (this.head - this.count + this.capacity) % this.capacity;
    return this.rows[(firstIndex + sequence - this.firstSeq) % this.capacity];
  }
  /** UTC normally increases. A clock rollback falls back to exact sequence scanning. */
  firstAtTime(startMs: number, throughSeq: number): number {
    if (!this.orderedTime) return this.firstSeq;
    let low = this.firstSeq;
    let high = throughSeq + 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.at(middle)!.timeMs < startMs) low = middle + 1;
      else high = middle;
    }
    return low;
  }
  resize(capacity: number): void {
    if (capacity === this.capacity) return;
    const count = Math.min(capacity, this.count);
    const rows = new Array<PointSample | undefined>(capacity);
    for (let index = 0; index < count; index++) rows[index] = this.at(this.lastSeq - count + 1 + index);
    this.rows = rows;
    this.capacity = capacity;
    this.count = count;
    this.head = count % capacity;
  }
  snapshot(startMs = -Infinity, endMs = Infinity): PointSample[] {
    const rows: PointSample[] = [];
    for (let sequence = this.firstSeq; sequence <= this.lastSeq; sequence++) {
      const sample = this.at(sequence)!;
      if (sample.timeMs >= startMs && sample.timeMs <= endMs) rows.push(sample);
    }
    return rows;
  }
}

/** Shared, non-destructive sample storage owned by Main. */
export class SampleBuffers {
  private targets = new Map<string, Target>();
  private byBlock = new Map<string, string[]>();
  private rings = new Map<string, SampleRing>();
  private demands = new Map<string, { points: DataPointRef[]; expiresAt: number }>();
  private workspace: Workspace | null = null;
  private epoch = randomUUID();
  private generation = 0;
  private errors = new Map<string, string>();
  private metadata = new Map<string, { signature: string; version: string }>();
  private metadataSerial = 0;

  constructor(private readonly cache: BlockCache, private readonly clock: Clock) {}

  setDemand(clientId: string, points: DataPointRef[], workspace: Workspace): void {
    if (points.length) this.demands.set(clientId, { points, expiresAt: this.clock.now() + 60000 });
    else this.demands.delete(clientId);
    this.reconcile(workspace);
  }

  expire(workspace: Workspace): void {
    let changed = false;
    for (const [id, demand] of this.demands) {
      if (demand.expiresAt <= this.clock.now()) { this.demands.delete(id); changed = true; }
    }
    if (changed) this.reconcile(workspace);
  }

  reset(): void {
    this.demands.clear(); this.rings.clear(); this.targets.clear(); this.byBlock.clear(); this.errors.clear(); this.metadata.clear();
    this.workspace = null; this.epoch = randomUUID(); this.generation = 0;
  }

  reconcile(workspace: Workspace): void {
    this.workspace = workspace;
    const references = bufferReferences(workspace);
    for (const demand of this.demands.values()) {
      for (const ref of demand.points) {
        const key = pointKey(ref.slaveId, ref.pointId);
        if (!references.has(key)) references.set(key, { ...ref, references: ['编辑中的曲线'] });
      }
    }
    const targets = new Map<string, Target>();
    const byBlock = new Map<string, string[]>();
    const templates = new Map(workspace.templates.map(template => [template.id, template]));
    const pointIndex = new Map<string, { slave: SlaveDef; point: PointDef }>();
    for (const slave of workspace.slaves) {
      for (const point of templates.get(slave.templateId)?.points ?? []) pointIndex.set(pointKey(slave.id, point.id), { slave, point });
    }
    this.errors.clear();
    let allocated = 0;
    for (const [key, ref] of references) {
      const indexed = pointIndex.get(key);
      if (!indexed) continue;
      const { slave, point } = indexed;
      if (!canReadPoint(point)) { this.errors.set(key, '只写点位提供命令结果，采样请选择可读点位'); continue; }
      const capacity = bufferCapacity(workspace, ref);
      if (allocated + capacity > MAX_TOTAL_BUFFER_CAPACITY) {
        this.errors.set(key, `缓冲总容量超过 ${MAX_TOTAL_BUFFER_CAPACITY.toLocaleString()} 点，请减小共享容量`);
        continue;
      }
      allocated += capacity;
      const block = this.cache.get(blockKey(slave.id, point.blockId));
      const signature = JSON.stringify([slave.connectionId, slave.unitId, point.blockId, point.mapping, point.scale, point.offset, Boolean(Object.keys(point.enumMap).length), block?.generation]);
      const target = { point, slave, capacity, references: ref.references, signature };
      targets.set(key, target);
      const blockId = blockKey(slave.id, point.blockId);
      byBlock.set(blockId, [...(byBlock.get(blockId) ?? []), key]);
      const current = this.rings.get(key);
      if (!current || current.signature !== signature) this.rings.set(key, new SampleRing(capacity, `${this.epoch}:${++this.generation}`, signature));
      else current.resize(capacity);
    }
    for (const key of this.rings.keys()) if (!targets.has(key)) { this.rings.delete(key); this.metadata.delete(key); }
    this.targets = targets; this.byBlock = byBlock;
  }

  confirmed(entry: BlockCacheEntry, workspace: Workspace, range: ReadRange = { offset: 0, length: entry.block.length }): void {
    if (workspace !== this.workspace) this.reconcile(workspace);
    const keys = this.byBlock.get(entry.key);
    if (!keys?.length) return;
    // Reconfiguration can replace raw memory without changing the workspace object.
    const first = this.targets.get(keys[0]!)!;
    const signature = JSON.stringify([first.slave.connectionId, first.slave.unitId, first.point.blockId, first.point.mapping, first.point.scale, first.point.offset, Boolean(Object.keys(first.point.enumMap).length), entry.generation]);
    if (first.signature !== signature) this.reconcile(workspace);
    const timeMs = Date.parse(entry.lastUpdateUtc ?? '');
    if (!Number.isFinite(timeMs)) return;
    const monoMs = this.clock.now();
    for (const key of this.byBlock.get(entry.key) ?? []) {
      const target = this.targets.get(key)!;
      if (target.point.mapping.offset < range.offset || target.point.mapping.offset + mappingWidth(entry.block.area, target.point.mapping) > range.offset + range.length || !this.cache.mappingValid(entry, target.point.mapping)) continue;
      try {
        const raw = decodeRaw(entry.memory, target.point.mapping);
        const value = typeof raw === 'number' && !Object.keys(target.point.enumMap).length
          ? toEngineering(raw, target.point) : raw;
        if (typeof value === 'number' && !Number.isFinite(value)) continue;
        this.rings.get(key)!.append(timeMs, monoMs, value);
      } catch { /* Invalid decoding does not create a numeric sample. */ }
    }
  }

  info(ref: DataPointRef): BufferInfo {
    const key = pointKey(ref.slaveId, ref.pointId);
    const ring = this.rings.get(key);
    return {
      generation: ring?.generation ?? '', capacity: ring?.capacity ?? (this.workspace ? bufferCapacity(this.workspace, ref) : 0),
      count: ring?.count ?? 0, firstSeq: ring?.firstSeq ?? 1, lastSeq: ring?.lastSeq ?? 0,
      firstTimeMs: ring?.at(ring.firstSeq)?.timeMs ?? null, lastTimeMs: ring?.at(ring.lastSeq)?.timeMs ?? null,
      references: this.targets.get(key)?.references ?? [],
      ...(this.errors.has(key) ? { error: this.errors.get(key) } : {}),
    };
  }

  read(request: SeriesRead, remaining: number, maxBytes = Infinity, firstSampleBytes = maxBytes): SeriesPage {
    const info = this.info(request);
    const ring = this.rings.get(pointKey(request.slaveId, request.pointId));
    const reset = request.generation !== undefined && request.generation !== info.generation;
    const after = reset ? 0 : request.afterSeq ?? 0;
    const requestedEnd = Math.min(request.throughSeq ?? info.lastSeq, info.lastSeq);
    const throughSeq = reset || requestedEnd < info.firstSeq - 1 ? info.lastSeq : requestedEnd;
    const gap = !reset && request.afterSeq !== undefined && after < info.firstSeq - 1;
    const samples: PointSample[] = [];
    let nextSeq = Math.max(after, info.firstSeq - 1);
    const limit = Math.min(request.limit, remaining);
    let bytes = 0;
    if (ring && limit > 0) {
      if (request.afterSeq === undefined || reset) nextSeq = Math.max(nextSeq, ring.firstAtTime(request.startMs ?? -Infinity, throughSeq) - 1);
      for (let sequence = nextSeq + 1; sequence <= throughSeq; sequence++) {
        const sample = ring.at(sequence)!;
        if (sample.timeMs >= (request.startMs ?? -Infinity) && sample.timeMs <= (request.endMs ?? Infinity)) {
          const size = sampleValueBytes(sample.value);
          if (bytes + size > maxBytes && !(samples.length === 0 && size <= firstSampleBytes)) break;
          samples.push(sample);
          bytes += size;
        }
        nextSeq = sequence;
        if (samples.length >= limit) break;
      }
    }
    return { ...info, samples, nextSeq, throughSeq, hasMore: nextSeq < throughSeq, gap, reset, rangeStatus: ring?.rangeStatus(request.startMs, request.endMs) };
  }

  readColumns(request: SeriesRead, remaining: number, maxBytes: number, firstSampleBytes = maxBytes): ColumnSeriesPage {
    const { samples, ...page } = this.read(request, remaining, maxBytes, firstSampleBytes);
    return { ...this.columnInfo(request, page), columns: sampleColumns(samples), nextSeq: page.nextSeq, throughSeq: page.throughSeq, hasMore: page.hasMore, gap: page.gap, reset: page.reset };
  }

  infoColumns(request: DataPointRef & { metadataVersion?: string }): ColumnBufferInfo {
    return this.columnInfo(request, this.info(request));
  }

  private columnInfo(request: DataPointRef & { metadataVersion?: string }, info: BufferInfo): ColumnBufferInfo {
    const { capacity, references, error, ...state } = info;
    const key = pointKey(request.slaveId, request.pointId);
    const signature = JSON.stringify([info.generation, capacity, references, error]);
    let metadata = this.metadata.get(key);
    if (metadata?.signature !== signature) {
      metadata = { signature, version: `${this.epoch}:m${++this.metadataSerial}` };
      this.metadata.set(key, metadata);
    }
    return { ...state, metadataVersion: metadata!.version,
      ...(request.metadataVersion === metadata!.version ? {} : { metadata: { capacity, references, ...(error ? { error } : {}) } }) };
  }

  async exportCsv(refs: DataPointRef[], output: string, startMs?: number, endMs?: number): Promise<BufferExportResult> {
    if (!path.isAbsolute(output)) throw new Error('请选择绝对路径');
    if (startMs !== undefined && endMs !== undefined && startMs > endMs) throw new Error('导出起止时间无效');
    const snapshots = [...new Map(refs.map(ref => [pointKey(ref.slaveId, ref.pointId), ref])).keys()].map(key => {
      const target = this.targets.get(key);
      const ring = this.rings.get(key);
      if (!target || !ring) throw new Error('所选点位尚未启用采样缓冲');
      const connectionName = this.workspace?.connections.find(item => item.id === target.slave.connectionId)?.name ?? target.slave.connectionId;
      return { target, connectionName, generation: ring.generation, rows: ring.snapshot(startMs, endMs) };
    });
    const count = snapshots.reduce((total, item) => total + item.rows.length, 0);
    if (!count) throw new Error('所选时间范围没有可导出的样本');
    const temporary = `${output}.${randomUUID()}.tmp`;
    const stream = fs.createWriteStream(temporary, { encoding: 'utf8', flags: 'wx' });
    const completed = once(stream, 'finish');
    // Observe failures immediately, including errors while waiting for drain.
    void completed.catch(() => undefined);
    const cell = (value: unknown) => `"${String(value).replaceAll('"', '""')}"`;
    let firstTimeMs = Infinity;
    let lastTimeMs = -Infinity;
    try {
      stream.write('\uFEFF连接,设备,设备实例ID,点位,点位ID,单位,时间UTC,单调时间ms,缓冲代次,序号,值\r\n');
      let batch = '';
      let batchCount = 0;
      for (const { target, connectionName, generation, rows } of snapshots) {
        for (const sample of rows) {
          firstTimeMs = Math.min(firstTimeMs, sample.timeMs); lastTimeMs = Math.max(lastTimeMs, sample.timeMs);
          batch += [connectionName, target.slave.name, target.slave.id, target.point.name, target.point.id, target.point.unit, new Date(sample.timeMs).toISOString(), sample.monoMs, generation, sample.seq, sample.value].map(cell).join(',') + '\r\n';
          if (++batchCount >= 500) {
            if (!stream.write(batch)) await Promise.race([once(stream, 'drain'), completed]);
            batch = ''; batchCount = 0;
            await new Promise<void>(resolve => setImmediate(resolve));
          }
        }
      }
      stream.end(batch);
      await completed;
      await fs.promises.rename(temporary, output);
      return { path: output, count, firstTimeMs, lastTimeMs };
    } catch (error) {
      stream.destroy();
      await fs.promises.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
