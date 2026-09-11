import { checkCrc } from './crc';
import { RTU_MAX_ADU } from './rtu';
import { mbapLengthValid, MBAP_LENGTH, TCP_MAX_ADU } from './tcp';
import { FC } from './types';

const KNOWN_FC = new Set<number>([FC.ReadCoils, FC.ReadDiscreteInputs, FC.ReadHoldingRegisters, FC.ReadInputRegisters, FC.WriteSingleCoil, FC.WriteSingleRegister, FC.WriteMultipleCoils, FC.WriteMultipleRegisters, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x8f, 0x90]);

export interface Clock {
  /** monotonic milliseconds */
  now(): number;
}

export const systemClock: Clock = {
  now: () => {
    const [s, ns] = process.hrtime();
    return s * 1000 + ns / 1e6;
  },
};

export type ParseErrorKind = 'crc' | 'malformed' | 'truncated' | 'overflow';

export type FramerEvent =
  | { type: 'adu'; bytes: Uint8Array }
  | {
      type: 'parse-error';
      kind: ParseErrorKind;
      reason: string;
      raw: Uint8Array;
      discarded: number;
      recovered: Uint8Array[];
    };

export interface FramerHooks {
  /** Expected ADU length of the current in-flight response, or null when unknown. */
  expectedAduLength?: () => number | null;
}

export interface Framer {
  push(chunk: Uint8Array, atMs?: number): FramerEvent[];
  tick(atMs?: number): FramerEvent[];
  reset(): void;
  pendingBytes(): number;
  /** monotonic time of last received byte, or null when idle */
  lastByteTime(): number | null;
}

const DEFAULT_MAX_BUFFER = 4096;
const DEFAULT_INCOMPLETE_TIMEOUT_MS = 1000;

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Scan a discarded byte range for self-consistent RTU frames (valid CRC) so that a legal
 * frame glued to noise / a bad frame is recovered instead of being thrown away.
 */
export function recoverRtuFrames(bytes: Uint8Array): Uint8Array[] {
  const found: Uint8Array[] = [];
  let o = 0;
  while (o + 4 <= bytes.length) {
    let hit: Uint8Array | null = null;
    const maxLen = Math.min(RTU_MAX_ADU, bytes.length - o);
    for (let len = 4; len <= maxLen; len++) {
      if (checkCrc(bytes.subarray(o, o + len))) {
        hit = bytes.slice(o, o + len);
        break;
      }
    }
    if (hit) {
      found.push(hit);
      o += hit.length;
    } else {
      o += 1;
    }
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* TCP                                                                 */
/* ------------------------------------------------------------------ */

export interface TcpFramerOptions extends FramerHooks {
  clock?: Clock;
  maxBuffer?: number;
  incompleteTimeoutMs?: number;
}

export class TcpStreamingFramer implements Framer {
  private buf: Uint8Array = new Uint8Array(0);
  private lastByte: number | null = null;
  private candidateStart = 0;
  private readonly clock: Clock;
  private readonly maxBuffer: number;
  private readonly incompleteTimeoutMs: number;
  private readonly hooks: FramerHooks;

  constructor(opts: TcpFramerOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
    this.incompleteTimeoutMs = opts.incompleteTimeoutMs ?? DEFAULT_INCOMPLETE_TIMEOUT_MS;
    this.hooks = opts;
  }

  pendingBytes(): number {
    return this.buf.length;
  }
  lastByteTime(): number | null {
    return this.lastByte;
  }
  reset(): void {
    this.buf = new Uint8Array(0);
    this.lastByte = null;
  }

  push(chunk: Uint8Array, atMs?: number): FramerEvent[] {
    const at = atMs ?? this.clock.now();
    if (this.buf.length === 0) this.candidateStart = at;
    this.buf = concat(this.buf, chunk);
    this.lastByte = at;
    return this.drain(at);
  }

  tick(atMs?: number): FramerEvent[] {
    return this.drain(atMs ?? this.clock.now());
  }

  private drain(at: number): FramerEvent[] {
    const events: FramerEvent[] = [];
    for (;;) {
      if (this.buf.length > this.maxBuffer) {
        events.push(this.fail('overflow', `receive buffer exceeded ${this.maxBuffer} bytes`, this.buf.length));
        continue;
      }
      if (this.buf.length < MBAP_LENGTH + 1) {
        if (this.buf.length > 0 && at - this.candidateStart > this.incompleteTimeoutMs) {
          events.push(this.fail('truncated', 'incomplete MBAP header timed out', this.buf.length));
        }
        return events;
      }
      const proto = ((this.buf[2] as number) << 8) | (this.buf[3] as number);
      const len = ((this.buf[4] as number) << 8) | (this.buf[5] as number);
      const headerBad = proto !== 0 || !mbapLengthValid(len);
      const total = MBAP_LENGTH + len;
      if (headerBad || total > TCP_MAX_ADU) {
        // Controlled resync: find the next plausible MBAP start instead of clearing everything.
        const next = this.findMbapStart(1);
        const raw = this.buf.slice(0, next === -1 ? this.buf.length : next);
        const recovered: Uint8Array[] = [];
        events.push({
          type: 'parse-error',
          kind: 'malformed',
          reason: headerBad
            ? `illegal MBAP (proto=${proto}, length=${len})`
            : `MBAP length ${len} exceeds TCP ADU limit`,
          raw,
          discarded: raw.length,
          recovered,
        });
        this.buf = next === -1 ? new Uint8Array(0) : this.buf.slice(next);
        if (this.buf.length) this.candidateStart = at;
        continue;
      }
      if (this.buf.length < total) {
        if (at - this.candidateStart > this.incompleteTimeoutMs) {
          events.push(this.fail('truncated', `truncated candidate frame (${this.buf.length}/${total} bytes)`, this.buf.length));
        }
        return events;
      }
      const adu = this.buf.slice(0, total);
      this.buf = this.buf.slice(total);
      if (this.buf.length) this.candidateStart = at;
      events.push({ type: 'adu', bytes: adu });
    }
  }

  /** Scan for the next self-consistent MBAP start: proto 0, sane length, complete in buffer, known FC. */
  private findMbapStart(from: number): number {
    for (let o = from; o + MBAP_LENGTH + 1 <= this.buf.length; o++) {
      const proto = ((this.buf[o + 2] as number) << 8) | (this.buf[o + 3] as number);
      const len = ((this.buf[o + 4] as number) << 8) | (this.buf[o + 5] as number);
      const total = MBAP_LENGTH + len;
      if (proto !== 0 || !mbapLengthValid(len) || total > TCP_MAX_ADU) continue;
      if (o + total > this.buf.length) continue;
      if (!KNOWN_FC.has(this.buf[o + 7] as number)) continue;
      return o;
    }
    return -1;
  }

  private fail(kind: ParseErrorKind, reason: string, discarded: number): FramerEvent {
    const raw = this.buf.slice(0);
    this.buf = new Uint8Array(0);
    return { type: 'parse-error', kind, reason, raw, discarded, recovered: [] };
  }
}

/* ------------------------------------------------------------------ */
/* RTU                                                                 */
/* ------------------------------------------------------------------ */

export interface RtuFramerOptions extends FramerHooks {
  clock?: Clock;
  baudRate?: number;
  maxBuffer?: number;
  incompleteTimeoutMs?: number;
}

export class RtuStreamingFramer implements Framer {
  private buf: Uint8Array = new Uint8Array(0);
  private lastByte: number | null = null;
  private candidateStart = 0;
  private readonly clock: Clock;
  private readonly maxBuffer: number;
  private readonly incompleteTimeoutMs: number;
  private readonly hooks: FramerHooks;

  constructor(opts: RtuFramerOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
    this.incompleteTimeoutMs = opts.incompleteTimeoutMs ?? DEFAULT_INCOMPLETE_TIMEOUT_MS;
    this.hooks = opts;
  }

  pendingBytes(): number {
    return this.buf.length;
  }
  lastByteTime(): number | null {
    return this.lastByte;
  }
  reset(): void {
    this.buf = new Uint8Array(0);
    this.lastByte = null;
  }

  push(chunk: Uint8Array, atMs?: number): FramerEvent[] {
    const at = atMs ?? this.clock.now();
    if (this.buf.length === 0) this.candidateStart = at;
    this.buf = concat(this.buf, chunk);
    this.lastByte = at;
    return this.drain(at);
  }

  tick(atMs?: number): FramerEvent[] {
    return this.drain(atMs ?? this.clock.now());
  }

  /**
   * Timing-free framing: expected response length first, otherwise a trusted-boundary
   * CRC scan. Inter-chunk gaps play no role at all.
   */
  private drain(at: number): FramerEvent[] {
    const events: FramerEvent[] = [];
    for (;;) {
      if (this.buf.length > this.maxBuffer) {
        const raw = this.buf;
        const recovered = recoverRtuFrames(raw);
        events.push({ type: 'parse-error', kind: 'overflow', reason: `receive buffer exceeded ${this.maxBuffer} bytes`, raw, discarded: raw.length, recovered });
        for (const r of recovered) events.push({ type: 'adu', bytes: r });
        this.buf = new Uint8Array(0);
        continue;
      }
      const expected = this.hooks.expectedAduLength?.() ?? null;
      if (expected !== null && this.buf.length >= expected) {
        const cand = this.buf.slice(0, expected);
        this.buf = this.buf.slice(expected);
        if (this.buf.length) this.candidateStart = at;
        events.push(...this.evaluate(cand));
        continue;
      }
      if (expected === null && this.buf.length >= 4) {
        const hit = this.scanTrustedFrame();
        if (hit) {
          if (hit.offset > 0) {
            events.push({
              type: 'parse-error',
              kind: 'malformed',
              reason: 'resync: discarded unrecoverable prefix before trusted CRC boundary',
              raw: this.buf.slice(0, hit.offset),
              discarded: hit.offset,
              recovered: [hit.frame],
            });
          }
          this.buf = this.buf.slice(hit.offset + hit.frame.length);
          if (this.buf.length) this.candidateStart = at;
          events.push({ type: 'adu', bytes: hit.frame });
          continue;
        }
      }
      if (this.buf.length > 0 && at - this.candidateStart > this.incompleteTimeoutMs) {
        const raw = this.buf;
        const recovered = recoverRtuFrames(raw);
        events.push({ type: 'parse-error', kind: 'truncated', reason: 'candidate frame never completed within wait budget', raw, discarded: raw.length, recovered });
        for (const r of recovered) events.push({ type: 'adu', bytes: r });
        this.buf = new Uint8Array(0);
        continue;
      }
      return events;
    }
  }

  /** First CRC-valid frame at offset 0, else first offset where a CRC-valid frame starts. */
  private scanTrustedFrame(): { offset: number; frame: Uint8Array } | null {
    const maxLen = Math.min(RTU_MAX_ADU, this.buf.length);
    for (let o = 0; o + 4 <= this.buf.length; o++) {
      const limit = Math.min(maxLen, this.buf.length - o);
      for (let len = 4; len <= limit; len++) {
        if (checkCrc(this.buf.subarray(o, o + len))) return { offset: o, frame: this.buf.slice(o, o + len) };
      }
    }
    return null;
  }

  private evaluate(cand: Uint8Array): FramerEvent[] {
    if (cand.length > RTU_MAX_ADU) {
      const recovered = recoverRtuFrames(cand);
      return [
        { type: 'parse-error', kind: 'malformed', reason: `candidate exceeds RTU ADU limit (${cand.length} > ${RTU_MAX_ADU})`, raw: cand, discarded: cand.length, recovered },
        ...recovered.map((r) => ({ type: 'adu' as const, bytes: r })),
      ];
    }
    if (cand.length < 4) {
      return [{ type: 'parse-error', kind: 'malformed', reason: 'noise: candidate shorter than minimum RTU ADU', raw: cand, discarded: cand.length, recovered: [] }];
    }
    if (!checkCrc(cand)) {
      const recovered = recoverRtuFrames(cand);
      return [
        { type: 'parse-error', kind: 'crc', reason: 'CRC mismatch', raw: cand, discarded: cand.length, recovered },
        ...recovered.map((r) => ({ type: 'adu' as const, bytes: r })),
      ];
    }
    return [{ type: 'adu', bytes: cand }];
  }
}