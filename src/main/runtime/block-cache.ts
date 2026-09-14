import { decodeRaw, type DecodedRaw, type PointMapping, type RawMemory } from '../../domain/mapping';
import type { BlockDef, SlaveDef } from '../../domain/model';
import type { ModbusResponse } from '../../domain/protocol';

export type BlockStatus = 'idle' | 'ok' | 'timeout' | 'exception' | 'transport-error' | 'disabled';

export interface BlockCacheEntry {
  sourceKey: string;
  key: string;
  slaveId: string;
  block: BlockDef;
  memory: RawMemory;
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
 * Recorder all read from here; nothing else creates polls.
 */
export class BlockCache {
  private entries = new Map<string, BlockCacheEntry>();
  private revision = 0;

  get globalRevision(): number {
    return this.revision;
  }

  ensure(slave: SlaveDef, block: BlockDef): BlockCacheEntry {
    const key = blockKey(slave.id, block.id);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        slaveId: slave.id,
        sourceKey: `${slave.connectionId}:${slave.unitId}`,
        block,
        memory: emptyMemory(block),
        status: 'idle',
        exceptionCode: null,
        lastUpdateUtc: null,
        lastDurationMs: null,
        consecutiveErrors: 0,
        revision: 0,
      };
      this.entries.set(key, entry);
    } else if (entry.block.length !== block.length || entry.block.area !== block.area || entry.block.start !== block.start || entry.sourceKey !== `${slave.connectionId}:${slave.unitId}`) {
      entry.sourceKey = `${slave.connectionId}:${slave.unitId}`;
      entry.block = block;
      entry.memory = emptyMemory(block);
      entry.status = 'idle';
      entry.lastUpdateUtc = null;
      entry.lastDurationMs = null;
      entry.exceptionCode = null;
      this.bump(entry);
    } else {
      const changed = JSON.stringify(entry.block) !== JSON.stringify(block);
      entry.block = block;
      if (changed) this.bump(entry);
    }
    return entry;
  }

  remove(slaveId: string, blockId: string): void {
    this.entries.delete(blockKey(slaveId, blockId));
    this.revision++;
  }

  removeSlave(slaveId: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(`${slaveId}::`)) this.entries.delete(key);
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

  applyReadResult(key: string, response: ModbusResponse, durationMs: number): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (response.kind === 'bits' && entry.memory.kind === 'bits') {
      entry.memory = { kind: 'bits', bits: response.bits.slice(0, entry.block.length) };
    } else if (response.kind === 'registers' && entry.memory.kind === 'registers') {
      const regs = new Uint16Array(entry.block.length);
      response.registers.slice(0, entry.block.length).forEach((r, i) => {
        regs[i] = r;
      });
      entry.memory = { kind: 'registers', registers: regs };
    } else {
      return;
    }
    entry.status = 'ok';
    entry.exceptionCode = null;
    entry.consecutiveErrors = 0;
    entry.lastUpdateUtc = new Date().toISOString();
    entry.lastDurationMs = durationMs;
    this.bump(entry);
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
    entry.lastUpdateUtc = new Date().toISOString();
    this.bump(entry);
  }

  applyBits(key: string, offset: number, bits: boolean[]): void {
    const entry = this.entries.get(key);
    if (!entry || entry.memory.kind !== 'bits') return;
    const out = entry.memory.bits.slice();
    bits.forEach((b, i) => {
      if (offset + i < out.length) out[offset + i] = b;
    });
    entry.memory = { kind: 'bits', bits: out };
    entry.lastUpdateUtc = new Date().toISOString();
    this.bump(entry);
  }

  markError(key: string, status: BlockStatus, exceptionCode: number | null = null): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.status = status;
    entry.exceptionCode = exceptionCode;
    entry.consecutiveErrors += 1;
    this.bump(entry);
  }

  decode(mapping: PointMapping, key: string): DecodedRaw | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    try {
      return decodeRaw(entry.memory, mapping);
    } catch {
      return null;
    }
  }

  private bump(entry: BlockCacheEntry): void {
    entry.revision++;
    this.revision++;
  }
}
