import { z } from 'zod';

export const signalId = z.string().min(1).max(200);
export const signalValueSchema = z.union([z.number().finite(), z.boolean(), z.string().max(4000)]);
export type SignalValue = z.infer<typeof signalValueSchema>;
export interface CanvasSignalState {
  epoch: string;
  variables: Record<string, SignalValue>;
  controls: Record<string, SignalValue>;
}
const definition = z.object({ id: signalId, name: z.string().trim().min(1).max(120) });
export const workspaceVariableSchema = z.discriminatedUnion('type', [
  definition.extend({ type: z.literal('number'), initial: z.number().finite() }),
  definition.extend({ type: z.literal('boolean'), initial: z.boolean() }),
  definition.extend({ type: z.literal('string'), initial: z.string().max(4000) }),
]);
export type WorkspaceVariable = z.infer<typeof workspaceVariableSchema>;
export const widgetEventSchema = z.enum(['click', 'press', 'release', 'cancel', 'change', 'submit']);
export type WidgetEvent = z.infer<typeof widgetEventSchema>;
export const widgetEventLabels: Record<WidgetEvent, string> = {
  click: '点击', press: '按下', release: '松开', cancel: '取消按下', change: '切换', submit: '提交',
};
export const widgetEvents: Partial<Record<string, readonly WidgetEvent[]>> = {
  button: ['click', 'press', 'release', 'cancel'], switch: ['change'], input: ['submit'],
};
export type CanvasEventBinding =
  | { kind: 'widget'; canvasId: string; widgetId: string; event: WidgetEvent }
  | { kind: 'workspace'; variableId: string };
export const slaveEventStates = [['上线', 'online'], ['离线', 'offline']] as const;
export type SlaveEventState = typeof slaveEventStates[number][1];
export type EventBinding = CanvasEventBinding | { kind: 'point'; slaveId: string; pointId: string }
  | { kind: 'slaveState'; slaveId: string; state: SlaveEventState };
export interface ScriptInputEvent {
  binding: EventBinding;
  label: string;
  value: SignalValue;
  previous?: SignalValue;
  changes?: readonly string[];
}
export function widgetKey(canvasId: string, widgetId: string) { return JSON.stringify([canvasId, widgetId]); }
export function eventKey(binding: EventBinding) {
  if (binding.kind === 'slaveState') return JSON.stringify([binding.kind, binding.slaveId, binding.state]);
  if (binding.kind === 'point') return JSON.stringify([binding.kind, binding.slaveId, binding.pointId]);
  return binding.kind === 'widget' ? JSON.stringify([binding.kind, binding.canvasId, binding.widgetId, binding.event])
    : JSON.stringify([binding.kind, binding.variableId]);
}
