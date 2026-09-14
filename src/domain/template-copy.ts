import type { DeviceTemplate } from './model';

export function copyTemplate(template: DeviceTemplate, id: string, name: string): DeviceTemplate {
  const blockIds = new Map(template.blocks.map((block, i) => [block.id, `${id}-block-${i}`]));
  return { ...template, id, name,
    blocks: template.blocks.map(block => ({ ...block, id: blockIds.get(block.id)! })),
    points: template.points.map((point, i) => ({ ...point, id: `${id}-point-${i}`, blockId: blockIds.get(point.blockId)!, mapping: { ...point.mapping }, enumMap: { ...point.enumMap } })),
  };
}
