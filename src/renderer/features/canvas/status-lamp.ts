import { lampConfigSchema, type LampConfig, type LampValue } from '../../../domain/canvas-lamp';
import type { SlaveCommunicationState } from '../../../shared/snapshot';
import { slaveStatus } from '../../components/ui';

const states: Record<SlaveCommunicationState, { value: number; color: string }> = {
  online: { value: 1, color: '#178A4D' },
  offline: { value: 0, color: '#C42B1C' },
  pending: { value: 2, color: '#94A3B8' },
  connecting: { value: 3, color: '#C76C00' },
  disabled: { value: 4, color: '#62666F' },
};

export function statusLampOptions() {
  return (Object.keys(states) as SlaveCommunicationState[]).map(state => ({
    id: state, value: String(states[state].value), color: states[state].color, label: slaveStatus(state).label,
  }));
}

export function statusLampConfig(): LampConfig {
  return lampConfigSchema.parse({
    mode: 'states',
    rules: statusLampOptions().map(option => ({ ...option, value: Number(option.value) })),
    on: { label: slaveStatus('online').label, color: states.online.color },
    off: { label: slaveStatus('offline').label, color: states.offline.color },
  });
}

export function statusLampValue(state: SlaveCommunicationState, mode: LampConfig['mode']): LampValue {
  const value = states[state].value;
  return { hasValue: true, boolValue: mode === 'binary' ? state === 'online' : null, rawNumber: value, engNumber: value };
}
