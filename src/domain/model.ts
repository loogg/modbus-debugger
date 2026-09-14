import { z } from 'zod';
import { registersForType, type PointMapping } from './mapping';
import { findBlockOverlaps } from './overlap';

export const areaSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export type AreaCodeModel = z.infer<typeof areaSchema>;

export const mappingSchema = z.object({
  rawType: z.enum(['Bool', 'BitField', 'Int8', 'UInt8', 'Int16', 'UInt16', 'Int32', 'UInt32', 'Float32', 'Float64', 'String']),
  offset: z.number().int().min(0),
  registerCount: z.number().int().min(1),
  wordOrder: z.enum(['ABCD', 'CDAB', 'BADC', 'DCBA']),
  byteSelector: z.enum(['high', 'low']),
  bitOffset: z.number().int().min(0).max(15),
  bitWidth: z.number().int().min(1).max(16),
  stringLength: z.number().int().min(0).max(246),
  stringEncoding: z.enum(['ascii', 'utf8']),
}) satisfies z.ZodType<PointMapping, z.ZodTypeDef, PointMapping>;

export const pointSchema = z.object({
  id: z.string(),
  blockId: z.string(),
  name: z.string().min(1),
  mapping: mappingSchema,
  scale: z.number().finite().refine(value => value !== 0, 'Scale must not be zero').default(1),
  offset: z.number().default(0),
  unit: z.string().default(''),
  access: z.enum(['ro', 'rw']),
  displayFormat: z.enum(['auto', 'hex', 'binary']).default('auto'),
  enumMap: z.record(z.string()).default({}),
  highRisk: z.boolean().default(false),
  description: z.string().default(''),
});
export type PointDef = z.infer<typeof pointSchema>;

export const blockSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  area: areaSchema,
  start: z.number().int().min(0).max(65535),
  length: z.number().int().min(1).max(2000),
  periodMs: z.number().int().min(20).max(60000),
});
export type BlockDef = z.infer<typeof blockSchema>;

export const templateSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  version: z.string().default('1.0'),
  description: z.string().default(''),
  blocks: z.array(blockSchema),
  points: z.array(pointSchema),
});
export type DeviceTemplate = z.infer<typeof templateSchema>;

export const rtuSettingsSchema = z.object({
  port: z.string(),
  baudRate: z.number().int(),
  dataBits: z.union([z.literal(7), z.literal(8)]),
  parity: z.enum(['none', 'even', 'odd']),
  stopBits: z.union([z.literal(1), z.literal(2)]),
});
export type RtuSettings = z.infer<typeof rtuSettingsSchema>;

export const tcpSettingsSchema = z.object({
  host: z.string(),
  port: z.number().int().min(1).max(65535),
});
export type TcpSettings = z.infer<typeof tcpSettingsSchema>;

export const connectionSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  transport: z.enum(['rtu', 'tcp']),
  rtu: rtuSettingsSchema.optional(),
  tcp: tcpSettingsSchema.optional(),
  timeoutMs: z.number().int().min(50).max(10000).default(500),
  retries: z.number().int().min(0).max(5).default(1),
  reconnect: z.enum(['auto', 'manual']).default('auto'),
  interFrameMs: z.number().min(0).max(100).default(0),
  rtsControl: z.enum(['none', 'toggle']).default('none'),
  logLevel: z.enum(['info', 'debug']).default('info'),

});
export type ConnectionDef = z.infer<typeof connectionSchema>;

export const slaveSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  unitId: z.number().int().min(1).max(247),
  name: z.string().min(1),
  templateId: z.string(),
  enabled: z.boolean().default(true),
});
export type SlaveDef = z.infer<typeof slaveSchema>;

export const trendSignalSchema = z.object({
  id: z.string(),
  pointRef: z.object({
    connectionId: z.string(),
    slaveId: z.string(),
    pointId: z.string(),
  }),
  visible: z.boolean().default(true),
});
export type TrendSignal = z.infer<typeof trendSignalSchema>;

export const trendGroupSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  windowSec: z.number().int().min(5).max(86400).default(60),
  description: z.string().default(''),
  signals: z.array(trendSignalSchema),
});
export type TrendGroup = z.infer<typeof trendGroupSchema>;

export const layoutSchema = z.object({
  module: z.string().default('devices'),
  selection: z.record(z.string().nullable()).default({}),
});

export const workspaceSchema = z.object({
  schemaVersion: z.number().int().default(1),
  name: z.string().default('未命名工作区'),
  connections: z.array(connectionSchema).default([]),
  slaves: z.array(slaveSchema).default([]),
  templates: z.array(templateSchema).default([]),
  trendGroups: z.array(trendGroupSchema).default([]),
  layout: layoutSchema.default({ module: 'devices', selection: {} }),
}).superRefine((ws, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  for (const [label, rows] of [['connection', ws.connections], ['slave', ws.slaves], ['template', ws.templates], ['group', ws.trendGroups]] as const) {
    if (new Set(rows.map(row => row.id)).size !== rows.length) fail(`Duplicate ${label} id`);
  }
  const pointIds = new Set<string>();
  for (const template of ws.templates) {
    if (new Set(template.blocks.map(block => block.id)).size !== template.blocks.length) fail('Duplicate block id');
    if (findBlockOverlaps(template.blocks).length) fail('Blocks in the same area overlap');
    for (const block of template.blocks) {
      if (block.start + block.length > 65536 || (block.area >= 3 && block.length > 125)) fail('Block exceeds Modbus address/quantity limits');
    }
    for (const point of template.points) {
      if (pointIds.has(point.id)) fail('Point ids must be unique between templates');
      pointIds.add(point.id);
      const block = template.blocks.find(b => b.id === point.blockId);
      if (!block) { fail('Point references missing block'); continue; }
      const width = block.area <= 2 ? 1 : registersForType(point.mapping.rawType, point.mapping.stringLength);
      if (point.mapping.offset + width > block.length || point.mapping.registerCount < width) fail(`Point ${point.name} exceeds its block`);
      if (block.area <= 2 && point.mapping.rawType !== 'Bool') fail('Coils/discrete inputs require Bool points');
      if ((block.area === 2 || block.area === 4) && point.access !== 'ro') fail('Input areas are read-only');
      if (point.mapping.rawType === 'BitField' && point.mapping.bitOffset + point.mapping.bitWidth > 16) fail('Bit field exceeds one register');
    }
  }
  const unitIds = new Set<string>();
  for (const slave of ws.slaves) {
    if (!ws.connections.some(c => c.id === slave.connectionId)) fail('Slave references missing connection');
    if (slave.templateId && !ws.templates.some(t => t.id === slave.templateId)) fail('Slave references missing template');
    const key = `${slave.connectionId}:${slave.unitId}`;
    if (unitIds.has(key)) fail('Unit ID is already used on this connection');
    unitIds.add(key);
  }
});
export type Workspace = z.infer<typeof workspaceSchema>;

export const WORKSPACE_SCHEMA_VERSION = 1;

export function emptyWorkspace(name = '未命名工作区'): Workspace {
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    name,
    connections: [],
    slaves: [],
    templates: [],
    trendGroups: [],
    layout: { module: 'devices', selection: {} },
  };
}

/** Migrate older workspace payloads to the current schema version. */
export function migrateWorkspace(raw: unknown): Workspace {
  if (typeof raw !== 'object' || raw === null) throw new Error('workspace payload is not an object');
  const obj = raw as Record<string, unknown>;
  const version = typeof obj.schemaVersion === 'number' ? obj.schemaVersion : 0;
  if (version > WORKSPACE_SCHEMA_VERSION) {
    throw new Error(`workspace schemaVersion ${version} is newer than supported ${WORKSPACE_SCHEMA_VERSION}`);
  }
  // v0 -> v1: templates stored blocks+points separately as `blocks`/`points` top-level arrays.
  if (version < 1) {
    const blocks = Array.isArray(obj.blocks) ? (obj.blocks as unknown[]) : [];
    const points = Array.isArray(obj.points) ? (obj.points as unknown[]) : [];
    const templates = Array.isArray(obj.templates) ? (obj.templates as unknown[]) : [];
    obj.templates = templates.map((t) => {
      const tt = t as Record<string, unknown>;
      return { ...tt, blocks: blocks.filter((b) => (b as { templateId?: string }).templateId === tt.id), points: points.filter((p) => (p as { templateId?: string }).templateId === tt.id) };
    });
    delete obj.blocks;
    delete obj.points;
    obj.schemaVersion = 1;
  }
  return workspaceSchema.parse(obj);
}
