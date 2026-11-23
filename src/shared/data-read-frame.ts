import type { ColumnDataReadResult } from './point-data';

const MAGIC = 0x3143444d; // MDC1, little-endian column frame.
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const align = (length: number) => Math.ceil(length / 8) * 8;
interface ArrayDescriptor { type: 'f64' | 'u8'; length: number; offset: number }

/** One correlated WebSocket response, with small JSON control data and aligned binary columns. */
export function encodeDataReadFrame(id: string, result: ColumnDataReadResult): ArrayBuffer {
  const arrays: Array<Float64Array | Uint8Array> = [];
  const descriptors: ArrayDescriptor[] = [];
  let payloadBytes = 0;
  const header = encoder.encode(JSON.stringify({ id, value: result, arrays: descriptors }, (_key, item: unknown) => {
    if (!(item instanceof Float64Array) && !(item instanceof Uint8Array)) return item;
    const index = arrays.length;
    arrays.push(item);
    descriptors.push({ type: item instanceof Float64Array ? 'f64' : 'u8', length: item.length, offset: payloadBytes });
    payloadBytes += align(item.byteLength);
    return { $column: index };
  }));
  const payloadOffset = align(8 + header.byteLength);
  const size = payloadOffset + payloadBytes;
  if (size > MAX_FRAME_BYTES) throw new Error('采样响应超过二进制帧上限');
  const frame = new ArrayBuffer(size);
  const bytes = new Uint8Array(frame);
  const view = new DataView(frame);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, header.byteLength, true);
  bytes.set(header, 8);
  arrays.forEach((array, index) => bytes.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), payloadOffset + descriptors[index]!.offset));
  return frame;
}

export function decodeDataReadFrame(frame: ArrayBuffer): { id: string; value: ColumnDataReadResult } {
  if (frame.byteLength < 8 || frame.byteLength > MAX_FRAME_BYTES) throw new Error('采样二进制帧长度无效');
  const view = new DataView(frame);
  const headerBytes = view.getUint32(4, true);
  const payloadOffset = align(8 + headerBytes);
  if (view.getUint32(0, true) !== MAGIC || !headerBytes || payloadOffset > frame.byteLength) throw new Error('采样二进制帧头无效');
  const envelope = JSON.parse(decoder.decode(new Uint8Array(frame, 8, headerBytes))) as { id: string; value: ColumnDataReadResult; arrays: ArrayDescriptor[] };
  if (typeof envelope.id !== 'string' || envelope.value?.format !== 'columns-v1' || !Array.isArray(envelope.arrays) || envelope.arrays.length > 3000) throw new Error('采样二进制帧版本无效');
  let previousEnd = 0;
  const columns = envelope.arrays.map(descriptor => {
    const width = descriptor.type === 'f64' ? 8 : 1;
    const length = descriptor.length * width;
    if (!['f64', 'u8'].includes(descriptor.type) || !Number.isSafeInteger(descriptor.length) || descriptor.length < 0 || !Number.isSafeInteger(descriptor.offset) || descriptor.offset !== previousEnd || payloadOffset + descriptor.offset + length > frame.byteLength) throw new Error('采样二进制列边界无效');
    previousEnd = descriptor.offset + align(length);
    return descriptor.type === 'f64'
      ? new Float64Array(frame, payloadOffset + descriptor.offset, descriptor.length)
      : new Uint8Array(frame, payloadOffset + descriptor.offset, descriptor.length);
  });
  if (payloadOffset + previousEnd !== frame.byteLength) throw new Error('采样二进制帧尾无效');
  // Replace only known column members. Numeric bulk never passes through JSON parsing.
  for (const page of Object.values(envelope.value.series)) {
    for (const key of ['times', 'sequences', 'values'] as const) {
      const member = page.columns[key] as unknown;
      if (member && typeof member === 'object' && '$column' in member) {
        const index = (member as { $column: number }).$column;
        if (!Number.isInteger(index) || !columns[index]) throw new Error('采样二进制列引用无效');
        Object.assign(page.columns, { [key]: columns[index] });
      }
    }
    const samples = page.columns;
    if (!(samples.times instanceof Float64Array) || !(samples.sequences instanceof Float64Array) || samples.times.length !== samples.sequences.length || samples.times.length !== samples.values.length) throw new Error('采样列长度无效');
    if (samples.kind === 'number' ? !(samples.values instanceof Float64Array) : samples.kind === 'boolean' ? !(samples.values instanceof Uint8Array) : samples.kind !== 'string' || !Array.isArray(samples.values) || samples.values.some(item => typeof item !== 'string')) throw new Error('采样列类型无效');
  }
  return { id: envelope.id, value: envelope.value };
}
