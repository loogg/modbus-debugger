import { decodeRaw, type DecodedRaw, type PointMapping, type RawMemory } from '../../domain/mapping';
import type { BlockDef, SlaveDef } from '../../domain/model';
import type { ModbusResponse } from '../../domain/protocol';
import { mappingWidth, type ReadRange } from '../../domain/point-access';

export type BlockStatus = 'idle' | 'ok' | 'timeout' | 'exception' | 'transport-error' | 'disabled';

export interface BlockCacheEntry {
  /** Identity of this binding, independent of value revisions (including A→B→A). */
  generation: number;
  sourceKey: string;
  key: string;
  slaveId: string;
  block: BlockDef;
  memory: RawMemory;
  valid: boolean[];
  readRanges: ReadRange[];
  status: BlockStatus;
  exceptionCode: number | null;
  lastUpdateUtc: string | null;
  lastDurationMs: number | null;
  consecutiveErrors: number;
  revision: number;
}

export function blockKey(slaveId: string, blockId: string): string {
  return `${slaveId}::${blockId}`;
}

function emptyMemory(block: BlockDef): RawMemory {
  if (block.area === 1 || block.area === 2) {
    return { kind: 'bits', bits: new Array<boolean>(block.length).fill(false) };
  }
  return { kind: 'registers', registers: new Uint16Array(block.length) };
}

/**
 * Single source of truth for confirmed device raw memory. Realtime, Trend and the
 * sample buffers all read from here; nothing else creates polls.
 */
export class BlockCache {
  /** Runs only after a confirmed memory update, never for status/metadata revisions. */
  onConfirmed: ((entry: BlockCacheEntry, range: ReadRange) => void) | null = null;
  private entries = new Map<string, BlockCacheEntry>();
  private revision = 0;
  private generation = 0;
  private owners = new Map<string, object>();
  private readonly addressTimes = new WeakMap<BlockCacheEntry, Float64Array>();
  private readErrors = new Map<string, Map<string, { status: BlockStatus; code: number | null }>>();

  get globalRevision(): number {
    return this.revision;
  }

  ensure(slave: SlaveDef, block: BlockDef, owner?: object, readRanges: ReadRange[] = [{ offset: 0, length: block.length }]): BlockCacheEntry {
    const key = blockKey(slave.id, block.id);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        generation: ++this.generation,
        key,
        slaveId: slave.id,
        sourceKey: `${slave.connectionId}:${slave.unitId}`,
        block,
        memory: emptyMemory(block),
        valid: new Array<boolean>(block.length).fill(false),
        readRanges,
        status: 'idle',
        exceptionCode: null,
        lastUpdateUtc: null,
        lastDurationMs: null,
        consecutiveErrors: 0,
        revision: 0,
      };
      this.entries.set(key, entry);
    } else if ((owner !== undefined && this.owners.get(key) !== owner) || entry.block.length !== block.length || entry.block.area !== block.area || entry.block.start !== block.start || entry.sourceKey !== `${slave.connectionId}:${slave.unitId}` || JSON.stringify(entry.readRanges) !== JSON.stringify(readRanges)) {
      entry.generation = ++this.generation;
      this.addressTimes.delete(entry);
      entry.sourceKey = `${slave.connectionId}:${slave.unitId}`;
      entry.block = block;
      entry.memory = emptyMemory(block);
      entry.valid = new Array<boolean>(block.length).fill(false);
      entry.readRanges = readRanges;
      this.readErrors.delete(key);
      entry.status = 'idle';
      entry.lastUpdateUtc = null;
      entry.lastDurationMs = null;
      entry.exceptionCode = null;
      entry.consecutiveErrors = 0;
      this.bump(entry);
    } else {
      const changed = JSON.stringify(entry.block) !== JSON.stringify(block);
      entry.block = block;
      if (changed) this.bump(entry);
    }
    if (owner !== undefined) this.owners.set(key, owner);
    return entry;
  }

  remove(slaveId: string, blockId: string): void {
    this.entries.delete(blockKey(slaveId, blockId));
    this.readErrors.delete(blockKey(slaveId, blockId));
    this.owners.delete(blockKey(slaveId, blockId));
    this.revision++;
  }

  removeSlave(slaveId: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(`${slaveId}::`)) { this.entries.delete(key); this.owners.delete(key); this.readErrors.delete(key); }
    }
    this.revision++;
  }

  get(key: string): BlockCacheEntry | undefined {
    return this.entries.get(key);
  }

  entriesForSlave(slaveId: string): BlockCacheEntry[] {
    return [...this.entries.values()].filter((e) => e.slaveId === slaveId);
  }

  all(): BlockCacheEntry[] {
    return [...this.entries.values()];
  }

  setDisabled(slaveId: string, disabled: boolean): void {
    for (const entry of this.entriesForSlave(slaveId)) {
      entry.status = disabled ? 'disabled' : 'idle';
      this.bump(entry);
    }
  }

  applyReadResult(key: string, response: ModbusResponse, durationMs: number, offset = 0, length?: number): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    const limit = Math.min(length ?? entry.block.length, entry.block.length - offset);
    let count = 0;
    if (response.kind === 'bits' && entry.memory.kind === 'bits') {
      count = Math.min(limit, response.bits.length);
      const bits = entry.memory.bits.slice();
      bits.splice(offset, count, ...response.bits.slice(0, count));
      entry.memory = { kind: 'bits', bits };
    } else if (response.kind === 'registers' && entry.memory.kind === 'registers') {
      count = Math.min(limit, response.registers.length);
      const regs = entry.memory.registers.slice();
      regs.set(response.registers.slice(0, count), offset);
      entry.memory = { kind: 'registers', registers: regs };
    } else {
      return;
    }
    if (count <= 0) return;
    entry.valid.fill(true, offset, offset + count);
    const errors = this.readErrors.get(key);
    if (offset === 0 && count === entry.block.length) errors?.clear();
    else errors?.delete(`${offset}:${count}`);
    const error = errors?.values().next().value;
    entry.status = error?.status ?? 'ok';
    entry.exceptionCode = error?.code ?? null;
    if (!error) entry.consecutiveErrors = 0;
    this.stamp(entry, offset, count);
    entry.lastDurationMs = durationMs;
    this.bump(entry);
    this.onConfirmed?.(entry, { offset, length: count });
  }

  /** Merge confirmed registers written by a write sequence back into the cache. */
  applyRegisters(key: string, offset: number, registers: number[]): void {
    const entry = this.entries.get(key);
    if (!entry || entry.memory.kind !== 'registers') return;
    const regs = entry.memory.registers.slice();
    registers.forEach((r, i) => {
      if (offset + i < regs.length) regs[offset + i] = r;
    });
    entry.memory = { kind: 'registers', registers: regs };
    entry.valid.fill(true, offset, Math.min(entry.block.length, offset + registers.length));
    this.stamp(entry, offset, registers.length);
    this.bump(entry);
    this.onConfirmed?.(entry, { offset, length: registers.length });
  }

  applyBits(key: string, offset: number, bits: boolean[]): void {
    const entry = this.entries.get(key);
    if (!entry || entry.memory.kind !== 'bits') return;
    const out = entry.memory.bits.slice();
    bits.forEach((b, i) => {
      if (offset + i < out.length) out[offset + i] = b;
    });
    entry.memory = { kind: 'bits', bits: out };
    entry.valid.fill(true, offset, Math.min(entry.block.length, offset + bits.length));
    this.stamp(entry, offset, bits.length);
    this.bump(entry);
    this.onConfirmed?.(entry, { offset, length: bits.length });
  }

  markError(key: string, status: BlockStatus, exceptionCode: number | null = null, range?: ReadRange): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    const errors = this.readErrors.get(key) ?? new Map<string, { status: BlockStatus; code: number | null }>();
    errors.set(`${range?.offset ?? 0}:${range?.length ?? entry.block.length}`, { status, code: exceptionCode });
    this.readErrors.set(key, errors);
    entry.status = status;
    entry.exceptionCode = exceptionCode;
    entry.consecutiveErrors += 1;
    this.bump(entry);
  }

  readFailure(key: string, span: ReadRange): { status: BlockStatus; code: number | null } | undefined {
    const errors = this.readErrors.get(key);
    if (!errors) return undefined;
    for (const [range, error] of errors) {
      const [offset, length] = range.split(':').map(Number) as [number, number];
      if (offset < span.offset + span.length && span.offset < offset + length) return error;
    }
    return undefined;
  }

  decode(mapping: PointMapping, key: string): DecodedRaw | null {
    const entry = this.entries.get(key);
    if (!entry || !this.mappingValid(entry, mapping)) return null;
    try {
      return decodeRaw(entry.memory, mapping);
    } catch {
      return null;
    }
  }

  mappingValid(entry: BlockCacheEntry, mapping: PointMapping): boolean {
    const length = mappingWidth(entry.block.area, mapping);
    return mapping.offset + length <= entry.valid.length && entry.valid.slice(mapping.offset, mapping.offset + length).every(Boolean);
  }

  private stamp(entry: BlockCacheEntry, offset: number, length: number): void {
    const now = new Date();
    if (offset === 0 && length >= entry.block.length) this.addressTimes.delete(entry);
    else {
      let times = this.addressTimes.get(entry);
      if (!times) {
        times = new Float64Array(entry.block.length).fill(entry.lastUpdateUtc ? Date.parse(entry.lastUpdateUtc) : 0);
        this.addressTimes.set(entry, times);
      }
      times.fill(now.getTime(), offset, offset + length);
    }
    entry.lastUpdateUtc = now.toISOString();
  }

  confirmedAt(key: string, range: ReadRange): number | undefined {
    const entry = this.entries.get(key);
    if (!entry?.lastUpdateUtc) return undefined;
    const times = this.addressTimes.get(entry);
    if (!times) return Date.parse(entry.lastUpdateUtc);
    const time = times[range.offset];
    for (let i = 1; i < range.length; i++) if (times[range.offset + i] !== time) return undefined;
    return time || undefined;
  }

  private bump(entry: BlockCacheEntry): void {
    entry.revision++;
    this.revision++;
  }
}
