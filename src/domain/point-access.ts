import type { BlockDef, PointDef } from './model';
import { registersForType, type PointMapping } from './mapping';

export interface ReadRange { offset: number; length: number }
export const canReadPoint = (point: Pick<PointDef, 'access'>) => point.access !== 'wo';
export const canWritePoint = (point: Pick<PointDef, 'access'>) => point.access !== 'ro';
export const mappingWidth = (area: number, mapping: PointMapping) => area <= 2 ? 1 : registersForType(mapping.rawType, mapping.stringLength);
export const partialRegister = (mapping: PointMapping) => mapping.rawType === 'Bool' || ['Int8', 'UInt8'].includes(mapping.rawType) || mapping.rawType === 'BitField' && (mapping.bitWidth !== 16 || mapping.bitOffset !== 0);

/** Preserve raw block coverage while excluding write-only addresses without a readable alias. */
export function planBlockReads(block: BlockDef, points: PointDef[]): ReadRange[] {
  const allowed = new Array<boolean>(block.length).fill(true);
  const spans = points.filter(point => point.blockId === block.id).map(point => ({ point, start: point.mapping.offset, end: point.mapping.offset + mappingWidth(block.area, point.mapping) }));
  for (const span of spans.filter(item => !canReadPoint(item.point))) allowed.fill(false, span.start, span.end);
  for (const span of spans.filter(item => canReadPoint(item.point))) allowed.fill(true, span.start, span.end);
  const readable = spans.filter(item => canReadPoint(item.point)).sort((left, right) => right.start - left.start);
  if (spans.length && !readable.length) return [];
  const maximum = block.area <= 2 ? 2000 : 125;
  const result: ReadRange[] = [];
  let offset = 0;
  while (offset < block.length) {
    if (!allowed[offset]) { offset++; continue; }
    let end = offset;
    while (end < block.length && allowed[end] && end - offset < maximum) end++;
    for (const span of readable) if (span.start > offset && span.start < end && span.end > end) end = span.start;
    result.push({ offset, length: end - offset });
    offset = end;
  }
  for (const span of readable) if (!result.some(range => range.offset <= span.start && range.offset + range.length >= span.end)) result.push({ offset: span.start, length: span.end - span.start });
  result.sort((left, right) => left.offset - right.offset);
  return result;
}
