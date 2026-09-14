import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TcpStreamingFramer, RtuStreamingFramer, type FramerEvent } from '../../src/domain/protocol/framer';
import { buildRtuAdu } from '../../src/domain/protocol/rtu';
import { encodeResponsePdu } from '../../src/domain/protocol/pdu';
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

  it('single frame split across reads (length context completes it)', () => {
    const frame = unhex(s.rtu_single_frame_split!.frame as string);
    const f = new RtuStreamingFramer({ expectedAduLength: () => frame.length });
    let out: FramerEvent[] = [];
    let t = 0;
    for (const c of s.rtu_single_frame_split!.chunks) {
      t += 1;
      out = out.concat(f.push(unhex(c), t));
    }
    expect(adus(out)).toEqual([hex(frame)]);
  });

  it('without length context, trusted CRC scan extracts complete frames (no timing involved)', () => {
    const f = new RtuStreamingFramer({});
    const frame = unhex(s.rtu_single_frame_split!.frame as string);
    const out = f.push(frame, 0);
    expect(adus(out)).toEqual([hex(frame)]);
  });

  it('arbitrary inter-chunk gaps are irrelevant: expected length frames the response', () => {
    const frame = unhex(s.rtu_single_frame_split!.frame as string);
    const f = new RtuStreamingFramer({ expectedAduLength: () => frame.length });
    let out = f.push(frame.subarray(0, 5), 0);
    out = out.concat(f.push(frame.subarray(5), 5000));
    expect(errors(out).length).toBe(0);
    expect(adus(out)).toEqual([hex(frame)]);
  });

  it('continuous multi-frame input is segmented by CRC scan without timing', () => {
    const f = new RtuStreamingFramer({});
    const sc = s.rtu_multi_frame_one_chunk!;
    const out = f.push(unhex(sc.chunks[0] as string), 0);
    expect(adus(out)).toEqual(sc.frames);
  });

  it('half + sticky mix frames by expected length (A tail + B whole + C head)', () => {
    const a = buildRtuAdu(1, encodeResponsePdu({ kind: 'registers', fc: 0x03, registers: [1, 2, 3, 4] }));
    const b = buildRtuAdu(1, encodeResponsePdu({ kind: 'registers', fc: 0x03, registers: [5, 6, 7, 8] }));
    const f = new RtuStreamingFramer({ expectedAduLength: () => a.length });
    let out: FramerEvent[] = [];
    out = out.concat(f.push(a.subarray(0, 3), 0));
    out = out.concat(f.push(concatAll([a.subarray(3), b.subarray(0, 6)]), 1));
    out = out.concat(f.push(b.subarray(6), 2));
    expect(errors(out).length).toBe(0);
    expect(adus(out)).toEqual([hex(a), hex(b)]);
  });

  it('CRC-bad frame glued to a good frame: bad reported, good recovered', () => {
    const f = new RtuStreamingFramer({});
    const sc = s.rtu_bad_crc_glued_then_good!;
    const out = f.push(unhex(sc.chunks[0] as string), 0);
    const err = errors(out);
    expect(err.length).toBe(1);
    expect(err[0]).toMatchObject({ kind: 'malformed' });
    expect(adus(out)).toEqual(sc.frames);
    const e0 = err[0] as Extract<FramerEvent, { type: 'parse-error' }>;
    expect(e0.recovered.length).toBe(1);
    expect(e0.discarded).toBeGreaterThan(0);
  });

  it('noise prefix is discarded by resync without losing the following frame', () => {
    const f = new RtuStreamingFramer({});
    const sc = s.rtu_noise_then_good!;
    let out = f.push(unhex(sc.chunks[0] as string), 0);
    expect(errors(out).length).toBe(0);
    out = out.concat(f.push(unhex(sc.chunks[1] as string), 20));
    const err = errors(out);
    expect(err.length).toBe(1);
    expect(err[0]).toMatchObject({ kind: 'malformed' });
    expect(adus(out)).toEqual(sc.frames);
  });

  it('truncated frame then good frame: resync reports discard and parses the good frame', () => {
    const clock = new FakeClock();
    const sc = s.rtu_truncated_then_good!;
    const f = new RtuStreamingFramer({ clock });
    let out = f.push(unhex(sc.chunks[0] as string), 0);
    expect(errors(out).length).toBe(0);
    out = out.concat(f.push(unhex(sc.chunks[1] as string), 20));
    const err = errors(out);
    expect(err.length).toBe(1);
    expect(err[0]).toMatchObject({ kind: 'malformed' });
    expect(adus(out)).toEqual(sc.frames);
    const f2 = new RtuStreamingFramer({ clock, incompleteTimeoutMs: 200 });
    let out2 = f2.push(unhex(sc.chunks[0] as string), 100);
    out2 = out2.concat(f2.tick(600));
    expect(errors(out2)[0]).toMatchObject({ kind: 'truncated' });
  });

  it('buffer is bounded: continuous garbage cannot grow memory forever', () => {
    const clock = new FakeClock();
    const f = new RtuStreamingFramer({ clock, maxBuffer: 512 });
    const garbage = new Uint8Array(300).fill(0x5a);
    let out = f.push(garbage, 0);
    out = out.concat(f.push(garbage, 1));
    out = out.concat(f.tick(10));
    expect(errors(out).length).toBeGreaterThanOrEqual(1);
    expect(f.pendingBytes()).toBeLessThanOrEqual(512);
  });
});

describe('RTU exception while waiting for a normal read length', () => {
  it('emits a fragmented exception immediately and preserves a following frame', () => {
    const f = new RtuStreamingFramer({ expectedAduLength: () => 25 });
    // Independent standard exception vector: unit 1, FC03 exception 02, CRC C0F1.
    const exception = unhex('018302c0f1');
    expect(adus(f.push(exception.slice(0, 3)))).toEqual([]);
    expect(adus(f.push(exception.slice(3)))).toEqual(['018302c0f1']);
    expect(f.pendingBytes()).toBe(0);
  });
});

function concatAll(list: Uint8Array[]): Uint8Array {
  const total = list.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of list) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}


it('preserves every possible partial TCP prefix after malformed bytes', () => {
  const good = unhex('000100000005010302007b');
  for (let split = 1; split < good.length; split++) {
    const framer = new TcpStreamingFramer();
    const first = framer.push(concatAll([unhex('ffffffffffffffffffff'), good.subarray(0, split)]));
    const rest = framer.push(good.subarray(split));
    expect(adus([...first, ...rest]), `split ${split}`).toEqual([hex(good)]);
  }
});
