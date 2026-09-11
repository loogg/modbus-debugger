const fs = require('fs');
const p = 'tests/unit/framer-streaming.test.ts';
let c = fs.readFileSync(p, 'utf8');
const pairs = [
[`  it('silence (>= t3.5) delimits frames when no length context is known', () => {
    const clock = new FakeClock();
    const f = new RtuStreamingFramer({ clock, baudRate: baud });
    const frame = unhex(s.rtu_single_frame_split!.frame as string);
    let out = f.push(frame, 0);
    expect(adus(out)).toEqual([]);
    clock.advance(10);
    out = f.tick(10);
    expect(adus(out)).toEqual([hex(frame)]);
  });`,
`  it('without length context, trusted CRC scan extracts complete frames (no timing involved)', () => {
    const f = new RtuStreamingFramer({});
    const frame = unhex(s.rtu_single_frame_split!.frame as string);
    const out = f.push(frame, 0);
    expect(adus(out)).toEqual([hex(frame)]);
  });`],
[`  it('intra-frame gap > t1.5 is a hint only: CRC-valid frame still accepted', () => {
    const clock = new FakeClock();
    const f = new RtuStreamingFramer({ clock, baudRate: baud });
    const frame = unhex(s.rtu_single_frame_split!.frame as string);
    f.push(frame.subarray(0, 5), 0);
    // 2 ms gap at 9600 baud: t1.5 = 1.72 ms, t3.5 = 4.01 ms -> inside-frame gap
    let out = f.push(frame.subarray(5), 2.5);
    clock.advance(20);
    out = out.concat(f.tick(22.5));
    expect(errors(out).length).toBe(0);
    expect(adus(out)).toEqual([hex(frame)]);
  });`,
`  it('arbitrary inter-chunk gaps are irrelevant: expected length frames the response', () => {
    const frame = unhex(s.rtu_single_frame_split!.frame as string);
    const f = new RtuStreamingFramer({ expectedAduLength: () => frame.length });
    let out = f.push(frame.subarray(0, 5), 0);
    // huge artificial gap between chunks: framing must not care
    out = out.concat(f.push(frame.subarray(5), 5000));
    expect(errors(out).length).toBe(0);
    expect(adus(out)).toEqual([hex(frame)]);
  });`],
[`  it('continuous multi-frame input with silence boundaries', () => {
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
  });`,
`  it('continuous multi-frame input is segmented by CRC scan without timing', () => {
    const f = new RtuStreamingFramer({});
    const sc = s.rtu_multi_frame_one_chunk!;
    const out = f.push(unhex(sc.chunks[0] as string), 0);
    expect(adus(out)).toEqual(sc.frames);
  });`],
[`    expect(err[0]).toMatchObject({ kind: 'crc' });`, `    expect(err[0]).toMatchObject({ kind: 'malformed' });`],
[`  it('noise segment separated by silence is dropped without losing the next frame', () => {
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
  });`,
`  it('noise prefix is discarded by resync without losing the following frame', () => {
    const f = new RtuStreamingFramer({});
    const sc = s.rtu_noise_then_good!;
    let out = f.push(unhex(sc.chunks[0] as string), 0);
    expect(errors(out).length).toBe(0);
    out = out.concat(f.push(unhex(sc.chunks[1] as string), 20));
    const err = errors(out);
    expect(err.length).toBe(1);
    expect(err[0]).toMatchObject({ kind: 'malformed' });
    expect(adus(out)).toEqual(sc.frames);
  });`],
[`  it('truncated frame then good frame: truncation reported, good frame parsed', () => {
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
  });`,
`  it('truncated frame then good frame: resync reports discard and parses the good frame', () => {
    const clock = new FakeClock();
    const f = new RtuStreamingFramer({ clock });
    const sc = s.rtu_truncated_then_good!;
    let out = f.push(unhex(sc.chunks[0] as string), 0);
    expect(errors(out).length).toBe(0);
    out = out.concat(f.push(unhex(sc.chunks[1] as string), 20));
    const err = errors(out);
    expect(err.length).toBe(1);
    expect(err[0]).toMatchObject({ kind: 'malformed' });
    expect(adus(out)).toEqual(sc.frames);
    // a lone truncated candidate is bounded by the wait budget
    const f2 = new RtuStreamingFramer({ clock, incompleteTimeoutMs: 200 });
    let out2 = f2.push(unhex(sc.chunks[0] as string), 100);
    clock.advance(500);
    out2 = out2.concat(f2.tick(600));
    expect(errors(out2)[0]).toMatchObject({ kind: 'truncated' });
  });`],
];
for (const [o, n] of pairs) {
  if (!c.includes(o)) { console.log('MISS:', o.slice(0, 60).replace(/\n/g, '\\n')); continue; }
  c = c.split(o).join(n);
}
fs.writeFileSync(p, c);
console.log('done');