import { ExceptionCode } from '../../../domain/protocol/types';
import type { BlockViewState, SlaveCommunicationState } from '../../../shared/snapshot';
import { slaveStatus, type StatusTone } from '../../components/ui';
import { i18n } from '../../i18n';

const readExceptionKeys: Partial<Record<number, keyof typeof import('../../i18n/locales/zh-CN/devices').devices>> = {
  [ExceptionCode.IllegalFunction]: 'tempIllegalFunction',
  [ExceptionCode.IllegalDataAddress]: 'tempIllegalAddress',
  [ExceptionCode.IllegalDataValue]: 'tempIllegalValue',
  [ExceptionCode.SlaveDeviceFailure]: 'tempDeviceFailure',
  [ExceptionCode.SlaveDeviceBusy]: 'tempDeviceBusy',
  [ExceptionCode.GatewayPathUnavailable]: 'tempGatewayPath',
  [ExceptionCode.GatewayTargetFailed]: 'tempGatewayTarget',
};

export function readExceptionReason(code: number | null): string {
  return i18n.t(`devices.${readExceptionKeys[code ?? -1] ?? 'tempUnknownException'}`);
}

export function blockReadIssue(
  device: SlaveCommunicationState,
  block?: BlockViewState,
): { tone: StatusTone; label: string; title?: string } | null {
  if (device === 'offline' || device === 'disabled' || device === 'connecting') return slaveStatus(device);
  if (device === 'pending' && block?.status === 'ok') return slaveStatus(device);
  switch (block?.status) {
    case 'disabled': return slaveStatus('disabled');
    case 'timeout': return { tone: 'warn', label: i18n.t('ui.readStatus.timeout') };
    case 'transport-error': return { tone: 'err', label: i18n.t('ui.readStatus.transport') };
    case 'exception': {
      const code = block.exceptionCode;
      const failure = i18n.t('ui.readStatus.exception');
      const label = code === null ? failure : `${failure} 0x${code.toString(16).toUpperCase().padStart(2, '0')}`;
      return { tone: 'err', label, title: readExceptionReason(code) };
    }
    default: return null;
  }
}
