export type RawType =
  | 'Bool'
  | 'BitField'
  | 'Int8'
  | 'UInt8'
  | 'Int16'
  | 'UInt16'
  | 'Int32'
  | 'UInt32'
  | 'Float32'
  | 'Float64'
  | 'String';

/** Multi-register byte/word order. ABCD = big-endian word order as transmitted. */
export type WordOrder = 'ABCD' | 'CDAB' | 'BADC' | 'DCBA';
export type ByteSelector = 'high' | 'low';
export type StringEncoding = 'ascii' | 'utf8';

export type RawMemory =
  | { kind: 'registers'; registers: Uint16Array }
  | { kind: 'bits'; bits: boolean[] };

export interface PointMapping {
  rawType: RawType;
  /** offset in registers (register areas) or bits (bit areas) from block start */
  offset: number;
  /** number of registers occupied (derived for numeric types, explicit for String) */
  registerCount: number;
  wordOrder: WordOrder;
  byteSelector: ByteSelector;
  bitOffset: number;
  bitWidth: number;
  stringLength: number;
  stringEncoding: StringEncoding;
}

export function registersForType(rawType: RawType, stringLength = 0): number {
  switch (rawType) {
    case 'Bool':
    case 'BitField':
    case 'Int8':
    case 'UInt8':
    case 'Int16':
    case 'UInt16':
      return 1;
    case 'Int32':
    case 'UInt32':
    case 'Float32':
      return 2;
    case 'Float64':
      return 4;
    case 'String':
      return Math.max(1, Math.ceil(stringLength / 2));
  }
}

export type DecodedRaw = number | boolean | string;

function orderWords(regs: number[], order: WordOrder): number[] {
  if (regs.length === 2) {
    const [a, b] = regs as [number, number];
    switch (order) {
      case 'ABCD':
        return [a, b];
      case 'CDAB':
        return [b, a];
      case 'BADC':
        return [swapBytes(a), swapBytes(b)];
      case 'DCBA':
        return [swapBytes(b), swapBytes(a)];
    }
  }
  if (regs.length === 4) {
    const w = [...regs] as number[];
    switch (order) {
      case 'ABCD':
        return w;
      case 'CDAB':
        return [w[2] as number, w[3] as number, w[0] as number, w[1] as number];
      case 'BADC':
        return w.map(swapBytes);
      case 'DCBA':
        return [w[3] as number, w[2] as number, w[1] as number, w[0] as number].map(swapBytes);
    }
  }
  return regs;
}

function swapBytes(v: number): number {
  return ((v & 0xff) << 8) | ((v >> 8) & 0xff);
}

function bytesOf(regs: number[]): Uint8Array {
  const out = new Uint8Array(regs.length * 2);
  regs.forEach((r, i) => {
    out[i * 2] = (r >> 8) & 0xff;
    out[i * 2 + 1] = r & 0xff;
  });
  return out;
}

export function decodeRaw(memory: RawMemory, m: PointMapping): DecodedRaw {
  if (memory.kind === 'bits') {
    if (m.rawType !== 'Bool') throw new Error('Bool mapping requires bit memory');
    return memory.bits[m.offset] ?? false;
  }
  const regs = memory.registers;
  switch (m.rawType) {
    case 'Bool': {
      const reg = regs[m.offset] ?? 0;
      return ((reg >> m.bitOffset) & 1) === 1;
    }
    case 'BitField': {
      const reg = regs[m.offset] ?? 0;
      const mask = m.bitWidth >= 16 ? 0xffff : (1 << m.bitWidth) - 1;
      return (reg >> m.bitOffset) & mask;
    }
    case 'UInt8': {
      const reg = regs[m.offset] ?? 0;
      return m.byteSelector === 'high' ? (reg >> 8) & 0xff : reg & 0xff;
    }
    case 'Int8': {
      const v = m.byteSelector === 'high' ? ((regs[m.offset] ?? 0) >> 8) & 0xff : (regs[m.offset] ?? 0) & 0xff;
      return v & 0x80 ? v - 256 : v;
    }
    case 'UInt16':
      return regs[m.offset] ?? 0;
    case 'Int16': {
      const v = regs[m.offset] ?? 0;
      return v & 0x8000 ? v - 65536 : v;
    }
    case 'Int32':
    case 'UInt32': {
      const ordered = orderWords([regs[m.offset] ?? 0, regs[m.offset + 1] ?? 0], m.wordOrder);
      const hi = ordered[0] as number;
      const lo = ordered[1] as number;
      const u = hi * 65536 + lo;
      if (m.rawType === 'UInt32') return u;
      return u >= 2 ** 31 ? u - 2 ** 32 : u;
    }
    case 'Float32': {
      const ordered = orderWords([regs[m.offset] ?? 0, regs[m.offset + 1] ?? 0], m.wordOrder);
      const b = bytesOf(ordered);
      const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
      return view.getFloat32(0, false);
    }
    case 'Float64': {
      const ordered = orderWords(
        [regs[m.offset] ?? 0, regs[m.offset + 1] ?? 0, regs[m.offset + 2] ?? 0, regs[m.offset + 3] ?? 0],
        m.wordOrder,
      );
      const b = bytesOf(ordered);
      const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
      return view.getFloat64(0, false);
    }
    case 'String': {
      const count = Math.max(1, Math.ceil(m.stringLength / 2));
      const slice: number[] = [];
      for (let i = 0; i < count; i++) slice.push(regs[m.offset + i] ?? 0);
      const bytes = bytesOf(slice).subarray(0, m.stringLength);
      let s = '';
      if (m.stringEncoding === 'ascii') {
        for (const byte of bytes) s += byte === 0 ? '' : String.fromCharCode(byte);
      } else {
        s = new TextDecoder('utf-8').decode(bytes).replace(/\0/g, '');
      }
      return s;
    }
  }
}

/** Encode a raw value back into registers (used for RMW merge and write composition). */
export function encodeRaw(current: RawMemory, m: PointMapping, value: DecodedRaw): RawMemory {
  if (current.kind === 'bits') {
    const bits = current.bits.slice();
    bits[m.offset] = value === true;
    return { kind: 'bits', bits };
  }
  const regs = current.registers.slice();
  switch (m.rawType) {
    case 'Bool': {
      const reg = regs[m.offset] ?? 0;
      const bit = 1 << m.bitOffset;
      regs[m.offset] = value === true ? reg | bit : reg & ~bit & 0xffff;
      break;
    }
    case 'BitField': {
      const mask = m.bitWidth >= 16 ? 0xffff : (1 << m.bitWidth) - 1;
      const reg = regs[m.offset] ?? 0;
      const cleared = reg & ~(mask << m.bitOffset) & 0xffff;
      regs[m.offset] = cleared | (((value as number) & mask) << m.bitOffset);
      break;
    }
    case 'UInt8':
    case 'Int8': {
      const byte = (value as number) & 0xff;
      const reg = regs[m.offset] ?? 0;
      regs[m.offset] = m.byteSelector === 'high' ? (reg & 0x00ff) | (byte << 8) : (reg & 0xff00) | byte;
      break;
    }
    case 'UInt16':
      regs[m.offset] = (value as number) & 0xffff;
      break;
    case 'Int16':
      regs[m.offset] = (value as number) & 0xffff;
      break;
    case 'Int32':
    case 'UInt32': {
      const u = (value as number) >>> 0;
      const words = [Math.floor(u / 65536) & 0xffff, u & 0xffff];
      writeOrdered(regs, m.offset, words, m.wordOrder);
      break;
    }
    case 'Float32': {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setFloat32(0, value as number, false);
      const words = [((b[0] as number) << 8) | (b[1] as number), ((b[2] as number) << 8) | (b[3] as number)];
      writeOrdered(regs, m.offset, words, m.wordOrder);
      break;
    }
    case 'Float64': {
      const b = new Uint8Array(8);
      new DataView(b.buffer).setFloat64(0, value as number, false);
      const words: number[] = [];
      for (let i = 0; i < 8; i += 2) words.push(((b[i] as number) << 8) | (b[i + 1] as number));
      writeOrdered(regs, m.offset, words, m.wordOrder);
      break;
    }
    case 'String': {
      const count = Math.max(1, Math.ceil(m.stringLength / 2));
      const bytes = new Uint8Array(count * 2);
      const str = String(value);
      if (m.stringEncoding === 'ascii') {
        for (let i = 0; i < str.length && i < m.stringLength; i++) bytes[i] = str.charCodeAt(i) & 0xff;
      } else {
        const enc = new TextEncoder().encode(str).subarray(0, m.stringLength);
        bytes.set(enc, 0);
      }
      const words: number[] = [];
      for (let i = 0; i < count * 2; i += 2) words.push(((bytes[i] as number) << 8) | (bytes[i + 1] as number));
      for (let i = 0; i < count; i++) regs[m.offset + i] = words[i] as number;
      break;
    }
  }
  return { kind: 'registers', registers: regs };
}

function writeOrdered(regs: Uint16Array, offset: number, wordsBig: number[], order: WordOrder): void {
  // inverse of orderWords
  let placed: number[];
  if (wordsBig.length === 2) {
    const [a, b] = wordsBig as [number, number];
    switch (order) {
      case 'ABCD':
        placed = [a, b];
        break;
      case 'CDAB':
        placed = [b, a];
        break;
      case 'BADC':
        placed = [swapBytes(a), swapBytes(b)];
        break;
      default:
        placed = [swapBytes(b), swapBytes(a)];
    }
  } else {
    const [a, b, c, d] = wordsBig as [number, number, number, number];
    switch (order) {
      case 'ABCD':
        placed = [a, b, c, d];
        break;
      case 'CDAB':
        placed = [c, d, a, b];
        break;
      case 'BADC':
        placed = [swapBytes(a), swapBytes(b), swapBytes(c), swapBytes(d)];
        break;
      default:
        placed = [swapBytes(d), swapBytes(c), swapBytes(b), swapBytes(a)];
    }
  }
  placed.forEach((w, i) => {
    regs[offset + i] = w;
  });
}