import { z } from 'zod';
import { workspaceSchema } from '../domain/model';

export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('workspace.new') }),
  z.object({ type: z.literal('workspace.open'), path: z.string().nullable() }),
  z.object({ type: z.literal('workspace.save') }),
  z.object({ type: z.literal('workspace.saveAs'), path: z.string() }),
  z.object({ type: z.literal('workspace.export') }),
  z.object({ type: z.literal('workspace.importText'), text: z.string() }),
  z.object({ type: z.literal('workspace.apply'), workspace: workspaceSchema }),
  z.object({ type: z.literal('connection.connect'), connectionId: z.string() }),
  z.object({ type: z.literal('connection.disconnect'), connectionId: z.string() }),
  z.object({
    type: z.literal('point.write'),
    slaveId: z.string(),
    pointId: z.string(),
    engineering: z.number().nullable(),
    boolValue: z.boolean().nullable(),
    stringValue: z.string().nullable(),
  }),
  z.object({ type: z.literal('device.scan'), connectionId: z.string(), from: z.number().int().min(1), to: z.number().int().max(247) }),
  z.object({
    type: z.literal('device.temporaryRead'),
    connectionId: z.string(),
    unitId: z.number().int().min(1).max(247),
    area: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    start: z.number().int().min(0),
    quantity: z.number().int().min(1).max(125),
  }),
  z.object({ type: z.literal('trend.startRecording'), groupId: z.string() }),
  z.object({ type: z.literal('trend.stopRecording') }),
  z.object({ type: z.literal('history.sessions') }),
  z.object({ type: z.literal('history.session'), sessionId: z.string() }),
  z.object({ type: z.literal('history.sessionData'), sessionId: z.string() }),
  z.object({ type: z.literal('prefs.set'), patch: z.object({
      sidebarWidth: z.number().optional(),
      persistRawComm: z.boolean().optional(),
      historyDbPath: z.string().nullable().optional(),
      /** IANA zone name, or 'local' to follow the OS. */
      timezone: z.string().optional(),
      /** BCP-47 tag; only zh-CN is wired today. */
      language: z.string().optional(),
    }) }),
  z.object({ type: z.literal('diagnostics.clear') }),
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