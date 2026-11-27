import { randomUUID } from 'node:crypto';
import { checkInputBinding } from '../../domain/canvas-binding';
import { signalValueSchema, widgetEventLabels, widgetKey, type CanvasSignalState, type ScriptInputEvent, type SignalValue } from '../../domain/canvas-script';
import type { Workspace } from '../../domain/model';
import type { Command } from '../../shared/commands';

export class CanvasSignals {
  private epoch = randomUUID();
  private readonly values = new Map<string, SignalValue>();
  private readonly controls = new Map<string, SignalValue>();
  private readonly actions = new Map<string, number>();
  private cached?: CanvasSignalState;

  constructor(private readonly workspace: () => Workspace, private readonly dispatch: (event: ScriptInputEvent) => number) {}

  get snapshot(): CanvasSignalState {
    return this.cached ??= { epoch: this.epoch,
      variables: Object.fromEntries((this.workspace().variables ?? []).map(v => [v.id, this.values.get(v.id) ?? v.initial])),
      controls: Object.fromEntries(this.controls) };
  }
  reset() {
    this.epoch = randomUUID();
    this.values.clear(); this.controls.clear(); this.actions.clear(); this.cached = undefined;
  }
  definitionChanged(id: string, liveValue?: SignalValue) {
    if (liveValue === undefined) this.values.delete(id);
    else this.values.set(id, liveValue);
    this.cached = undefined;
  }
  forgetControl(canvasId: string, widgetId: string) { this.controls.delete(widgetKey(canvasId, widgetId)); this.cached = undefined; }
  definition(id: string) {
    const variable = this.workspace().variables?.find(v => v.id === id);
    if (!variable) throw new Error('工作区变量不存在');
    return variable;
  }
  read(id: string) { return this.values.get(id) ?? this.definition(id).initial; }
  write(id: string, input: SignalValue | bigint, changes: readonly string[] = []) {
    const variable = this.definition(id);
    const value = typeof input === 'bigint' ? Number(input) : input;
    if (typeof input === 'bigint' && !Number.isSafeInteger(value)) throw new Error('该整数超出工作区数值变量的精确范围');
    if (typeof value !== variable.type || !signalValueSchema.safeParse(value).success) throw new Error(`工作区变量「${variable.name}」的值类型不匹配或超出范围`);
    if (this.read(id) === value) return;
    if (changes.includes(id)) throw new Error(`工作区变量「${variable.name}」发生循环更新`);
    this.values.set(id, value); this.cached = undefined;
    this.dispatch({ binding: { kind: 'workspace', variableId: id }, label: variable.name, value, changes: [...changes, id] });
  }
  interact(command: Extract<Command, { type: 'canvas.interact' }>) {
    if (command.epoch !== this.epoch) throw new Error('工作区已切换，请重新操作');
    const duplicate = this.actions.get(command.actionId);
    if (duplicate !== undefined) return duplicate;
    const { canvasId, widgetId, event } = command;
    const binding = { kind: 'widget' as const, canvasId, widgetId, event };
    const workspace = this.workspace();
    checkInputBinding(workspace, binding);
    const canvas = workspace.canvases!.find(c => c.id === canvasId)!;
    if (canvas.revision !== command.revision) throw new Error('画布已更新，请重新操作');
    const widget = canvas.widgets.find(w => w.id === widgetId)!;
    const key = widgetKey(canvasId, widgetId);
    const variableId = widget.binding && 'variableId' in widget.binding ? widget.binding.variableId : undefined;
    let value: SignalValue = event === 'click' || event === 'press';
    if (event === 'change') value = !(variableId ? this.read(variableId) : this.controls.get(key));
    if (event === 'submit') {
      const type = widget.inputMode === 'text' ? 'string' : widget.inputMode === 'select' ? 'boolean' : 'number';
      if (command.value === undefined || typeof command.value !== type) throw new Error('提交值与输入控件类型不一致');
      value = command.value;
      if (typeof value === 'number' && (widget.limitInput || widget.inputMode === 'slider') && (value < widget.min || value > widget.max))
        throw new Error(`输入须在 ${widget.min}–${widget.max} 之间`);
    }
    if (event === 'change' || event === 'submit') {
      if (variableId) this.write(variableId, value);
      else { this.controls.set(key, value); this.cached = undefined; }
    }
    const delivered = this.dispatch({ binding, value, label: `${canvas.name} / ${widget.label || widget.text} · ${widgetEventLabels[event]}` });
    this.actions.set(command.actionId, delivered);
    if (this.actions.size > 2048) this.actions.delete(this.actions.keys().next().value!);
    return delivered;
  }
}
