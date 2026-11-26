import type { ReadRange } from '../../domain/point-access';

export type RuntimeChange =
  | { kind: 'sample'; blockKey: string; range: ReadRange }
  | { kind: 'variable'; name: string }
  | { kind: 'timer'; channel: number; elapsed?: boolean; phases?: readonly number[] }
  | { kind: 'slaveState'; slaveId: string };

function matches(source: RuntimeChange, change: RuntimeChange): boolean {
  if (source.kind === 'variable') return change.kind === 'variable' && source.name === change.name;
  if (source.kind === 'timer') return change.kind === 'timer' && source.channel === change.channel;
  if (source.kind === 'slaveState') return change.kind === 'slaveState' && change.slaveId === source.slaveId;
  return change.kind === 'sample' && source.blockKey === change.blockKey
    && source.range.offset >= change.range.offset
    && source.range.offset + source.range.length <= change.range.offset + change.range.length;
}

export class RuntimeNotifications {
  private readonly listeners = new Set<(change: RuntimeChange) => void>();
  constructor(private readonly equipment?: RuntimeNotifications) {}

  subscribe(sources: readonly RuntimeChange[], notify: (change: RuntimeChange) => void): () => void {
    const listener = (change: RuntimeChange) => {
      if (sources.some(source => matches(source, change))) notify(change);
    };
    this.listeners.add(listener);
    const hardware = sources.filter(source => source.kind === 'sample' || source.kind === 'slaveState');
    const detach = hardware.length ? this.equipment?.subscribe(hardware, notify) : undefined;
    return () => { this.listeners.delete(listener); detach?.(); };
  }

  publish(change: RuntimeChange): void {
    if (!this.listeners.size) return;
    for (const listener of [...this.listeners]) {
      if (this.listeners.has(listener)) listener(change);
    }
  }
}
