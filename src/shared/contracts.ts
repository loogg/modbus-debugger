import type { ModbusResponse } from '../domain/protocol';

/** Types exchanged across the Main / Preload / Renderer boundary. */
export type ResultKind =
  | 'ok'
  | 'exception'
  | 'unexpected'
  | 'timeout'
  | 'crc'
  | 'malformed'
  | 'transport';

export type SourceKind = 'poll' | 'write' | 'readback' | 'temporary-read' | 'scanner' | 'rmw-read' | 'rmw-write';

export interface TransactionRecord {
  traceId: string;
  connectionId: string;
  unitId: number;
  functionCode: number;
  sourceKind: SourceKind;
  sourceId: string | null;
  startUtc: string;
  startMono: number;
  durationMs: number | null;
  requestAduHex: string;
  responseAduHex: string | null;
  /** PDU bytes only: no RTU unit/CRC or TCP MBAP header. Live transactions always set these. */
  requestPduHex?: string;
  responsePduHex?: string | null;
  result: ResultKind;
  exceptionCode: number | null;
  mbapTransactionId: number | null;
  summary: string;
}

export interface ParseEventRecord {
  id: string;
  connectionId: string;
  kind: 'crc' | 'malformed' | 'unexpected' | 'truncated' | 'overflow';
  reason: string;
  rawHex: string;
  discarded: number;
  recoveredCount: number;
  traceId: string | null;
  /** Request context is null for unsolicited data with no identifiable owner. */
  unitId: number | null;
  functionCode: number | null;
  sourceKind: SourceKind | null;
  utc: string;
  mono: number;
}

export interface BlockHealth {
  slaveId: string;
  blockId: string;
  blockName: string;
  configuredPeriodMs: number;
  actualPeriodMs: number | null;
  p95Ms: number | null;
  timeoutRate: number;
}

export interface HealthSample {
  /** epoch ms */
  t: number;
  busLoadPercent: number;
  p95Ms: number;
  requestRatePerSec: number;
}

export interface ConnectionHealth {
  connectionId: string;
  busLoadPercent: number;
  requestRatePerSec: number;
  p50Ms: number;
  p95Ms: number;
  timeouts: number;
  crcErrors: number;
  exceptions: number;
  unexpected: number;
  windowSec: number;
  blocks: BlockHealth[];
}

export interface Prefs {
  window: { x: number | null; y: number | null; width: number; height: number };
  sidebarWidth: number;
  historyDbPath: string | null;
  persistRawComm: boolean;
  lastWorkspacePath: string | null;
  /** 'local' follows the OS; otherwise an IANA name applied to every displayed timestamp. */
  timezone: string;
  /** BCP-47 language tag for the UI; only zh-CN is wired today. */
  language: string;
}

export interface SessionSummary {
  slaveNames?: string[];
  id: string;
  groupId: string;
  groupName: string;
  startUtc: string;
  endUtc: string | null;
  status: 'recording' | 'completed';
  signalCount: number;
  sampleCount: number;
  eventCount: number;
  sizeBytes: number;
}

export interface RequestOutcome {
  result: ResultKind;
  response: ModbusResponse | null;
  exceptionCode: number | null;
  durationMs: number;
  requestAduHex: string;
  responseAduHex: string | null;
  traceId: string;
}
