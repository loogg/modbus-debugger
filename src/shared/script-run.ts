import type { EventBinding, SignalValue } from '../domain/canvas-script';

export interface ScriptApprovalView {
  key: string;
  writes: Array<{ target: string; value: string }>;
}

export type ScriptEventSource = 'on_start' | 'on_run' | `T${number}` | `input:${string}`;
export interface ScriptEventStatus {
  inputs?: EventBinding[];
  onRun: { periodMs: number; enabled: boolean; calls: number } | null;
  timers: { channel: number; periodMs: number; remaining: number | null }[];
}

export interface ScriptRunEntry {
  trigger?: { binding: EventBinding; label: string; transition?: { previous: SignalValue; value: SignalValue } };
  source?: ScriptEventSource;
  sequence?: number;
  atMs: number;
  log?: boolean;
  blockId: string;
  label: string;
  result: 'ok' | 'failed' | 'stopped';
  detail: string;
  handled?: boolean;
}

export interface ScriptJudgment {
  matched: boolean | null;
  detail: string;
  evaluatedAtMs: number;
  samples: { label: string; timeMs: number }[];
}

export interface ScriptVariableScope {
  source?: ScriptEventSource;
  functionId: string | null;
  inCall: boolean;
  values: { name: string; value: number | string | boolean; kind?: 'integer64' }[];
}

export interface ScriptRunView {
  id: string;
  scriptId: string;
  scriptName: string;
  scriptRevision: number;
  // Captured at startup. Saving a new limit applies to the next run.
  callbackTimeoutMs: number;
  /** Identifies the compiled steps across edits to names, breakpoints and canvas positions. */
  programHash: string;
  judgments: Record<string, ScriptJudgment>;
  variableScopes: ScriptVariableScope[];
  events?: ScriptEventStatus;
  pendingWrite: { token: string; target: string; value: string } | null;
  state: 'running' | 'waiting' | 'pausing' | 'paused' | 'stopping' | 'passed' | 'failed' | 'stopped';
  breakpoints: string[];
  statementIds: string[];
  pause: {
    token: string;
    reason: 'entry' | 'breakpoint' | 'step' | 'pause';
    writePreview?: string;
    writeError?: string;
    variables: { name: string; value: string }[];
  } | null;
  startedAtMs: number;
  finishedAtMs: number | null;
  current: { blockId: string; label: string; source?: ScriptEventSource; triggerLabel?: string } | null;
  entries: ScriptRunEntry[];
  eventLog?: ScriptRunEntry[];
  completed: number;
  detail: string | null;
}

export function scriptIsActive(run: ScriptRunView | null | undefined): boolean {
  return !!run && ['running', 'waiting', 'pausing', 'paused', 'stopping'].includes(run.state);
}

export function scriptRunFor(snapshot: { scriptRuns?: Record<string, ScriptRunView>; scriptRun?: ScriptRunView | null } | null, id: string): ScriptRunView | null {
  if (snapshot?.scriptRuns) return Object.hasOwn(snapshot.scriptRuns, id) ? snapshot.scriptRuns[id]! : null;
  return snapshot?.scriptRun?.scriptId === id ? snapshot.scriptRun : null;
}
