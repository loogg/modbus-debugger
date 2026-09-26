import { copyTemplate } from './template-copy';
import { workspaceSchema, type BlockDef, type ConnectionDef, type DeviceTemplate, type PointDef, type SlaveDef, type TrendGroup, type Workspace } from './model';

export type WorkspaceMutation =
  | { type: 'connection.upsert'; connection: ConnectionDef }
  | { type: 'slave.upsert'; slave: SlaveDef }
  | { type: 'template.add'; template: DeviceTemplate }
  | { type: 'template.copy'; sourceTemplateId: string; newId: string; name: string }
  | { type: 'template.upsertBlock'; templateId: string; block: BlockDef }
  | { type: 'template.patchBlock'; templateId: string; blockId: string; patch: Partial<Pick<BlockDef, 'name' | 'start' | 'length' | 'periodMs'>> }
  | { type: 'template.importContent'; templateId: string; blocks: BlockDef[]; points: PointDef[] }
  | { type: 'template.upsertPoint'; templateId: string; point: PointDef }
  | { type: 'trend.upsertGroup'; group: TrendGroup }
  | { type: 'trend.deleteGroup'; groupId: string }
  | { type: 'trend.addSignals'; groupId: string; signals: TrendGroup['signals'] }
  | { type: 'trend.removeSignal'; groupId: string; signalId: string }
  | { type: 'trend.setSignalVisible'; groupId: string; signalId: string; visible: boolean }
  | { type: 'trend.setWindow'; groupId: string; windowSec: number };

function requiredTemplate(workspace: Workspace, templateId: string): DeviceTemplate {
  const template = workspace.templates.find((item) => item.id === templateId);
  if (!template) throw new Error(`Template does not exist: ${templateId}`);
  return template;
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  return items.some((existing) => existing.id === item.id)
    ? items.map((existing) => existing.id === item.id ? item : existing)
    : [...items, item];
}

function rejectPointIdsFromOtherTemplates(workspace: Workspace, templateId: string, points: PointDef[]): void {
  const otherIds = new Set(workspace.templates.filter((template) => template.id !== templateId).flatMap((template) => template.points.map((point) => point.id)));
  const duplicate = points.find((point) => otherIds.has(point.id));
  if (duplicate) throw new Error(`Point ID already belongs to another template: ${duplicate.id}`);
}

function validateTrendReferences(workspace: Workspace, group: TrendGroup): void {
  for (const signal of group.signals) {
    const ref = signal.pointRef;
    const slave = workspace.slaves.find((item) => item.id === ref.slaveId && item.connectionId === ref.connectionId);
    const template = slave && workspace.templates.find((item) => item.id === slave.templateId);
    if (!template?.points.some((point) => point.id === ref.pointId)) {
      throw new Error(`Trend signal references missing point or slave: ${signal.id}`);
    }
  }
}

/** Apply one edit to Main's current workspace; no renderer snapshot is used as the source. */
export function mutateWorkspace(workspace: Workspace, mutation: WorkspaceMutation): Workspace {
  let next: Workspace;
  switch (mutation.type) {
    case 'connection.upsert':
      next = { ...workspace, connections: upsertById(workspace.connections, mutation.connection) };
      break;
    case 'slave.upsert':
      if (!workspace.connections.some((connection) => connection.id === mutation.slave.connectionId)) {
        throw new Error(`Connection does not exist: ${mutation.slave.connectionId}`);
      }
      if (mutation.slave.templateId && !workspace.templates.some((template) => template.id === mutation.slave.templateId)) {
        throw new Error(`Template does not exist: ${mutation.slave.templateId}`);
      }
      next = { ...workspace, slaves: upsertById(workspace.slaves, mutation.slave) };
      break;
    case 'template.add':
      if (workspace.templates.some((template) => template.id === mutation.template.id)) {
        throw new Error(`Template ID already exists: ${mutation.template.id}`);
      }
      rejectPointIdsFromOtherTemplates(workspace, mutation.template.id, mutation.template.points);
      next = { ...workspace, templates: [...workspace.templates, mutation.template] };
      break;
    case 'template.copy': {
      const source = requiredTemplate(workspace, mutation.sourceTemplateId);
      if (workspace.templates.some((template) => template.id === mutation.newId)) {
        throw new Error(`Template ID already exists: ${mutation.newId}`);
      }
      const copy = copyTemplate(source, mutation.newId, mutation.name);
      rejectPointIdsFromOtherTemplates(workspace, mutation.newId, copy.points);
      next = { ...workspace, templates: [...workspace.templates, copy] };
      break;
    }
    case 'template.upsertBlock':
      requiredTemplate(workspace, mutation.templateId);
      next = {
        ...workspace,
        templates: workspace.templates.map((template) => template.id === mutation.templateId
          ? { ...template, blocks: upsertById(template.blocks, mutation.block) }
          : template),
      };
      break;
    case 'template.patchBlock': {
      const template = requiredTemplate(workspace, mutation.templateId);
      if (!template.blocks.some((block) => block.id === mutation.blockId)) {
        throw new Error(`Block does not exist: ${mutation.blockId}`);
      }
      next = {
        ...workspace,
        templates: workspace.templates.map((item) => item.id === mutation.templateId
          ? { ...item, blocks: item.blocks.map((block) => block.id === mutation.blockId ? { ...block, ...mutation.patch } : block) }
          : item),
      };
      break;
    }
    case 'template.importContent': {
      requiredTemplate(workspace, mutation.templateId);
      rejectPointIdsFromOtherTemplates(workspace, mutation.templateId, mutation.points);
      next = {
        ...workspace,
        templates: workspace.templates.map((item) => item.id === mutation.templateId
          ? { ...item, blocks: [...item.blocks, ...mutation.blocks], points: [...item.points, ...mutation.points] }
          : item),
      };
      break;
    }
    case 'template.upsertPoint': {
      const template = requiredTemplate(workspace, mutation.templateId);
      if (!template.blocks.some((block) => block.id === mutation.point.blockId)) {
        throw new Error(`Block does not exist: ${mutation.point.blockId}`);
      }
      rejectPointIdsFromOtherTemplates(workspace, mutation.templateId, [mutation.point]);
      next = {
        ...workspace,
        templates: workspace.templates.map((item) => item.id === mutation.templateId
          ? { ...item, points: upsertById(item.points, mutation.point) }
          : item),
      };
      break;
    }
    case 'trend.upsertGroup':
      validateTrendReferences(workspace, mutation.group);
      next = { ...workspace, trendGroups: upsertById(workspace.trendGroups, mutation.group) };
      break;
    case 'trend.deleteGroup':
      if (!workspace.trendGroups.some((group) => group.id === mutation.groupId)) {
        throw new Error(`Trend group does not exist: ${mutation.groupId}`);
      }
      next = { ...workspace, trendGroups: workspace.trendGroups.filter((group) => group.id !== mutation.groupId) };
      break;
    case 'trend.addSignals': {
      const group = workspace.trendGroups.find((item) => item.id === mutation.groupId);
      if (!group) throw new Error(`Trend group does not exist: ${mutation.groupId}`);
      const updated = { ...group, signals: [...group.signals, ...mutation.signals] };
      if (new Set(updated.signals.map((signal) => signal.id)).size !== updated.signals.length) {
        throw new Error('Trend signal ID already exists');
      }
      if (new Set(updated.signals.map((signal) => `${signal.pointRef.slaveId}:${signal.pointRef.pointId}`)).size !== updated.signals.length) {
        throw new Error('Point already belongs to this trend group');
      }
      validateTrendReferences(workspace, updated);
      next = { ...workspace, trendGroups: workspace.trendGroups.map((item) => item.id === mutation.groupId ? updated : item) };
      break;
    }
    case 'trend.removeSignal': {
      const group = workspace.trendGroups.find((item) => item.id === mutation.groupId);
      if (!group?.signals.some((signal) => signal.id === mutation.signalId)) throw new Error('Trend signal does not exist');
      next = { ...workspace, trendGroups: workspace.trendGroups.map((item) => item.id === mutation.groupId
        ? { ...item, signals: item.signals.filter((signal) => signal.id !== mutation.signalId) }
        : item) };
      break;
    }
    case 'trend.setSignalVisible': {
      const group = workspace.trendGroups.find((item) => item.id === mutation.groupId);
      if (!group?.signals.some((signal) => signal.id === mutation.signalId)) throw new Error('Trend signal does not exist');
      next = { ...workspace, trendGroups: workspace.trendGroups.map((item) => item.id === mutation.groupId
        ? { ...item, signals: item.signals.map((signal) => signal.id === mutation.signalId ? { ...signal, visible: mutation.visible } : signal) }
        : item) };
      break;
    }
    case 'trend.setWindow': {
      if (!workspace.trendGroups.some((group) => group.id === mutation.groupId)) throw new Error(`Trend group does not exist: ${mutation.groupId}`);
      next = { ...workspace, trendGroups: workspace.trendGroups.map((group) => group.id === mutation.groupId ? { ...group, windowSec: mutation.windowSec } : group) };
      break;
    }
  }
  return workspaceSchema.parse(next);
}
