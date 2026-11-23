import fs from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';
import type { Workspace } from '../src/domain/model';
import type { EventRow, RawCommRow, SampleRow, SessionSignalSchema, TransactionMetadataRow } from '../src/main/services/history';

export interface LegacyHistorySession {
  id: string;
  groupId: string;
  groupName: string;
  schema: SessionSignalSchema[];
  startUtc?: string;
  endUtc?: string | null;
  status?: 'recording' | 'completed';
  samples?: Iterable<SampleRow>;
  events?: Iterable<EventRow>;
  rawComm?: Iterable<Pick<RawCommRow, 'tMs' | 'direction' | 'hex'> & Partial<RawCommRow>>;
  transactions?: Iterable<TransactionMetadataRow>;
}

/** Build an old-format database for development and read-only history regression. */
export async function writeLegacyHistoryFixture(file: string, sessions: LegacyHistorySession[]): Promise<void> {
  const root = path.resolve(__dirname, '../out/test-temp');
  const relative = path.relative(root, path.resolve(file));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('History fixtures must be inside out/test-temp');
  const wasm = fs.readFileSync(path.resolve(__dirname, '../node_modules/sql.js/dist/sql-wasm.wasm'));
  const SQL = await initSqlJs({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) });
  const db = new SQL.Database();
  try {
    db.run(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, group_name TEXT NOT NULL,
        start_utc TEXT NOT NULL, end_utc TEXT, status TEXT NOT NULL, schema_json TEXT NOT NULL,
        sample_count INTEGER NOT NULL DEFAULT 0, event_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE samples (session_id TEXT NOT NULL, signal_id TEXT NOT NULL, t_ms INTEGER NOT NULL, value REAL NOT NULL);
      CREATE TABLE events (session_id TEXT NOT NULL, signal_id TEXT NOT NULL, t_ms INTEGER NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE raw_comm (session_id TEXT NOT NULL, t_ms INTEGER NOT NULL, direction TEXT NOT NULL, hex TEXT NOT NULL, pdu_hex TEXT, trace_id TEXT);
      CREATE TABLE transaction_meta (session_id TEXT NOT NULL, trace_id TEXT NOT NULL, connection_id TEXT NOT NULL,
        slave_id TEXT, unit_id INTEGER NOT NULL, source_kind TEXT NOT NULL, source_id TEXT, function_code INTEGER NOT NULL,
        result TEXT NOT NULL, t_ms INTEGER NOT NULL, start_utc TEXT NOT NULL, duration_ms REAL, exception_code INTEGER,
        mbap_transaction_id INTEGER, summary TEXT NOT NULL, PRIMARY KEY (session_id, trace_id));
      CREATE INDEX idx_samples ON samples(session_id, signal_id, t_ms);
      CREATE INDEX idx_events ON events(session_id, t_ms);
      CREATE INDEX idx_raw_comm ON raw_comm(session_id, t_ms);
      CREATE INDEX idx_transaction_meta_time ON transaction_meta(session_id, t_ms);
    `);
    for (const session of sessions) {
      const status = session.status ?? 'completed';
      let endUtc = session.endUtc ?? null;
      if (session.endUtc === undefined && status === 'completed') endUtc = '2026-11-01T00:00:02.000Z';
      db.run('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)', [session.id, session.groupId, session.groupName,
        session.startUtc ?? '2026-11-01T00:00:00.000Z', endUtc,
        status, JSON.stringify(session.schema)]);
      db.run('BEGIN');
      let sampleCount = 0;
      let eventCount = 0;
      const samples = db.prepare('INSERT INTO samples VALUES (?, ?, ?, ?)');
      const events = db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?)');
      const raw = db.prepare('INSERT INTO raw_comm VALUES (?, ?, ?, ?, ?, ?)');
      const transactions = db.prepare('INSERT INTO transaction_meta VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      try {
        for (const row of session.samples ?? []) { samples.run([session.id, row.signalId, row.tMs, row.value]); sampleCount++; }
        for (const row of session.events ?? []) { events.run([session.id, row.signalId, row.tMs, row.kind, row.value]); eventCount++; }
        for (const row of session.rawComm ?? []) raw.run([session.id, row.tMs, row.direction, row.hex, row.pduHex ?? null, row.traceId ?? null]);
        for (const row of session.transactions ?? []) transactions.run([session.id, row.traceId, row.connectionId, row.slaveId,
          row.unitId, row.sourceKind, row.sourceId, row.functionCode, row.result, row.tMs, row.startUtc, row.durationMs,
          row.exceptionCode, row.mbapTransactionId, row.summary]);
        db.run('UPDATE sessions SET sample_count=?, event_count=? WHERE id=?', [sampleCount, eventCount, session.id]);
        db.run('COMMIT');
      } finally { samples.free(); events.free(); raw.free(); transactions.free(); }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(db.export()));
  } finally { db.close(); }
}

export function legacySessionsForWorkspace(workspace: Workspace): LegacyHistorySession[] {
  return workspace.trendGroups.filter(group => group.signals.length > 0).map((group, index) => {
    const schema = group.signals.flatMap(signal => {
      const slave = workspace.slaves.find(item => item.id === signal.pointRef.slaveId);
      const template = workspace.templates.find(item => item.id === slave?.templateId);
      const point = template?.points.find(item => item.id === signal.pointRef.pointId);
      if (!slave || !point) return [];
      return [{ signalId: signal.id, slaveId: slave.id, pointId: point.id, pointName: point.name,
        connectionName: workspace.connections.find(item => item.id === slave.connectionId)?.name ?? '', slaveName: slave.name,
        blockName: template?.blocks.find(item => item.id === point.blockId)?.name ?? '', rawType: point.mapping.rawType,
        unit: point.unit, scale: point.scale, offset: point.offset, decimalPlaces: point.decimalPlaces, enumMap: point.enumMap,
        recordMode: (['Bool', 'String'].includes(point.mapping.rawType) || Object.keys(point.enumMap).length ? 'events' : 'samples') as 'events' | 'samples' }];
    });
    const samples: SampleRow[] = [];
    const events: EventRow[] = [];
    for (const signal of schema) {
      if (signal.recordMode === 'samples') {
        const values = signal.rawType === 'Float64' ? [1.234567890123, 2.345678901234] : signal.rawType === 'Float32' ? [12.25, 15.25] : [1500, 1600];
        values.forEach((value, i) => samples.push({ signalId: signal.signalId, tMs: i * 1000, value }));
      } else {
        const kind = signal.rawType === 'Bool' ? 'bool' : signal.rawType === 'String' ? 'string' : 'enum';
        const values = kind === 'bool' ? ['false', 'true'] : kind === 'string' ? ['V1.0', '历史🙂'] : Object.values(signal.enumMap).slice(0, 2);
        values.forEach((value, i) => events.push({ signalId: signal.signalId, tMs: i * 1000, kind, value }));
      }
    }
    return { id: `legacy-${group.id}`, groupId: group.id, groupName: group.name, schema, samples, events,
      startUtc: new Date(Date.UTC(2026, 10, 1, 0, index)).toISOString(), endUtc: new Date(Date.UTC(2026, 10, 1, 0, index, 2)).toISOString(),
      rawComm: [{ tMs: 0, direction: 'tx', hex: '000100000006010300000001', pduHex: '0300000001', traceId: 'legacy-t1' },
        { tMs: 1, direction: 'rx', hex: '00010000000501030205dc', pduHex: '030205dc', traceId: 'legacy-t1' }] };
  });
}
