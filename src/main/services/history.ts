import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

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

export class HistoryStore {
  private db: Database.Database;
  readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
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
  }

  sizeBytes(): number {
    try {
      return fs.statSync(this.dbPath).size;
    } catch {
      return 0;
    }
  }

  overTenGb(): boolean {
    return this.sizeBytes() > TEN_GB;
  }

  createSession(id: string, groupId: string, groupName: string, schema: SessionSignalSchema[]): void {
    this.db
      .prepare('INSERT INTO sessions (id, group_id, group_name, start_utc, status, schema_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, groupId, groupName, new Date().toISOString(), 'recording', JSON.stringify(schema));
  }

  endSession(id: string): void {
    this.db.prepare("UPDATE sessions SET status='completed', end_utc=? WHERE id=?").run(new Date().toISOString(), id);
  }

  insertSamples(sessionId: string, rows: SampleRow[]): void {
    if (!rows.length) return;
    const stmt = this.db.prepare('INSERT INTO samples (session_id, signal_id, t_ms, value) VALUES (?, ?, ?, ?)');
    const tx = this.db.transaction((items: SampleRow[]) => {
      for (const r of items) stmt.run(sessionId, r.signalId, r.tMs, r.value);
    });
    tx(rows);
    this.db.prepare('UPDATE sessions SET sample_count = sample_count + ? WHERE id = ?').run(rows.length, sessionId);
  }

  insertEvents(sessionId: string, rows: EventRow[]): void {
    if (!rows.length) return;
    const stmt = this.db.prepare('INSERT INTO events (session_id, signal_id, t_ms, kind, value) VALUES (?, ?, ?, ?, ?)');
    const tx = this.db.transaction((items: EventRow[]) => {
      for (const r of items) stmt.run(sessionId, r.signalId, r.tMs, r.kind, r.value);
    });
    tx(rows);
    this.db.prepare('UPDATE sessions SET event_count = event_count + ? WHERE id = ?').run(rows.length, sessionId);
  }

  insertRawComm(sessionId: string, tMs: number, direction: string, hex: string): void {
    this.db.prepare('INSERT INTO raw_comm (session_id, t_ms, direction, hex) VALUES (?, ?, ?, ?)').run(sessionId, tMs, direction, hex);
  }

  listSessions(): SessionSummary[] {
    const rows = this.db.prepare('SELECT * FROM sessions ORDER BY start_utc DESC').all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
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
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
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
    const rows = (signalId
      ? this.db.prepare('SELECT signal_id, t_ms, value FROM samples WHERE session_id=? AND signal_id=? ORDER BY t_ms').all(sessionId, signalId)
      : this.db.prepare('SELECT signal_id, t_ms, value FROM samples WHERE session_id=? ORDER BY t_ms').all(sessionId)) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ signalId: r.signal_id as string, tMs: r.t_ms as number, value: r.value as number }));
  }

  readEvents(sessionId: string): EventRow[] {
    const rows = this.db.prepare('SELECT signal_id, t_ms, kind, value FROM events WHERE session_id=? ORDER BY t_ms').all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ signalId: r.signal_id as string, tMs: r.t_ms as number, kind: r.kind as EventRow['kind'], value: r.value as string }));
  }

  readRawComm(sessionId: string): Array<{ tMs: number; direction: string; hex: string }> {
    const rows = this.db.prepare('SELECT t_ms, direction, hex FROM raw_comm WHERE session_id=? ORDER BY t_ms').all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ tMs: r.t_ms as number, direction: r.direction as string, hex: r.hex as string }));
  }

  close(): void {
    this.db.close();
  }
}