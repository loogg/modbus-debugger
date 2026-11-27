import { checkCallbackContexts, type MasterScript } from '../../domain/master-script';
import type { ScriptInputEvent } from '../../domain/canvas-script';
import { compileScriptLua } from '../../domain/script-lua-program';
import type { ScriptRunView } from '../../shared/script-run';
import type { MasterScriptRunner } from './master-script-runner';

// Main owns one live handle per script. A restarted script always gets a fresh run ID.
export class ScriptRuns {
  epoch = 0;
  private readonly handles = new Map<string, MasterScriptRunner>();
  private readonly byId = new Map<string, MasterScriptRunner>();
  private readonly draining = new Set<Promise<void>>();
  private latest?: MasterScriptRunner;
  private sent = new Map<string, ScriptRunView>();

  constructor(private readonly create: () => MasterScriptRunner) {}

  get lastRun() { return this.latest?.snapshot ?? null; }
  forScript(id: string) { return this.handles.get(id); }
  forRun(id: string) { return this.byId.get(id); }
  plan(script: MasterScript) {
    const artifact = compileScriptLua(script.graph);
    checkCallbackContexts(artifact.program);
    return (this.forScript(script.id) ?? this.create()).prepare(script, artifact).approval;
  }
  start(script: MasterScript, approval?: string, debug?: boolean) {
    const artifact = compileScriptLua(script.graph);
    checkCallbackContexts(artifact.program);
    const handle = this.forScript(script.id) ?? this.create();
    const previous = handle.snapshot;
    const plan = handle.prepare(script, artifact);
    this.handles.set(script.id, handle);
    let view: ScriptRunView;
    try { view = handle.start(plan, approval, debug); }
    catch (error) { if (!previous) this.handles.delete(script.id); throw error; }
    if (previous) this.byId.delete(previous.id);
    this.handles.delete(script.id);
    this.handles.set(script.id, handle);
    this.byId.set(view.id, handle);
    this.latest = handle;
    return view;
  }
  snapshots(): Record<string, ScriptRunView> {
    return Object.fromEntries(Array.from(this.handles, ([id, handle]) => [id, handle.snapshot!]));
  }
  dispatch(event: ScriptInputEvent, pressId?: string) {
    let count = 0;
    for (const handle of this.handles.values()) if (handle.receive(event, pressId)) count++;
    return count;
  }
  recheckInputs() { for (const handle of this.handles.values()) handle.recheckInputs(); }
  delta(): Record<string, ScriptRunView | null> | undefined {
    const changes: [string, ScriptRunView | null][] = [];
    for (const [id, handle] of this.handles) {
      const view = handle.snapshot!;
      if (this.sent.get(id) !== view) { changes.push([id, view]); this.sent.set(id, view); }
    }
    for (const id of this.sent.keys()) if (!this.handles.has(id)) { changes.push([id, null]); this.sent.delete(id); }
    return changes.length ? Object.fromEntries(changes) : undefined;
  }
  remove(id: string) {
    const handle = this.handles.get(id);
    if (!handle) return;
    handle.stop();
    const finished = handle.settle();
    this.draining.add(finished);
    void finished.finally(() => this.draining.delete(finished));
    this.handles.delete(id);
    if (this.latest === handle) this.latest = [...this.handles.values()].at(-1);
    const view = handle.snapshot!;
    this.byId.delete(view.id);
    // A new window can read this run in a full snapshot before its first delta.
    this.sent.set(id, view);
  }
  stopAll() { this.epoch++; for (const handle of this.handles.values()) handle.stop(); }
  clear() { this.epoch++; this.latest = undefined; for (const id of this.handles.keys()) this.remove(id); }
  async settle() { await Promise.all([...this.draining, ...Array.from(this.handles.values(), handle => handle.settle())]); }
}
