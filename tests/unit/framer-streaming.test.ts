import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TcpStreamingFramer, RtuStreamingFramer, type FramerEvent } from '../../src/domain/protocol/framer';
import { FakeClock, unhex, hex } from '../support/fake';
import { LIMITS } from '../../src/domain/protocol/types';

const scenarios = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'protocol', 'streaming-scenarios.json'), 'utf-8')) as Record<string, unknown>;

function adus(events: FramerEvent[]): string[] {
  return events.filter((e) => e.type === 'adu').map((e) => (e.type === 'adu' ? hex(e.bytes) : ''));
}
function errors(events: FramerEvent[]): FramerEvent[] {
  return events.filter((e) => e.type === 'parse-error');
}

describe('TCP streaming framer', () => {
  const s = scenarios as Record<string, { frame?: string; frames?: string[]; chunks: string[]; prefix?: string; tail?: string[]; late?: string }>;

  it('single frame split across many inputs', () => {
    const f = new TcpStreamingFramer();
    const sc = s.tcp_single_frame_split!;
    let out: FramerEvent[] = [];
    for (const c of sc.chunks) out = out.concat(f.push(unhex(c)));
    expect(adus(out)).toEqual([sc.frame]);
  });

  it('multiple frames in one input are all emitted', () => {
    const f = new TcpStreamingFramer();
    const sc = s.tcp_multi_frame_one_chunk!;
    const out = f.push(unhex(sc.chunks[0] as string));
    expect(adus(out)).toEqual(sc.frames);
  });

  it('half + sticky mix (A tail, then B+C head, then C tail)', () => {
    const f = new TcpStreamingFramer();
    const sc = s.tcp_half_sticky_mix!;
    let out: FramerEvent[] = [];
    out = out.concat(f.push(unhex(sc.prefix as string)));
    out = out.concat(f.push(unhex(sc.chunks[0] as string)));
    for (const t of sc.tail as string[]) out = out.concat(f.push(unhex(t)));
    expect(adus(out)).toEqual(sc.frames);
  });

  it('garbage prefix triggers controlled resync and keeps the good frame', () => {
    const f = new TcpStreamingFramer();
    const sc = s.tcp_garbage_prefix_then_good!;
    const out = f.push(unhex(sc.chunks[0] as string));
    expect(errors(out).length).toBeGreaterThanOrEqual(1);
    expect(adus(out)).toEqual(sc.frames);
    const err = errors(out)[0] as Extract<FramerEvent, { type: 'parse-error' }>;
    expect(err.discarded).toBeGreaterThan(0);
    expect(err.discarded).toBeLessThan(unhex(sc.chunks[0] as string).length);
  });

  it('illegal protocol id resyncs without clearing the whole buffer', () => {
    const f = new TcpStreamingFramer();
    const sc = s.tcp_bad_protocol_id_then_good!;
    const out = f.push(unhex(sc.chunks[0] as string));
    expect(adus(out)).toEqual(sc.frames);
    expect(errors(out)[0]).toMatchObject({ kind: 'malformed' });
  });

  it('oversize MBAP length is rejected and following frame recovered', () => {
    const f = new TcpStreamingFramer();
    const sc = s.tcp_oversize_length_then_good!;
    const out = f.push(unhex(sc.chunks[0] as string));
    expect(adus(out)).toEqual(sc.frames);
  });

  it('truncated candidate times out bounded and reports discarded bytes', () => {
    const clock = new FakeClock();
    const f = new TcpStreamingFramer({ clock, incompleteTimeoutMs: 200 });
    const partial = unhex((s.tcp_single_frame_split!.frame as string).slice(0, 10));
    let out = f.push(partial, 0);
    expect(adus(out)).toEqual([]);
    clock.advance(500);
    out = f.tick(500);
    expect(errors(out)[0]).toMatchObject({ kind: 'truncated' });
    expect(f.pendingBytes()).toBe(0);
  });

  it('late transaction id arrives before the current response and is not merged', () => {
    const f = new TcpStreamingFramer();
    const sc = s.tcp_late_tid_then_new!;
    let out: FramerEvent[] = [];
    for (const c of sc.chunks) out = out.concat(f.push(unhex(c)));
    // both frames are structurally complete; matching to requests happens in the validator
    expect(adus(out)).toEqual([sc.late, sc.frames?.[0]]);
  });

  it('respects protocol size limits', () => {
    expect(LIMITS.MAX_TCP_ADU).toBe(260);
    expect(LIMITS.MAX_RTU_ADU).toBe(256);
    expect(LIMITS.MAX_PDU).toBe(253);
  });
});

describe('RTU streaming framer', () => {
  const s = scenarios as Record<string, { frame?: string; frames?: string[]; chunks: string[] }>;
  const baud = 9600;

  it('single frame split across reads (length context completes it)', () => {
    const frame = unhex(s.rtu_single_frame_split!.frame as string);
    const f = new RtuStreamingFramer({ baudRate: baud, expectedAduLength: () => frame.length });
    let out: FramerEvent[] = [];
    let t = 0;
    for (const c of s.rtu_single_frame_split!.chunks) {
      t += 1;
      out = out.concat(f.push(unhex(c), t));
    }
    expect(adus(out)).toEqual([hex(frame)]);
  });

  it('silence (>= t3.5) delimits frames when no length context is known', () => {
    const clock = new FakeClock();
    const f = new RtuStreamingFramer({ clock, baudRate: baud });
    const frame = unhex(s.rtu_single_frame_split!.frame as string);
    let out = f.push(frame, 0);
    expect(adus(out)).toEqual([]);
    clock.advance(10);
    out = f.tick(10);
    expect(adus(out)).toEqual([hex(frame)]);
  });

  it('inter-character gap > t1.5 marks the frame incomplete and reports it at the next silence', () => {
    const clock = new FakeClock();
    const f = new RtuStreamingFramer({ clock, baudRate: baud });
    const frame = unhex(s.rtu_single_frame_split!.frame as string);
    f.push(frame.subarray(0, 5), 0);
    // 2 ms gap at 9600 baud: t1.5 = 1.72 ms, t3.5 = 4.01 ms -> inside-frame gap
    let out = f.push(frame.subarray(5), 2.5);
    clock.advance(20);
    out = out.concat(f.tick(22.5));
    const err = errors(out);
    expect(err.length).toBe(1);
    expect(err[0]).toMatchObject({ kind: 'gap' });
  });

  it('continuous multi-frame input with silence boundaries', () => {
    const clock = new FakeClock();
    const f = new RtuStreamingFramer({ clock, baudRate: baud });
    const sc = s.rtu_multi_frame_one_chunk!;
    const both = unhex(sc.chunks[0] as string);
    const first = unhex(sc.frames![0] as string);
    let out = f.push(first, 0);
    out = out.concat(f.push(both.subarray(first.length), 10));
    clock.advance(30);
    out = out.concat(f.tick(30));
    expect(adus(out)).toEqual(sc.frames);
  });

  it('CRC-bad frame glued to a good frame: bad reported, good recovered', () => {
    const clock = new FakeClock();
    const f = new RtuStreamingFramer({ clock, baudRate: baud });
    const sc = s.rtu_bad_crc_glued_then_good!;
    let out = f.push(unhex(sc.chunks[0] as string), 0);
    clock.advance(20);
    out = out.concat(f.tick(20));
    const err = errors(out);
    expect(err.length).toBe(1);
    expect(err[0]).toMatchObject({ kind: 'crc' });
    expect(adus(out)).toEqual(sc.frames);
    const e0 = err[0] as Extract<FramerEvent, { type: 'parse-error' }>;
    expect(e0.recovered.length).toBe(1);
  });

  it('noise segment separated by silence is dropped without losing the next frame', () => {
    const clock = new FakeClock();
    const f = new RtuStreamingFramer({ clock, baudRate: baud });
    const sc = s.rtu_noise_then_good!;
    let out = f.push(unhex(sc.chunks[0] as string), 0);
    clock.advance(10);
    out = out.concat(f.tick(10));
    expect(errors(out).length).toBe(1);
    out = out.concat(f.push(unhex(sc.chunks[1] as string), 20));
    clock.advance(30);
    out = out.concat(f.tick(30));
    expect(adus(out)).toEqual(sc.frames);
  });

  it('truncated frame then good frame: truncation reported, good frame parsed', () => {
    const clock = new FakeClock();
    const f = new RtuStreamingFramer({ clock, baudRate: baud });
    const sc = s.rtu_truncated_then_good!;
    let out = f.push(unhex(sc.chunks[0] as string), 0);
    clock.advance(10);
    out = out.concat(f.tick(10));
    expect(errors(out).length).toBe(1);
    out = out.concat(f.push(unhex(sc.chunks[1] as string), 20));
    clock.advance(30);
    out = out.concat(f.tick(30));
    expect(adus(out)).toEqual(sc.frames);
  });

  it('buffer is bounded: continuous garbage cannot grow memory forever', () => {
    const clock = new FakeClock();
    const f = new RtuStreamingFramer({ clock, baudRate: baud, maxBuffer: 512 });
    const garbage = new Uint8Array(300).fill(0x5a);
    f.push(garbage, 0);
    f.push(garbage, 1);
    clock.advance(10);
    const out = f.tick(10);
    expect(errors(out).length).toBeGreaterThanOrEqual(1);
    expect(f.pendingBytes()).toBeLessThanOrEqual(512);
  });
});