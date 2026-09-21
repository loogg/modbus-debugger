import { registersForType } from './mapping';
import type { BlockDef, PointDef, Workspace } from './model';

export function pointMemorySpan(block: BlockDef, point: PointDef) {
  const width = block.area <= 2 ? 1 : registersForType(point.mapping.rawType, point.mapping.stringLength);
  const startBit = block.area <= 2 ? 0 : point.mapping.rawType === 'Bool' || point.mapping.rawType === 'BitField' ? point.mapping.bitOffset : ['Int8','UInt8'].includes(point.mapping.rawType) && point.mapping.byteSelector === 'high' ? 8 : 0;
  const bits = block.area <= 2 || point.mapping.rawType === 'Bool' ? 1 : point.mapping.rawType === 'BitField' ? point.mapping.bitWidth : ['Int8','UInt8'].includes(point.mapping.rawType) ? 8 : 16;
  return { start: point.mapping.offset, end: point.mapping.offset + width - 1, width, startBit, endBit: startBit + bits - 1 };
}

/** Remove only this template's block, its points and references from bound instances. */
export function removeTemplateBlock(workspace: Workspace, templateId: string, blockId: string): Workspace {
  const template = workspace.templates.find(t => t.id === templateId);
  if (!template?.blocks.some(b => b.id === blockId)) throw new Error('数据块不存在');
  const removed = new Set(template.points.filter(p => p.blockId === blockId).map(p => p.id));
  const bound = new Set(workspace.slaves.filter(s => s.templateId === templateId).map(s => s.id));
  return { ...workspace,
    templates: workspace.templates.map(t => t.id === templateId ? { ...t, blocks: t.blocks.filter(b => b.id !== blockId), points: t.points.filter(p => p.blockId !== blockId) } : t),
    trendGroups: workspace.trendGroups.map(g => ({ ...g, signals: g.signals.filter(s => !(bound.has(s.pointRef.slaveId) && removed.has(s.pointRef.pointId))) })),
  };
}

/** Remove a single point from a template and clean up its references in bound slaves' trend groups. */
export function removeTemplatePoint(workspace: Workspace, templateId: string, pointId: string): Workspace {
  const template = workspace.templates.find(t => t.id === templateId);
  if (!template?.points.some(p => p.id === pointId)) throw new Error('点位不存在');
  const bound = new Set(workspace.slaves.filter(s => s.templateId === templateId).map(s => s.id));
  return { ...workspace,
    templates: workspace.templates.map(t => t.id === templateId ? { ...t, points: t.points.filter(p => p.id !== pointId) } : t),
    trendGroups: workspace.trendGroups.map(g => ({ ...g, signals: g.signals.filter(s => !(bound.has(s.pointRef.slaveId) && s.pointRef.pointId === pointId)) })),
  };
}

