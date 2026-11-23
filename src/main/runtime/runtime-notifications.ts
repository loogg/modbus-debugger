import type { ReadRange } from '../../domain/point-access';

export type RuntimeChange =
  | { kind: 'sample'; blockKey: string; range: ReadRange }
  | { kind: 'slaveState'; slaveId: string };

function matches(source: RuntimeChange, change: RuntimeChange): boolean {
  if (source.kind === 'slaveState') return change.kind === 'slaveState' && change.slaveId === source.slaveId;
  return change.kind === 'sample' && source.blockKey === change.blockKey
    && source.range.offset >= change.range.offset
    && source.range.offset + source.range.length <= change.range.offset + change.range.length;
}

export class RuntimeNotifications {
  private readonly listeners = new Set<(change: RuntimeChange) => void>();

  subscribe(sources: readonly RuntimeChange[], notify: (change: RuntimeChange) => void): () => void {
    const listener = (change: RuntimeChange) => {
      if (sources.some(source => matches(source, change))) notify(change);
    };
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  publish(change: RuntimeChange): void {
    if (!this.listeners.size) return;
    for (const listener of [...this.listeners]) {
      if (this.listeners.has(listener)) listener(change);
    }
  }
}
