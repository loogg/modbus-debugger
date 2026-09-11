const fs = require('fs');
const p = 'tests/unit/framer-streaming.test.ts';
let c = fs.readFileSync(p, 'utf8');
const oldStart = c.indexOf("  it('half + sticky mix frames by expected length'");
const oldEnd = c.indexOf("  it('CRC-bad frame glued to a good frame");
const neu = `  it('half + sticky mix frames by expected length (A tail + B whole + C head)', () => {
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

`;
c = c.slice(0, oldStart) + neu + c.slice(oldEnd);
c = c.replace("import { TcpStreamingFramer, RtuStreamingFramer, type FramerEvent } from '../../src/domain/protocol/framer';", "import { TcpStreamingFramer, RtuStreamingFramer, type FramerEvent } from '../../src/domain/protocol/framer';\nimport { buildRtuAdu } from '../../src/domain/protocol/rtu';\nimport { encodeResponsePdu } from '../../src/domain/protocol/pdu';");
fs.writeFileSync(p, c);
console.log('ok');