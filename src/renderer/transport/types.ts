import type { AppApi } from '../../shared/preload-api';

export type TransportType = 'electron' | 'bridge' | 'mock';
export type TransportStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface TransportState {
  type: TransportType;
  status: TransportStatus;
  message?: string;
  fixture?: string;
}

export interface AppTransport extends AppApi {
  readonly transportType: TransportType;
  getStatus(): TransportState;
  onStatusChange(cb: (state: TransportState) => void): () => void;
  dispose?(): void;
}
