import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import initSqlJs, { type Database } from 'sql.js';
import type { ResultKind, SessionSummary, SourceKind, TransactionRecord } from '../../shared/contracts';

export type { SessionSummary } from '../../shared/contracts';

export interface SessionSignalSchema {
  slaveId?: string;
  signalId: string;
  pointId: string;
  pointName: string;
  connectionName: string;
  slaveName: string;
  blockName: string;
  rawType: string;
  unit: string;
  scale: number;
  offset: number;
  decimalPlaces?: number;
  enumMap: Record<string, string>;
  recordMode: 'samples' | 'events';
}

export interface SessionDetail extends SessionSummary {
  schema: SessionSignalSchema[];
}

export interface SampleRow {
  signalId: string;
  tMs: number;
  value: number;
}
export interface EventRow {
  signalId: string;
  tMs: number;
  kind: 'bool' | 'enum' | 'string' | 'write' | 'marker' | 'connection';
  value: string;
}

/** Session-scoped diagnostics without frame bytes; retained even when Raw Communication is off. */
export interface TransactionMetadataRow {
  traceId: string;
  connectionId: string;
  slaveId: string | null;
  unitId: number;
  sourceKind: SourceKind;
  sourceId: string | null;
  functionCode: number;
  result: ResultKind;
  tMs: number;
  startUtc: string;
  durationMs: number | null;
  exceptionCode: number | null;
  mbapTransactionId: number | null;
  summary: string;
}

export interface RawCommRow {
  tMs: number;
  direction: string;
  hex: string;
  pduHex: string | null;
  traceId: string | null;
}

type RawFrames = Pick<TransactionRecord, 'requestAduHex' | 'responseAduHex' | 'requestPduHex' | 'responsePduHex'>;

const TEN_GB = 10 * 1024 * 1024 * 1024;

/**
 * History storage backed by sql.js (SQLite compiled to WASM): no native binary, no
 * ABI sensitivity, identical behaviour on every machine. The on-disk file is a
 * standard SQLite database (sql.js export), so external tools can still open it.
 */
export class HistoryStore {
  private flushTimer: NodeJS.Timeout | null = null;
  private closed = false;

  private constructor(
    private readonly db: Database,
    readonly dbPath: string,
  ) {}

  static async open(dbPath: string): Promise<HistoryStore> {
    // sql.js is a webpack external in main, plain source in tests: probe the layouts.
    const req = createRequire(typeof __filename !== 'undefined' ? __filename : import.meta.url);
    const candidates = [
      path.join(path.dirname(req.resolve('sql.js')), 'sql-wasm.wasm'),
      path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
      path.join(__dirname, '..', '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
      path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
    ];
    const wasmPath = candidates.find((c) => fs.existsSync(c));
    if (!wasmPath) throw new Error('sql-wasm.wasm not found in any known layout');
    const wasm = fs.readFileSync(wasmPath);
    const SQL = await initSqlJs({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) });
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = fs.existsSync(dbPath) ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database();
    db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        group_name TEXT NOT NULL,
        start_utc TEXT NOT NULL,
        end_utc TEXT,
        status TEXT NOT NULL,
        schema_json TEXT NOT NULL,
        sample_count INTEGER NOT NULL DEFAULT 0,
        event_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS samples (
        session_id TEXT NOT NULL,
        signal_id TEXT NOT NULL,
        t_ms INTEGER NOT NULL,
        value REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL,
        signal_id TEXT NOT NULL,
        t_ms INTEGER NOT NULL,
        kind TEXT NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS raw_comm (
        session_id TEXT NOT NULL,
        t_ms INTEGER NOT NULL,
        direction TEXT NOT NULL,
        hex TEXT NOT NULL,
        pdu_hex TEXT,
        trace_id TEXT
      );
      CREATE TABLE IF NOT EXISTS transaction_meta (
        session_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        slave_id TEXT,
        unit_id INTEGER NOT NULL,
        source_kind TEXT NOT NULL,
        source_id TEXT,
        function_code INTEGER NOT NULL,
        result TEXT NOT NULL,
        t_ms INTEGER NOT NULL,
        start_utc TEXT NOT NULL,
        duration_ms REAL,
        exception_code INTEGER,
        mbap_transaction_id INTEGER,
        summary TEXT NOT NULL,
        PRIMARY KEY (session_id, trace_id)
      );
      CREATE INDEX IF NOT EXISTS idx_samples ON samples(session_id, signal_id, t_ms);
      CREATE INDEX IF NOT EXISTS idx_events ON events(session_id, t_ms);
      CREATE INDEX IF NOT EXISTS idx_raw_comm ON raw_comm(session_id, t_ms);
      CREATE INDEX IF NOT EXISTS idx_transaction_meta_time ON transaction_meta(session_id, t_ms);
    `);
    // Older history.db files already have raw_comm without these two columns.
    const rawColumns = new Set((db.exec('PRAGMA table_info(raw_comm)')[0]?.values ?? []).map(row => row[1]));
    if (!rawColumns.has('pdu_hex')) db.run('ALTER TABLE raw_comm ADD COLUMN pdu_hex TEXT');
    if (!rawColumns.has('trace_id')) db.run('ALTER TABLE raw_comm ADD COLUMN trace_id TEXT');
    return new HistoryStore(db, dbPath);
  }

  /* ---------------- persistence ---------------- */

  private scheduleFlush(): void {
    if (this.flushTimer || this.closed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 1000);
  }

  /** Atomic write: temp file + rename, same guarantee as the workspace file. */
  flush(): void {
    if (this.closed) return;
    const bytes = Buffer.from(this.db.export());
    const tmp = `${this.dbPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, this.dbPath);
  }

  sizeBytes(): number {
    try {
      return fs.statSync(this.dbPath).size;
    } catch {
      return this.db.export().length;
    }
  }

  overTenGb(): boolean {
    return this.sizeBytes() > TEN_GB;
  }

  close(): void {
    if (this.closed) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
    this.db.close();
    this.closed = true;
  }

  /* ---------------- sessions ---------------- */

  createSession(id: string, groupId: string, groupName: string, schema: SessionSignalSchema[]): void {
    this.db.run('INSERT INTO sessions (id, group_id, group_name, start_utc, status, schema_json) VALUES (?, ?, ?, ?, ?, ?)', [
      id,
      groupId,
      groupName,
      new Date().toISOString(),
      'recording',
      JSON.stringify(schema),
    ]);
    this.scheduleFlush();
  }

  endSession(id: string): void {
    this.db.run("UPDATE sessions SET status='completed', end_utc=? WHERE id=?", [new Date().toISOString(), id]);
    this.scheduleFlush();
  }

  insertSamples(sessionId: string, rows: SampleRow[]): void {
    if (!rows.length) return;
    this.db.run('BEGIN');
    for (const r of rows) this.db.run('INSERT INTO samples (session_id, signal_id, t_ms, value) VALUES (?, ?, ?, ?)', [sessionId, r.signalId, r.tMs, r.value]);
    this.db.run('UPDATE sessions SET sample_count = sample_count + ? WHERE id = ?', [rows.length, sessionId]);
    this.db.run('COMMIT');
    this.scheduleFlush();
  }

  insertEvents(sessionId: string, rows: EventRow[]): void {
    if (!rows.length) return;
    this.db.run('BEGIN');
    for (const r of rows) this.db.run('INSERT INTO events (session_id, signal_id, t_ms, kind, value) VALUES (?, ?, ?, ?, ?)', [sessionId, r.signalId, r.tMs, r.kind, r.value]);
    this.db.run('UPDATE sessions SET event_count = event_count + ? WHERE id = ?', [rows.length, sessionId]);
    this.db.run('COMMIT');
    this.scheduleFlush();
  }

  insertRawComm(sessionId: string, tMs: number, direction: string, hex: string, pduHex: string | null = null, traceId: string | null = null): void {
    this.db.run('INSERT INTO raw_comm (session_id, t_ms, direction, hex, pdu_hex, trace_id) VALUES (?, ?, ?, ?, ?, ?)', [sessionId, tMs, direction, hex, pduHex, traceId]);
    this.scheduleFlush();
  }

  /** Metadata and optional Raw frames commit together, so a retry cannot duplicate a frame. */
  insertTransaction(sessionId: string, row: TransactionMetadataRow, raw: RawFrames | null): void {
    this.db.run('BEGIN');
    try {
      this.db.run(`INSERT OR IGNORE INTO transaction_meta
        (session_id, trace_id, connection_id, slave_id, unit_id, source_kind, source_id, function_code, result,
         t_ms, start_utc, duration_ms, exception_code, mbap_transaction_id, summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        sessionId, row.traceId, row.connectionId, row.slaveId, row.unitId, row.sourceKind, row.sourceId,
        row.functionCode, row.result, row.tMs, row.startUtc, row.durationMs, row.exceptionCode,
        row.mbapTransactionId, row.summary,
      ]);
      if (this.db.getRowsModified() > 0 && raw) {
        if (raw.requestAduHex) this.db.run('INSERT INTO raw_comm (session_id, t_ms, direction, hex, pdu_hex, trace_id) VALUES (?, ?, ?, ?, ?, ?)',
          [sessionId, row.tMs, 'tx', raw.requestAduHex, raw.requestPduHex ?? null, row.traceId]);
        if (raw.responseAduHex) this.db.run('INSERT INTO raw_comm (session_id, t_ms, direction, hex, pdu_hex, trace_id) VALUES (?, ?, ?, ?, ?, ?)',
          [sessionId, row.tMs + Math.max(0, Math.round(row.durationMs ?? 0)), 'rx', raw.responseAduHex, raw.responsePduHex ?? null, row.traceId]);
      }
      this.db.run('COMMIT');
    } catch (error) {
      this.db.run('ROLLBACK');
      throw error;
    }
    this.scheduleFlush();
  }

  private query(sql: string, params: Array<string | number> = []): Array<Record<string, unknown>> {
    const stmt = this.db.prepare(sql);
    const out: Array<Record<string, unknown>> = [];
    try {
      stmt.bind(params);
      while (stmt.step()) out.push(stmt.getAsObject() as Record<string, unknown>);
    } finally {
      stmt.free();
    }
    return out;
  }

  listSessions(): SessionSummary[] {
    return this.query('SELECT * FROM sessions ORDER BY start_utc DESC').map((r) => ({
      id: r.id as string,
      groupId: r.group_id as string,
      groupName: r.group_name as string,
      startUtc: r.start_utc as string,
      endUtc: (r.end_utc as string | null) ?? null,
      status: r.status as 'recording' | 'completed',
      slaveNames: [...new Set((JSON.parse(r.schema_json as string) as SessionSignalSchema[]).map(s => s.slaveName))],
      signalCount: (JSON.parse(r.schema_json as string) as SessionSignalSchema[]).length,
      sampleCount: r.sample_count as number,
      eventCount: r.event_count as number,
      sizeBytes: 0,
    }));
  }

  getSession(id: string): SessionDetail | null {
    const row = this.query('SELECT * FROM sessions WHERE id = ?', [id])[0];
    if (!row) return null;
    return {
      id: row.id as string,
      groupId: row.group_id as string,
      groupName: row.group_name as string,
      startUtc: row.start_utc as string,
      endUtc: (row.end_utc as string | null) ?? null,
      status: row.status as 'recording' | 'completed',
      signalCount: (JSON.parse(row.schema_json as string) as SessionSignalSchema[]).length,
      sampleCount: row.sample_count as number,
      eventCount: row.event_count as number,
      sizeBytes: this.sizeBytes(),
      schema: JSON.parse(row.schema_json as string) as SessionSignalSchema[],
    };
  }

  readSamples(sessionId: string, signalId?: string): SampleRow[] {
    const stmt = this.db.prepare(signalId
      ? 'SELECT signal_id, t_ms, value FROM samples WHERE session_id=? AND signal_id=? ORDER BY t_ms'
      : 'SELECT signal_id, t_ms, value FROM samples WHERE session_id=? ORDER BY t_ms');
    const rows: SampleRow[] = [];
    try {
      stmt.bind(signalId ? [sessionId, signalId] : [sessionId]);
      while (stmt.step()) {
        const [id, tMs, value] = stmt.get();
        rows.push({ signalId: id as string, tMs: tMs as number, value: value as number });
      }
    } finally {
      stmt.free();
    }
    return rows;
  }

  readEvents(sessionId: string): EventRow[] {
    return this.query('SELECT signal_id, t_ms, kind, value FROM events WHERE session_id=? ORDER BY t_ms', [sessionId]).map((r) => ({
      signalId: r.signal_id as string,
      tMs: r.t_ms as number,
      kind: r.kind as EventRow['kind'],
      value: r.value as string,
    }));
  }

  readRawComm(sessionId: string): RawCommRow[] {
    return this.query('SELECT t_ms, direction, hex, pdu_hex, trace_id FROM raw_comm WHERE session_id=? ORDER BY t_ms, rowid', [sessionId]).map((r) => ({
      tMs: r.t_ms as number,
      direction: r.direction as string,
      hex: r.hex as string,
      pduHex: (r.pdu_hex as string | null) ?? null,
      traceId: (r.trace_id as string | null) ?? null,
    }));
  }

  readTransactionMetadata(sessionId: string): TransactionMetadataRow[] {
    return this.query('SELECT * FROM transaction_meta WHERE session_id=? ORDER BY t_ms, rowid', [sessionId]).map(r => ({
      traceId: r.trace_id as string,
      connectionId: r.connection_id as string,
      slaveId: (r.slave_id as string | null) ?? null,
      unitId: r.unit_id as number,
      sourceKind: r.source_kind as SourceKind,
      sourceId: (r.source_id as string | null) ?? null,
      functionCode: r.function_code as number,
      result: r.result as ResultKind,
      tMs: r.t_ms as number,
      startUtc: r.start_utc as string,
      durationMs: (r.duration_ms as number | null) ?? null,
      exceptionCode: (r.exception_code as number | null) ?? null,
      mbapTransactionId: (r.mbap_transaction_id as number | null) ?? null,
      summary: r.summary as string,
    }));
  }
}
