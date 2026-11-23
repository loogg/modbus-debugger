import type { Workspace } from './model';
import type { BufferConfig, DataPointRef } from '../shared/point-data';
import { DEFAULT_BUFFER_CAPACITY, MAX_TOTAL_BUFFER_CAPACITY } from '../shared/point-data';
import { pointKey } from '../shared/point-key';
import { canvasSignals } from './canvas';

export interface BufferReference extends DataPointRef { references: string[] }
export function bufferReferences(workspace: Workspace): Map<string, BufferReference> {
  const result = new Map<string, BufferReference>();
  const add = (ref: DataPointRef, label: string) => {
    const key = pointKey(ref.slaveId, ref.pointId);
    const item = result.get(key) ?? { ...ref, references: [] };
    if (!item.references.includes(label)) item.references.push(label);
    result.set(key, item);
  };
  for (const group of workspace.trendGroups) {
    for (const signal of group.signals) add(signal.pointRef, `趋势 · ${group.name}`);
  }
  for (const canvas of workspace.canvases ?? []) {
    for (const widget of canvas.widgets) {
      if (widget.kind !== 'trend') continue;
      for (const signal of canvasSignals(widget)) add(signal, `画布 · ${canvas.name} / ${widget.label}`);
    }
  }
  return result;
}

export function bufferCapacity(workspace: Workspace, ref: DataPointRef): number {
  return workspace.sampleBuffers?.find(item => item.slaveId === ref.slaveId && item.pointId === ref.pointId)?.capacity ?? DEFAULT_BUFFER_CAPACITY;
}

export function validateBufferBudget(next: Workspace, previous: Workspace): void {
  const total = [...bufferReferences(next).values()].reduce((sum, ref) => sum + bufferCapacity(next, ref), 0);
  const prior = [...bufferReferences(previous).values()].reduce((sum, ref) => sum + bufferCapacity(previous, ref), 0);
  if (total > MAX_TOTAL_BUFFER_CAPACITY && total > prior) throw new Error(`采样缓冲总容量超过 ${MAX_TOTAL_BUFFER_CAPACITY.toLocaleString()} 点，请减小容量`);
}

export function withBufferConfigs(workspace: Workspace, configs: BufferConfig[], previous: Workspace = workspace): Workspace {
  const settings = new Map((workspace.sampleBuffers ?? []).map(item => [pointKey(item.slaveId, item.pointId), item]));
  for (const config of configs) {
    const slave = workspace.slaves.find(item => item.id === config.slaveId);
    const point = workspace.templates.find(item => item.id === slave?.templateId)?.points.find(item => item.id === config.pointId);
    if (!point) throw new Error('缓冲点位已不存在');
    settings.set(pointKey(config.slaveId, config.pointId), config);
  }
  const next = { ...workspace, sampleBuffers: [...settings.values()] };
  validateBufferBudget(next, previous);
  return next;
}
