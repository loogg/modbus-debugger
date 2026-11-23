import { z } from 'zod';

export const moduleIdSchema = z.enum(['devices', 'realtime', 'trend', 'history', 'comm', 'templates', 'canvas', 'scripts', 'settings', 'about']);
export type ModuleId = z.infer<typeof moduleIdSchema>;
export const viewSelectionSchema = z.object({
  canvasId: z.string().nullable(), connectionId: z.string().nullable(), slaveId: z.string().nullable(),
  scriptId: z.string().nullable().optional(),
  scriptPointLookup: z.string().max(600).nullable().optional(),
  blockId: z.string().nullable(), templateId: z.string().nullable(), groupId: z.string().nullable(), sessionId: z.string().nullable(),
  commView: z.enum(['messages', 'health', 'trace']), historyTab: z.enum(['trend', 'events', 'data', 'signals']),
  trendTab: z.enum(['signals', 'chart']), realtimeScope: z.enum(['device', 'block']),
  trendWindowSec: z.number().int().min(5).max(86400).nullable().default(null),
  refreshMs: z.number().int().min(50).max(10000).optional(),
  deviceView: z.enum(['topology', 'scan', 'temp', 'memory']), templateEditing: z.boolean(), editBlockId: z.string().nullable(),
});
export type ViewSelection = z.infer<typeof viewSelectionSchema>;
export const workbenchViewSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  module: moduleIdSchema,
  selection: viewSelectionSchema.partial().default({}),
});
export const workbenchLayoutSchema = z.object({
  activeId: z.string().nullable(),
  views: z.array(workbenchViewSchema).max(40),
}).refine(layout => new Set(layout.views.map(v => v.id)).size === layout.views.length, '页面 ID 重复')
  .refine(layout => layout.activeId === null || layout.views.some(view => view.id === layout.activeId), '当前页面不存在');
export type WorkbenchView = z.infer<typeof workbenchViewSchema>;
export type WorkbenchLayout = z.infer<typeof workbenchLayoutSchema>;

export interface WindowHostApi {
  onCloseRequest(callback: (viewId: string) => void): () => void;
  close(viewId: string): Promise<void>;
}
export const WINDOW_CHANNELS = { closeRequest: 'view:close-request', close: 'view:close' } as const;
