import fs from 'node:fs';
import path from 'node:path';
import initSqlJs, { type Database } from 'sql.js';

export interface SessionSignalSchema {
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
  enumMap: Record<string, string>;
  recordMode: 'samples' | 'events';
}

export interface SessionSummary {
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
    // sql.js is a webpack external; locate its wasm next to the app node_modules.
    // Works in dev (.webpack/main) and packaged (app.asar/.webpack/main) layouts.
    const wasmPath = path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
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
        hex TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_samples ON samples(session_id, signal_id, t_ms);
      CREATE INDEX IF NOT EXISTS idx_events ON events(session_id, t_ms);
    `);
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

  insertRawComm(sessionId: string, tMs: number, direction: string, hex: string): void {
    this.db.run('INSERT INTO raw_comm (session_id, t_ms, direction, hex) VALUES (?, ?, ?, ?)', [sessionId, tMs, direction, hex]);
    this.scheduleFlush();
  }

  private query(sql: string, params: Array<string | number> = []): Array<Record<string, unknown>> {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const out: Array<Record<string, unknown>> = [];
    while (stmt.step()) out.push(stmt.getAsObject() as Record<string, unknown>);
    stmt.free();
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
    const rows = signalId
      ? this.query('SELECT signal_id, t_ms, value FROM samples WHERE session_id=? AND signal_id=? ORDER BY t_ms', [sessionId, signalId])
      : this.query('SELECT signal_id, t_ms, value FROM samples WHERE session_id=? ORDER BY t_ms', [sessionId]);
    return rows.map((r) => ({ signalId: r.signal_id as string, tMs: r.t_ms as number, value: r.value as number }));
  }

  readEvents(sessionId: string): EventRow[] {
    return this.query('SELECT signal_id, t_ms, kind, value FROM events WHERE session_id=? ORDER BY t_ms', [sessionId]).map((r) => ({
      signalId: r.signal_id as string,
      tMs: r.t_ms as number,
      kind: r.kind as EventRow['kind'],
      value: r.value as string,
    }));
  }

  readRawComm(sessionId: string): Array<{ tMs: number; direction: string; hex: string }> {
    return this.query('SELECT t_ms, direction, hex FROM raw_comm WHERE session_id=? ORDER BY t_ms', [sessionId]).map((r) => ({
      tMs: r.t_ms as number,
      direction: r.direction as string,
      hex: r.hex as string,
    }));
  }
}

