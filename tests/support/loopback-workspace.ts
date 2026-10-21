import { connectionSchema, pointSchema, workspaceSchema, type Workspace } from '../../src/domain/model';
import type { PointMapping, WordOrder } from '../../src/domain/mapping';

export type LoopTransport = 'tcp' | 'rtu';
export interface LoopVector { id: string; mapping: PointMapping; initial: number | boolean | string; written: number | boolean | string; scale?: number; offset?: number; enumMap?: Record<string, string>; }
const map = (rawType: PointMapping['rawType'], offset: number, extra: Partial<PointMapping> = {}): PointMapping => ({ rawType, offset, registerCount: 1, wordOrder: 'ABCD', byteSelector: 'low', bitOffset: 0, bitWidth: 16, stringLength: 0, stringEncoding: 'ascii', ...extra });

export const loopVectors: LoopVector[] = [
  { id: 'Int8-high', mapping: map('Int8', 0, { byteSelector: 'high' }), initial: -5, written: -128 },
  { id: 'Int8-low', mapping: map('Int8', 0), initial: 127, written: -1 },
  { id: 'UInt8-high', mapping: map('UInt8', 1, { byteSelector: 'high' }), initial: 255, written: 128 },
  { id: 'UInt8-low', mapping: map('UInt8', 1), initial: 1, written: 255 },
  { id: 'UInt16', mapping: map('UInt16', 2), initial: 2468, written: 65535 },
  { id: 'Int16', mapping: map('Int16', 3), initial: -12345, written: -32768 },
  ...(['Int32', 'UInt32', 'Float32', 'Float64'] as const).flatMap((type, index) => (['ABCD', 'CDAB', 'BADC', 'DCBA'] as const).map((wordOrder, order) => ({
    id: `${type}-${wordOrder}`, mapping: map(type, 4 + index * 8 + order * (index === 3 ? 4 : 2), { wordOrder, registerCount: index === 3 ? 4 : 2 }),
    initial: type === 'Int32' ? -123456789 : type === 'UInt32' ? 0x12345678 : type === 'Float32' ? Math.fround(48.237) : Math.PI,
    written: type === 'Int32' ? -2147483648 : type === 'UInt32' ? 4294967295 : type === 'Float32' ? -12.5 : -Math.E,
  }))),
  { id: 'Register-Bool-low', mapping: map('Bool', 44, { bitOffset: 0, bitWidth: 1 }), initial: false, written: true },
  { id: 'Register-Bool-high', mapping: map('Bool', 44, { bitOffset: 15, bitWidth: 1 }), initial: true, written: false },
  { id: 'BitField', mapping: map('BitField', 45, { bitOffset: 4, bitWidth: 3 }), initial: 3, written: 5 },
  { id: 'BitField16', mapping: map('BitField', 46), initial: 0x1234, written: 0xffff },
  { id: 'Enum', mapping: map('UInt16', 47), initial: 2, written: 1, enumMap: { '0': '停止', '1': '运行', '2': '报警' } },
  { id: 'Enum-BitField', mapping: map('BitField', 48, { bitOffset: 4, bitWidth: 3 }), initial: 2, written: 1, enumMap: { '0': '停止', '1': '运行', '2': '报警' } },
  { id: 'ScaleOffset', mapping: map('Int16', 49), initial: 1234, written: -123, scale: 0.1, offset: -40 },
  { id: 'NegativeScale', mapping: map('Int16', 50), initial: 123, written: -42, scale: -2, offset: 10 },
  { id: 'Precision', mapping: map('Float64', 51, { registerCount: 4 }), initial: 1.234567890123, written: 2.345678901234 },
  { id: 'ASCII', mapping: map('String', 56, { registerCount: 4, stringLength: 8 }), initial: 'LoopBack', written: 'RTU-TCP!' },
  { id: 'UTF8', mapping: map('String', 60, { registerCount: 6, stringLength: 12, stringEncoding: 'utf8' }), initial: '温度25', written: '测试🙂' },
  { id: 'UTF8-odd', mapping: map('String', 66, { registerCount: 3, stringLength: 5, stringEncoding: 'utf8' }), initial: '中AB', written: '文CD' },
  { id: 'ASCII-one', mapping: map('String', 69, { stringLength: 1 }), initial: 'A', written: 'Z' },
  { id: 'EmptyString', mapping: map('String', 70, { registerCount: 4, stringLength: 8 }), initial: 'clear me', written: '' },
];

/** Independent reference bytes: Node's standard IEEE-754 writers and explicit permutations. */
export function goldenWords(vector: LoopVector, value: number | boolean | string, current: number[]): number[] {
  const { mapping: m } = vector;
  const next = current.slice();
  const previous = next[m.offset] ?? 0;
  if (m.rawType === 'Bool') { next[m.offset] = value ? previous | (1 << m.bitOffset) : previous & ~(1 << m.bitOffset) & 65535; return next; }
  if (m.rawType === 'BitField') { const mask = (m.bitWidth === 16 ? 65535 : 2 ** m.bitWidth - 1) << m.bitOffset; next[m.offset] = (previous & ~mask) | ((Number(value) << m.bitOffset) & mask); return next; }
  if (m.rawType.endsWith('8')) { const byte = Number(value) < 0 ? Number(value) + 256 : Number(value); next[m.offset] = m.byteSelector === 'high' ? (previous & 255) | byte * 256 : (previous & 65280) | byte; return next; }
  if (m.rawType.endsWith('16')) { next[m.offset] = Number(value) < 0 ? Number(value) + 65536 : Number(value); return next; }
  const bytes = Buffer.alloc(m.registerCount * 2);
  if (m.rawType === 'String') bytes.write(String(value), 0, m.stringLength, m.stringEncoding === 'utf8' ? 'utf8' : 'ascii');
  else if (m.rawType === 'Int32') bytes.writeInt32BE(Number(value));
  else if (m.rawType === 'UInt32') bytes.writeUInt32BE(Number(value));
  else if (m.rawType === 'Float32') bytes.writeFloatBE(Number(value));
  else bytes.writeDoubleBE(Number(value));
  const canonical = Array.from({ length: m.registerCount }, (_, index) => bytes.readUInt16BE(index * 2));
  const permutations: Record<WordOrder, number[]> = m.registerCount === 2
    ? { ABCD: [0, 1], CDAB: [1, 0], BADC: [0, 1], DCBA: [1, 0] }
    : { ABCD: [0, 1, 2, 3], CDAB: [2, 3, 0, 1], BADC: [0, 1, 2, 3], DCBA: [3, 2, 1, 0] };
  const ordered = m.rawType === 'String' ? canonical : permutations[m.wordOrder].map(index => {
    const word = canonical[index]!;
    return m.wordOrder === 'BADC' || m.wordOrder === 'DCBA' ? (word & 255) * 256 + (word >> 8) : word;
  });
  next.splice(m.offset, ordered.length, ...ordered);
  return next;
}

export function loopbackWorkspace(options: { tcpPort: number; transports?: LoopTransport[]; masterPort?: string; slavePort?: string }): Workspace {
  const transports = options.transports ?? ['tcp', 'rtu'];
  const raw = loopVectors.reduce((words, vector) => goldenWords(vector, vector.initial, words), Array<number>(125).fill(0));
  // Nonzero adjacent bits make accidental destructive RMW observable.
  raw[44] = raw[44]! | 0x5aa0; raw[45] = raw[45]! | 0xa50a; raw[48] = raw[48]! | 0xa50a;
  const blocks = [
    { id: 'coils', name: '线圈', area: 1, start: 0, length: 16, periodMs: 800 },
    { id: 'discrete', name: '离散输入', area: 2, start: 0, length: 16, periodMs: 800 },
    { id: 'holding', name: '所有类型 · 保持寄存器', area: 3, start: 100, length: 125, periodMs: 800 },
    { id: 'input', name: '所有类型 · 输入寄存器', area: 4, start: 300, length: 125, periodMs: 800 },
    { id: 'max-string', name: '246 字节 String', area: 3, start: 1000, length: 123, periodMs: 5000 },
    { id: 'max-coils', name: '2000 位线圈', area: 1, start: 1000, length: 2000, periodMs: 5000 },
    { id: 'adjacent-a', name: '连续 A', area: 3, start: 2000, length: 4, periodMs: 5000 },
    { id: 'adjacent-b', name: '连续 B', area: 3, start: 2004, length: 4, periodMs: 5000 },
    { id: 'last-address', name: '末地址', area: 3, start: 65535, length: 1, periodMs: 5000 },
  ];
  const points = [...loopVectors.flatMap(vector => ['holding', 'input'].map(blockId => ({ id: `${vector.id}-${blockId}`, name: `${vector.id}${blockId === 'input' ? ' · 输入' : ''}`, blockId,
    mapping: vector.mapping, scale: vector.scale ?? 1, offset: vector.offset ?? 0, access: blockId === 'holding' ? 'rw' : 'ro', enumMap: vector.enumMap ?? {}, decimalPlaces: vector.id === 'Precision' ? 3 : undefined })))
    , ...[0, 1].flatMap(index => ['coils', 'discrete'].map(blockId => ({ id: `${blockId}-${index}`, name: `${blockId}-${index}`, blockId, mapping: map('Bool', index, { bitWidth: 1 }), access: blockId === 'coils' ? 'rw' : 'ro' })))
    , { id: 'String-246', name: 'String-246', blockId: 'max-string', mapping: map('String', 0, { registerCount: 123, stringLength: 246 }), access: 'rw' }].map(point => pointSchema.parse(point));
  const connections = transports.flatMap(transport => ['server', 'master'].map(role => ({
    id: `${transport}-${role}`, name: `${transport.toUpperCase()} ${role === 'server' ? '从站' : '主站'}`, transport, role: role === 'server' ? 'slave' : 'master',
    tcp: transport === 'tcp' ? { host: '127.0.0.1', port: options.tcpPort } : undefined,
    rtu: transport === 'rtu' ? { port: role === 'server' ? options.slavePort ?? 'COM1' : options.masterPort ?? 'COM2', baudRate: 19200, dataBits: 8, parity: 'none', stopBits: 1 } : undefined,
    timeoutMs: 800, retries: 0, reconnect: 'manual', interFrameMs: 0, rtsControl: 'none', logLevel: 'info',
  }))).map(connection => connectionSchema.parse(connection));
  return workspaceSchema.parse({ name: 'TCP + RTU 主从全功能闭环', schemaVersion: 1, connections, templates: [{ id: 'loop-template', name: '全部类型与映射', blocks, points }],
    slaves: connections.flatMap(connection => [1, 2].map(unitId => ({ id: `${connection.id}-${unitId}`, connectionId: connection.id, unitId, name: `${connection.name} Unit ${unitId}`, enabled: true, templateId: 'loop-template',
      initialValues: connection.role === 'slave' ? [
        { blockId: 'holding', area: 3, start: 100, values: raw.map((value, index) => unitId === 2 && index === 2 ? 2222 : value) },
        { blockId: 'input', area: 4, start: 300, values: raw },
        { blockId: 'coils', area: 1, start: 0, values: Array.from({ length: 16 }, (_, index) => index % 2) },
        { blockId: 'discrete', area: 2, start: 0, values: Array.from({ length: 16 }, (_, index) => 1 - index % 2) },
        { blockId: 'max-string', area: 3, start: 1000, values: Array<number>(123).fill(0x5353) },
      ] : undefined }))),
    trendGroups: transports.map(transport => ({ id: `${transport}-trend`, name: `${transport.toUpperCase()} 主从四类趋势`, windowSec: 60,
      signals: ['master', 'server'].flatMap(role => ['Float32-ABCD-holding', 'Precision-holding', 'coils-0', 'Enum-holding', 'UTF8-holding'].map(pointId => ({ id: `${transport}-${role}-${pointId}`, pointRef: { connectionId: `${transport}-${role}`, slaveId: `${transport}-${role}-1`, pointId }, visible: true }))) })),
  });
}
