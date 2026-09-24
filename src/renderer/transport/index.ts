import type { ModbusApi } from '../../shared/preload-api';
import type { AppTransport } from './types';
import { ElectronTransport } from './electron';
import { WebSocketBridgeTransport } from './bridge';
import { MockTransport, type MockFixtureName } from './mock';

export * from './types';
export * from './electron';
export * from './bridge';
export * from './mock';

export function resolveAppTransport(customUrl?: string): AppTransport {
  const url = customUrl
    ? new URL(customUrl, 'http://localhost:5173')
    : typeof window !== 'undefined'
      ? new URL(window.location.href)
      : null;
  const transportParam = url?.searchParams.get('transport')?.toLowerCase();
  const fixtureParam = (url?.searchParams.get('fixture')?.toLowerCase() ?? 'default') as MockFixtureName;
  const bridgeUrlParam = url?.searchParams.get('bridgeUrl') ?? undefined;

  // 1. Explicit mock
  if (transportParam === 'mock') {
    return new MockTransport(fixtureParam);
  }

  // 2. Explicit bridge
  if (transportParam === 'bridge') {
    return new WebSocketBridgeTransport({ url: bridgeUrlParam });
  }

  // 3. Electron native preload if present
  const electronApi = typeof window !== 'undefined' ? (window as unknown as { modbus?: ModbusApi }).modbus : undefined;
  if (electronApi && transportParam !== 'browser') {
    return new ElectronTransport(electronApi);
  }

  // 4. Default in browser without preload: auto-connect to Dev Bridge
  return new WebSocketBridgeTransport({ url: bridgeUrlParam });
}
