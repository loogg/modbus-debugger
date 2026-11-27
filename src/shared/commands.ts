import { z } from 'zod';
import { diagnosticsReadSchema } from './diagnostics';
import { blockSchema, connectionSchema, pointSchema, slaveSchema, templateSchema, trendGroupSchema, trendSignalSchema, workspaceSchema } from '../domain/model';
import { scanOptionsSchema } from './scan-options';
import { canvasChangesSchema, canvasSchema } from '../domain/canvas';
import { workbenchLayoutSchema } from './workbench';
import { bufferConfigSchema, dataReadSchema, pointRefSchema } from './point-data';
import { masterScriptSchema } from '../domain/master-script';

import { signalId, signalValueSchema, widgetEventSchema, workspaceVariableSchema } from '../domain/canvas-script';

export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('variable.save'), variable: workspaceVariableSchema, expected: workspaceVariableSchema.nullable() }),
  z.object({ type: z.literal('variable.delete'), expected: workspaceVariableSchema }),
  z.object({ type: z.literal('canvas.interact'), epoch: signalId, actionId: signalId, canvasId: signalId, widgetId: signalId,
    revision: z.number().int().nonnegative(), event: widgetEventSchema, value: signalValueSchema.optional() }),
  dataReadSchema,
  z.object({ type: z.literal('data.demand'), clientId: z.string().min(1).max(100), points: z.array(pointRefSchema).max(320000) }),
  z.object({ type: z.literal('buffer.configure'), config: bufferConfigSchema, expectedCapacity: z.number().int().optional() }),
  z.object({ type: z.literal('buffer.export'), points: z.array(pointRefSchema).min(1).max(1000), path: z.string().min(1), startMs: z.number().finite().optional(), endMs: z.number().finite().optional() }),
  z.object({ type: z.literal('canvas.create'), canvas: canvasSchema }),
  z.object({ type: z.literal('canvas.edit'), canvasId: z.string(), expectedRevision: z.number().int().min(0), changes: canvasChangesSchema }),
  z.object({ type: z.literal('canvas.delete'), canvasId: z.string(), expectedRevision: z.number().int().min(0) }),
  z.object({ type: z.literal('script.save'), script: masterScriptSchema.omit({ revision: true }), expectedRevision: z.number().int().nonnegative().nullable() }),
  z.object({ type: z.literal('script.delete'), scriptId: z.string(), expectedRevision: z.number().int().nonnegative() }),
  z.object({ type: z.literal('script.plan'), scriptId: z.string(), revision: z.number().int().nonnegative() }),
  z.object({ type: z.literal('script.start'), scriptId: z.string(), revision: z.number().int().nonnegative(), approval: z.string().max(64).optional(), debug: z.boolean().optional() }),
  z.object({ type: z.literal('script.pause'), runId: z.string() }),
  z.object({ type: z.literal('script.resume'), runId: z.string(), token: z.string(), mode: z.enum(['continue', 'step']) }),
  z.object({ type: z.literal('script.breakpoint'), runId: z.string(), blockId: z.string().min(1).max(250), enabled: z.boolean() }),
  z.object({ type: z.literal('script.stop'), runId: z.string() }),
  z.object({ type: z.literal('script.confirmWrite'), runId: z.string(), token: z.string() }),
  z.object({ type: z.literal('script.exportFile'), scriptId: z.string(), path: z.string().min(1) }),
  z.object({ type: z.literal('workbench.saveLayout'), layout: workbenchLayoutSchema }),
  z.object({ type: z.literal('update.status') }),
  z.object({ type: z.literal('update.install') }),
  z.object({ type: z.literal('update.confirmBoot') }),
  z.object({ type: z.literal('update.check') }),
  z.object({ type: z.literal('update.download') }),
  z.object({ type: z.literal('update.cancel') }),
  z.object({ type: z.literal('update.reveal') }),
  z.object({ type: z.literal('update.openLink'), target: z.enum(['repository', 'releases']) }),
  z.object({ type: z.literal('workspace.new') }),
  z.object({ type: z.literal('template.importFile'), path: z.string() }),
  z.object({ type: z.literal('history.addNote'), sessionId: z.string(), text: z.string().trim().min(1).max(2000), tMs: z.number().int().min(0) }),
  z.object({ type: z.literal('workspace.open'), path: z.string().nullable() }),
  z.object({ type: z.literal('workspace.save') }),
  z.object({ type: z.literal('template.save'), templateId: z.string(), blockId: z.string().optional() }),
  z.object({ type: z.literal('template.rename'), templateId: z.string(), name: z.string().trim().min(1).max(200), expectedName: z.string().optional() }),
  z.object({ type: z.literal('template.deleteBlock'), templateId: z.string(), blockId: z.string() }),
  z.object({ type: z.literal('template.deletePoint'), templateId: z.string(), pointId: z.string() }),
  z.object({ type: z.literal('workspace.saveAs'), path: z.string() }),
  z.object({ type: z.literal('workspace.export') }),
  z.object({ type: z.literal('workspace.exportFile'), path: z.string().min(1) }),
  z.object({ type: z.literal('workspace.importText'), text: z.string() }),
  z.object({ type: z.literal('workspace.apply'), workspace: workspaceSchema }),
  z.object({ type: z.literal('connection.upsert'), connection: connectionSchema, expected: connectionSchema.nullable().optional() }),
  z.object({ type: z.literal('slave.upsert'), slave: slaveSchema, expected: slaveSchema.nullable().optional() }),
  z.object({ type: z.literal('template.add'), template: templateSchema }),
  z.object({ type: z.literal('template.copy'), sourceTemplateId: z.string(), newId: z.string(), name: z.string().min(1) }),
  z.object({ type: z.literal('template.upsertBlock'), templateId: z.string(), block: blockSchema, expected: blockSchema.nullable().optional() }),
  z.object({ type: z.literal('template.patchBlock'), templateId: z.string(), blockId: z.string(), patch: blockSchema.pick({ name: true, start: true, length: true, periodMs: true }).partial() }),
  z.object({ type: z.literal('template.importContent'), templateId: z.string(), blocks: z.array(blockSchema), points: z.array(pointSchema) }),
  z.object({ type: z.literal('template.upsertPoint'), templateId: z.string(), point: pointSchema, expected: pointSchema.nullable().optional() }),
  z.object({ type: z.literal('trend.upsertGroup'), group: trendGroupSchema }),
  z.object({ type: z.literal('trend.deleteGroup'), groupId: z.string() }),
  z.object({ type: z.literal('trend.addSignals'), groupId: z.string(), signals: z.array(trendSignalSchema).min(1), buffers: z.array(bufferConfigSchema).optional() }),
  z.object({ type: z.literal('trend.removeSignal'), groupId: z.string(), signalId: z.string() }),
  z.object({ type: z.literal('trend.setSignalVisible'), groupId: z.string(), signalId: z.string(), visible: z.boolean() }),
  z.object({ type: z.literal('trend.setWindow'), groupId: z.string(), windowSec: z.number().int().min(5).max(86400) }),
  z.object({ type: z.literal('connection.connect'), connectionId: z.string() }),
  z.object({ type: z.literal('connection.disconnect'), connectionId: z.string() }),
  z.object({ type: z.literal('slave.setValues'), slaveId: z.string(), blockId: z.string(), offset: z.number().int().min(0), values: z.array(z.number().int().min(0).max(65535)).min(1).max(2000) }),
  z.object({ type: z.literal('slave.saveInitialValues'), slaveId: z.string() }),
  z.object({
    type: z.literal('point.write'),
    slaveId: z.string(),
    pointId: z.string(),
    engineering: z.number().nullable(),
    boolValue: z.boolean().nullable(),
    stringValue: z.string().nullable(),
  }),
  z.object({ type: z.literal('device.scan'), connectionId: z.string(), from: z.number().int().min(1).max(247), to: z.number().int().min(1).max(247), options: scanOptionsSchema.optional() }),
  z.object({ type: z.literal('device.stopScan'), connectionId: z.string() }),
  z.object({ type: z.literal('device.refresh'), slaveId: z.string(), blockId: z.string().optional() }),
  z.object({
    type: z.literal('device.temporaryRead'),
    connectionId: z.string(),
    unitId: z.number().int().min(1).max(247),
    area: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    start: z.number().int().min(0),
    quantity: z.number().int().min(1).max(125),
  }),
  z.object({ type: z.literal('history.sessions') }),
  z.object({ type: z.literal('history.session'), sessionId: z.string() }),
  z.object({ type: z.literal('history.sessionData'), sessionId: z.string() }),
  z.object({ type: z.literal('prefs.set'), patch: z.object({
      sidebarWidth: z.number().optional(),
      historyDbPath: z.string().nullable().optional(),
      /** IANA zone name, or 'local' to follow the OS. */
      timezone: z.string().optional(),
      /** BCP-47 tag; only zh-CN is wired today. */
      language: z.string().optional(),
    }).strict() }),
  z.object({ type: z.literal('diagnostics.clear') }),
  diagnosticsReadSchema,
  z.object({
    type: z.literal('diagnostics.healthSeries'),
    connectionId: z.string(),
    windowMs: z.number().int().min(1000).max(600000),
  }),
  z.object({
    type: z.literal('import.parse'),
    source: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('text'), text: z.string(), format: z.enum(['csv', 'json', 'clipboard']) }),
      z.object({ kind: z.literal('file'), path: z.string() }),
    ]),
  }),
  z.object({ type: z.literal('serial.list') }),
  z.object({ type: z.literal('dialog.openFile'), accept: z.array(z.string()) }),
  z.object({ type: z.literal('dialog.saveFile'), defaultName: z.string() }),
]);

export type Command = z.infer<typeof commandSchema>;

export type CommandResult<T = unknown> = { ok: true; value: T } | { ok: false; error: string };
