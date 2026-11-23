export interface ScriptApprovalView {
  key: string;
  writes: Array<{ target: string; value: string }>;
}

export interface ScriptRunEntry {
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

export interface ScriptRunView {
  id: string;
  scriptId: string;
  scriptName: string;
  scriptRevision: number;
  judgments: Record<string, ScriptJudgment>;
  pendingWrite: { token: string; target: string; value: string } | null;
  state: 'running' | 'pausing' | 'paused' | 'stopping' | 'passed' | 'failed' | 'stopped';
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
  current: { blockId: string; label: string } | null;
  entries: ScriptRunEntry[];
  completed: number;
  detail: string | null;
}

export function scriptIsActive(run: ScriptRunView | null | undefined): boolean {
  return !!run && ['running', 'pausing', 'paused', 'stopping'].includes(run.state);
}
