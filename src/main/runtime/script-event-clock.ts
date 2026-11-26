import { MAX_SCRIPT_MS, MIN_EVENT_PERIOD } from '../../domain/master-script';
import type { ScriptEventSource, ScriptEventStatus } from '../../shared/script-run';
import type { RuntimeChange } from './runtime-notifications';

interface Deadline { periodMs: number; next: number; pending: boolean }
interface Timer extends Deadline { remaining: number | null; started: number }
interface ElapsedWatch { next: number; channels: Set<number>; nextAfter(time: number): number; notify(): void }

export function checkedPeriod(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_EVENT_PERIOD || value > MAX_SCRIPT_MS)
    throw new Error(`周期须为 ${MIN_EVENT_PERIOD}–${MAX_SCRIPT_MS} ms 的整数`);
  return value;
}

// One monotonic clock per script. The host cycle has its own deadline and never occupies a timer channel.
export class ScriptEventClock {
  private cycle: (Deadline & { enabled: boolean; calls: number }) | null;
  private timers = new Map<number, Timer>();
  private frozenAt: number | null = null;
  private excludedMs = 0;
  private readonly watches = new Set<ElapsedWatch>();
  private observedAt?: number;

  constructor(periodMs?: number, private readonly monotonic = () => performance.now()) {
    this.cycle = periodMs === undefined ? null : { ...this.deadline(periodMs), enabled: true, calls: 0 };
  }
  private now() { return Math.floor((this.frozenAt ?? this.monotonic()) - this.excludedMs); }
  private deadline(periodMs: number): Deadline { return { periodMs, next: this.now() + periodMs, pending: false }; }
  freeze() { this.frozenAt ??= this.monotonic(); }
  resume() {
    if (this.frozenAt !== null) this.excludedMs += this.monotonic() - this.frozenAt;
    this.frozenAt = null;
  }
  setPeriod(ms: number) {
    const period = checkedPeriod(ms);
    if (this.cycle) Object.assign(this.cycle, this.deadline(period));
  }
  enableCycle(enabled: boolean) {
    if (this.cycle) Object.assign(this.cycle, this.deadline(this.cycle.periodMs), { enabled });
  }
  startTimer(channel: number, periodMs: number, count: number) {
    const deadline = this.deadline(checkedPeriod(periodMs));
    this.timers.set(channel, { ...deadline, started: deadline.next - periodMs, remaining: count || null });
    this.resetWatches(channel);
  }
  stopTimer(channel: number) { this.timers.delete(channel); this.resetWatches(channel); }
  close() { this.timers.clear(); this.watches.clear(); if (this.cycle) this.cycle.enabled = false; }
  isRunning(channel: number) { return this.timers.has(channel); }
  enterCycle() { if (this.cycle) this.cycle.calls++; }
  elapsed(channel: number) {
    const timer = this.timers.get(channel);
    return timer ? Math.max(0, (this.observedAt ?? this.now()) - timer.started) % timer.periodMs : 0;
  }
  private resetWatches(channel: number) {
    const now = this.now();
    for (const watch of this.watches) if (watch.channels.has(channel)) watch.next = watch.nextAfter(now);
  }
  watchElapsed(sources: RuntimeChange[], notify: () => void) {
    const timers = sources.filter((s): s is Extract<RuntimeChange, { kind: 'timer' }> => s.kind === 'timer' && !!s.elapsed);
    if (!timers.length) return;
    const nextAfter = (time: number) => {
      let earliest = Infinity;
      for (const source of timers) {
        const timer = this.timers.get(source.channel);
        if (!timer) continue;
        if (!source.phases) { earliest = Math.min(earliest, time + 1); continue; }
        const base = time - (time - timer.started) % timer.periodMs;
        for (const phase of source.phases) {
          if (phase < 0 || phase >= timer.periodMs) continue;
          const edge = base + phase;
          earliest = Math.min(earliest, edge > time ? edge : edge + timer.periodMs);
        }
      }
      return earliest;
    };
    const watch = { next: nextAfter(this.now()), channels: new Set(timers.map(t => t.channel)), nextAfter, notify };
    this.watches.add(watch);
    return { reset: () => { watch.next = nextAfter(this.now()); }, close: () => { this.watches.delete(watch); } };
  }
  nextDelay(): number {
    let next = this.cycle?.enabled ? this.cycle.next : Infinity;
    for (const timer of this.timers.values()) next = Math.min(next, timer.next);
    for (const watch of this.watches) next = Math.min(next, watch.next);
    return Math.max(0, Math.ceil(next - this.now()));
  }
  takeDue(busy: ReadonlyMap<ScriptEventSource, unknown>): ScriptEventSource[] {
    const now = this.now();
    const due: ScriptEventSource[] = [];
    // Observe logical transitions before rolling a channel over. A late OS wake
    // must still see an 8 ms threshold on a 10 ms timer. Yield between batches.
    let horizon = now;
    if (this.watches.size) for (const [ch, timer] of this.timers) {
      if (timer.remaining === 1 && !busy.has(`T${ch}`)) horizon = Math.min(horizon, timer.next);
    }
    for (const watch of this.watches) {
      for (let i = 0; i < 64 && this.watches.has(watch) && watch.next <= horizon; i++) {
        const edge = watch.next;
        watch.next = watch.nextAfter(edge);
        this.observedAt = edge;
        try { watch.notify(); } finally { this.observedAt = undefined; }
      }
      if (this.watches.has(watch) && watch.next <= horizon) return due;
    }
    const take = (source: ScriptEventSource, slot: Deadline) => {
      if (slot.next <= now) {
        slot.next += (1 + Math.floor((now - slot.next) / slot.periodMs)) * slot.periodMs;
        slot.pending = true;
      }
      if (busy.has(source) || !slot.pending) return false;
      slot.pending = false;
      due.push(source);
      return true;
    };
    if (this.cycle?.enabled) take('on_run', this.cycle);
    for (const [channel, timer] of this.timers) {
      if (take(`T${channel}`, timer) && timer.remaining !== null && --timer.remaining === 0) this.stopTimer(channel);
    }
    return due;
  }
  snapshot(): ScriptEventStatus {
    return {
      onRun: this.cycle && { periodMs: this.cycle.periodMs, enabled: this.cycle.enabled, calls: this.cycle.calls },
      timers: Array.from(this.timers, ([channel, { periodMs, remaining }]) => ({ channel, periodMs, remaining })),
    };
  }
}
