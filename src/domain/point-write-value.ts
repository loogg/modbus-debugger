import { stringWriteError, type RawType } from './mapping';
import type { PointDef } from './model';
import { engineeringToRaw } from './scale';

export interface PointWriteFields {
  engineering: number | null;
  boolValue: boolean | null;
  stringValue: string | null;
}

export function pointWriteFields(type: RawType, text: string): PointWriteFields {
  if (type === 'String') return { engineering: null, boolValue: null, stringValue: text };
  if (type === 'Bool') {
    const input = text.trim().toLowerCase();
    if (!['1', '0', 'true', 'false', 'on', 'off'].includes(input)) throw new Error('Bool 写入值必须为 0/1 或 ON/OFF');
    return { engineering: null, boolValue: ['1', 'true', 'on'].includes(input), stringValue: null };
  }
  if (!text.trim() || !Number.isFinite(Number(text))) throw new Error('请输入有效的有限数值');
  return { engineering: Number(text), boolValue: null, stringValue: null };
}

export function preparePointWrite(point: PointDef, fields: PointWriteFields): number | boolean | string {
  const mapping = point.mapping;
  if (mapping.rawType === 'Bool') {
    if (fields.boolValue === null) throw new Error('Bool 点位需要布尔值');
    return fields.boolValue;
  }
  if (mapping.rawType === 'String') {
    if (fields.stringValue === null) throw new Error('String 点位需要文本值');
    const error = stringWriteError(mapping, fields.stringValue);
    if (error) throw new Error(error);
    return fields.stringValue;
  }
  if (fields.engineering === null) throw new Error('缺少工程值');
  const scale = Object.keys(point.enumMap).length ? { scale: 1, offset: 0 } : { scale: point.scale, offset: point.offset };
  const converted = engineeringToRaw(fields.engineering, scale, mapping.rawType, mapping.bitWidth);
  if (!converted.ok) throw new Error(converted.reason);
  return converted.value;
}
