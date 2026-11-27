import type { EventBinding, ScriptInputEvent, SignalValue, SlaveEventState } from '../../domain/canvas-script';
import type { SlaveCommunicationState } from '../../shared/snapshot';
import type { ScriptPointBinding } from './master-script-runner';
import type { RuntimeNotifications } from './runtime-notifications';

export type ObserveEquipment = (receive: (event: ScriptInputEvent) => void) => () => void;

export function observeSlaveState(binding: Extract<EventBinding, { kind: 'slaveState' }>,
  slave: { label: string; state(): SlaveCommunicationState }, notifications: RuntimeNotifications): ObserveEquipment {
  return receive => {
    let observed = slave.state();
    let stable: SlaveEventState | undefined = observed === 'online' || observed === 'offline' ? observed : undefined;
    return notifications.subscribe([{ kind: 'slaveState', slaveId: binding.slaveId }], () => {
      const next = slave.state();
      if (next === observed) return;
      const previous = stable ?? observed;
      observed = next;
      if (next === 'disabled') { stable = undefined; return; }
      if ((next !== 'online' && next !== 'offline') || next === stable) return;
      stable = next;
      if (next === binding.state) receive({ binding, previous, value: next, label: `${slave.label} · ${next === 'online' ? '上线' : '离线'}` });
    });
  };
}

export function observePoint(binding: Extract<EventBinding, { kind: 'point' }>, point: ScriptPointBinding,
  state: () => SlaveCommunicationState, notifications: RuntimeNotifications): ObserveEquipment {
  return receive => {
    let baseline: SignalValue | undefined;
    return notifications.subscribe([
      { kind: 'sample', blockKey: point.blockKey, range: point.span },
      { kind: 'slaveState', slaveId: binding.slaveId },
    ], change => {
      if (change.kind === 'slaveState') {
        if (state() !== 'online') baseline = undefined;
        return;
      }
      if (change.kind !== 'sample' || change.origin !== 'read') return;
      if (state() !== 'online') { baseline = undefined; return; }
      const previous = baseline;
      const value = point.read().value;
      baseline = typeof value === 'number' && !Number.isFinite(value) ? undefined : value;
      if (previous !== undefined && baseline !== undefined && previous !== baseline) {
        receive({ binding, previous, value: baseline, label: `${point.label} · 确认值改变` });
      }
    });
  };
}
