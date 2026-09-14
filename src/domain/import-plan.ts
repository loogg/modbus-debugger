import { registersForType, type RawType } from './mapping';
import type { BlockDef, PointDef } from './model';

export interface RegisterImportRow { address: number; area?: 1 | 2 | 3 | 4; name: string; type: string; access: string; unit: string; scale: string; offset: string }
const types: RawType[] = ['Bool', 'BitField', 'Int8', 'UInt8', 'Int16', 'UInt16', 'Int32', 'UInt32', 'Float32', 'Float64', 'String'];

export function buildImportPlan(rows: RegisterImportRow[], strategy: 'auto' | 'single', prefix: string): { blocks: BlockDef[]; points: PointDef[] } {
  if (!rows.length) throw new Error('没有可导入的点位');
  const prepared = rows.map((row, i) => {
    const rawType = types.find(type => type.toLowerCase() === row.type.trim().toLowerCase());
    const scale = row.scale.trim() === '' ? 1 : Number(row.scale);
    const offset = row.offset.trim() === '' ? 0 : Number(row.offset);
    const width = rawType ? registersForType(rawType, rawType === 'String' ? 8 : 0) : 0;
    const area = row.area ?? 3;
    if (!row.name.trim() || !rawType || !Number.isInteger(row.address) || row.address < 0 || row.address + width > 65536 || !Number.isFinite(scale) || scale === 0 || !Number.isFinite(offset)) throw new Error(`第 ${i + 1} 行名称、类型、地址或缩放无效`);
    if (area <= 2 && rawType !== 'Bool') throw new Error(`第 ${i + 1} 行：Coil/Discrete 点位必须使用 Bool`);
    return { ...row, area, rawType, scale, offset, width };
  });
  const areas = [...new Set(prepared.map(row => row.area))];
  if (strategy === 'single' && areas.length > 1) throw new Error('单块模式不能混合地址区，请使用自动分块');
  const blocks: BlockDef[] = [];
  const points: PointDef[] = [];
  for (const area of areas) {
    const sorted = prepared.filter(row => row.area === area).sort((a, b) => a.address - b.address);
    let chunk: typeof sorted = [];
    const max = area <= 2 ? 2000 : 125;
    const flush = () => {
      if (!chunk.length) return;
      const start = chunk[0]!.address;
      const end = Math.max(...chunk.map(row => row.address + row.width));
      if (end - start > max) throw new Error('单块长度超出 Modbus 限制，请使用自动分块');
      const id = `${prefix}-block-${blocks.length}`;
      blocks.push({ id, name: `导入数据块 ${blocks.length + 1}`, area, start, length: end - start, periodMs: 200 });
      for (const row of chunk) points.push({
        id: `${prefix}-point-${points.length}`, blockId: id, name: row.name,
        mapping: { rawType: row.rawType, offset: row.address - start, registerCount: row.width, wordOrder: 'ABCD', byteSelector: 'low', bitOffset: 0, bitWidth: row.rawType === 'Bool' ? 1 : 16, stringLength: row.rawType === 'String' ? 8 : 0, stringEncoding: 'ascii' },
        scale: row.scale, offset: row.offset, unit: row.unit, access: area === 2 || area === 4 ? 'ro' : /w/i.test(row.access) ? 'rw' : 'ro', displayFormat: 'auto', enumMap: {}, highRisk: false, description: '',
      });
      chunk = [];
    };
    for (const row of sorted) {
      if (strategy === 'auto' && chunk.length && (row.address + row.width - chunk[0]!.address > max || row.address - (chunk.at(-1)!.address + chunk.at(-1)!.width) > 8)) flush();
      chunk.push(row);
    }
    flush();
  }
  return { blocks, points };
}
