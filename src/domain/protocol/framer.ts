import { checkCrc } from './crc';
import { rtuTimings, RTU_MAX_ADU } from './rtu';
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

export type ParseErrorKind = 'crc' | 'malformed' | 'truncated' | 'overflow' | 'gap';

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
  /** true when the line has been silent long enough to trust a frame boundary */
  silenceReached(atMs?: number): boolean;
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
  silenceReached(atMs?: number): boolean {
    if (this.lastByte === null) return true;
    return (atMs ?? this.clock.now()) - this.lastByte >= 5;
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
  private gapBroken = false;
  private readonly clock: Clock;
  private readonly t15: number;
  private readonly t35: number;
  private readonly maxBuffer: number;
  private readonly incompleteTimeoutMs: number;
  private readonly hooks: FramerHooks;

  constructor(opts: RtuFramerOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    const t = rtuTimings(opts.baudRate ?? 9600);
    this.t15 = t.t15;
    this.t35 = t.t35;
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
    this.gapBroken = false;
  }

  /** True when the line has been silent for at least t3.5 (trusted frame boundary). */
  silenceReached(atMs?: number): boolean {
    if (this.lastByte === null) return true;
    const at = atMs ?? this.clock.now();
    return at - this.lastByte >= this.t35;
  }

  push(chunk: Uint8Array, atMs?: number): FramerEvent[] {
    const at = atMs ?? this.clock.now();
    const events: FramerEvent[] = [];
    if (this.buf.length > 0 && this.lastByte !== null) {
      const gap = at - this.lastByte;
      if (gap >= this.t35) {
        events.push(...this.finalize(at));
      } else if (gap > this.t15) {
        // Inter-character gap above t1.5: current candidate is protocol-incomplete.
        this.gapBroken = true;
      }
    }
    if (this.buf.length === 0) {
      this.candidateStart = at;
      this.gapBroken = false;
    }
    this.buf = concat(this.buf, chunk);
    this.lastByte = at;
    events.push(...this.tryLengthCompletion(at));
    return events;
  }

  tick(atMs?: number): FramerEvent[] {
    const at = atMs ?? this.clock.now();
    const events: FramerEvent[] = [];
    if (this.buf.length === 0) return events;
    if (this.lastByte !== null && at - this.lastByte >= this.t35) {
      events.push(...this.finalize(at));
      return events;
    }
    if (at - this.candidateStart > this.incompleteTimeoutMs) {
      events.push(...this.finalize(at, true));
    }
    return events;
  }

  private tryLengthCompletion(at: number): FramerEvent[] {
    const expected = this.hooks.expectedAduLength?.() ?? null;
    if (expected === null || this.gapBroken) return [];
    if (this.buf.length < expected) return [];
    const events: FramerEvent[] = [];
    const head = this.buf.slice(0, expected);
    const rest = this.buf.slice(expected);
    this.buf = rest;
    if (rest.length) this.candidateStart = at;
    events.push(...this.evaluate(head, at));
    return events;
  }

  private finalize(at: number, forced = false): FramerEvent[] {
    const cand = this.buf;
    const broken = this.gapBroken;
    this.buf = new Uint8Array(0);
    this.gapBroken = false;
    if (cand.length === 0) return [];
    if (forced && !checkCrc(cand)) {
      const recovered = recoverRtuFrames(cand);
      const events: FramerEvent[] = [
        {
          type: 'parse-error',
          kind: 'truncated',
          reason: 'candidate frame never completed within wait budget',
          raw: cand,
          discarded: cand.length,
          recovered,
        },
      ];
      for (const r of recovered) events.push({ type: 'adu', bytes: r });
      return events;
    }
    if (broken) {
      const recovered = recoverRtuFrames(cand);
      const events: FramerEvent[] = [
        {
          type: 'parse-error',
          kind: 'gap',
          reason: 'inter-character gap above t1.5 inside frame (incomplete frame)',
          raw: cand,
          discarded: cand.length,
          recovered,
        },
      ];
      for (const r of recovered) events.push({ type: 'adu', bytes: r });
      return events;
    }
    return this.evaluate(cand, at);
  }

  private evaluate(cand: Uint8Array, at: number): FramerEvent[] {
    void at;
    if (cand.length > this.maxBuffer) {
      const recovered = recoverRtuFrames(cand);
      return [
        {
          type: 'parse-error',
          kind: 'overflow',
          reason: `candidate exceeds receive buffer (${cand.length} bytes)`,
          raw: cand,
          discarded: cand.length,
          recovered,
        },
        ...recovered.map((r) => ({ type: 'adu' as const, bytes: r })),
      ];
    }
    if (cand.length > RTU_MAX_ADU) {
      const recovered = recoverRtuFrames(cand);
      return [
        {
          type: 'parse-error',
          kind: 'malformed',
          reason: `candidate exceeds RTU ADU limit (${cand.length} > ${RTU_MAX_ADU})`,
          raw: cand,
          discarded: cand.length,
          recovered,
        },
        ...recovered.map((r) => ({ type: 'adu' as const, bytes: r })),
      ];
    }
    if (cand.length < 4) {
      return [
        {
          type: 'parse-error',
          kind: 'malformed',
          reason: 'noise: candidate shorter than minimum RTU ADU',
          raw: cand,
          discarded: cand.length,
          recovered: [],
        },
      ];
    }
    if (!checkCrc(cand)) {
      // Bad frame: report it, but recover any legal frame glued inside the same segment.
      const recovered = recoverRtuFrames(cand);
      return [
        {
          type: 'parse-error',
          kind: 'crc',
          reason: 'CRC mismatch',
          raw: cand,
          discarded: cand.length,
          recovered,
        },
        ...recovered.map((r) => ({ type: 'adu' as const, bytes: r })),
      ];
    }
    return [{ type: 'adu', bytes: cand }];
  }
}