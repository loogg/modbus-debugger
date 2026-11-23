import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import initSqlJs from 'sql.js';
import { createScratch } from '../../tools/test-paths.mjs';
import path from 'node:path';
import { WorkspaceService } from '../../src/main/services/workspace';
import { HistoryStore, type TransactionMetadataRow } from '../../src/main/services/history';
import { writeLegacyHistoryFixture } from '../../tools/legacy-history-fixture';
import { emptyWorkspace } from '../../src/domain/model';
import { templateWorkspace } from '../support/template-workspace';

function tmpDir(): string {
  return createScratch('persistence-');
}

describe('Workspace persistence', () => {
  it('preserves a point decimal precision across save and reload', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'precision.workspace.json');
    const workspace = templateWorkspace();
    workspace.templates[0]!.points[0]!.decimalPlaces = 2;
    workspace.templates[0]!.points[0]!.access = 'wo';
    const writer = new WorkspaceService(dir);
    writer.adopt(workspace, file);
    expect(writer.saveTo().ok).toBe(true);
    const reader = new WorkspaceService(dir);
    expect(reader.loadFrom(file).ok).toBe(true);
    expect(reader.current.templates[0]?.points[0]?.decimalPlaces).toBe(2);
    expect(reader.current.templates[0]?.points[0]?.access).toBe('wo');
  });

  it('saves atomically and reloads', () => {
    const dir = tmpDir();
    const svc = new WorkspaceService(dir);
    const file = path.join(dir, 'ws.workspace.json');
    svc.adopt({ ...emptyWorkspace('demo'), connections: [{ id: 'c1', name: 'RTU', transport: 'rtu', rtu: { port: 'COM1', baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1 }, timeoutMs: 500, retries: 1, reconnect: 'auto', interFrameMs: 0, rtsControl: 'none', logLevel: 'info' }] }, file);
    const res = svc.saveTo();
    expect(res.ok).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    const svc2 = new WorkspaceService(dir);
    const loaded = svc2.loadFrom(file);
    expect(loaded.ok).toBe(true);
    expect(svc2.current.connections.length).toBe(1);
  });

  it('exports a portable file without changing the active autosave path', () => {
    const dir = tmpDir();
    const svc = new WorkspaceService(dir);
    const active = path.join(dir, 'active.workspace.json');
    const exported = path.join(dir, 'backup.workspace.json');
    svc.adopt(emptyWorkspace('export check'), active);
    expect(svc.saveTo().ok).toBe(true);
    expect(svc.exportToFile(exported).ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(exported, 'utf8')).name).toBe('export check');
    expect(svc.currentPath).toBe(active);
    expect(svc.getPrefs().lastWorkspacePath).toBe(active);
    expect(svc.exportToFile(dir).ok).toBe(false);
    expect(svc.currentPath).toBe(active);
    expect(fs.readdirSync(dir).filter(name => name.includes('.tmp-'))).toEqual([]);
  });

  it('leaves no temp files behind', () => {
    const dir = tmpDir();
    const svc = new WorkspaceService(dir);
    svc.adopt(emptyWorkspace(), path.join(dir, 'a.workspace.json'));
    svc.saveTo();
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('import failure does not corrupt the current workspace', () => {
    const dir = tmpDir();
    const svc = new WorkspaceService(dir);
    svc.adopt(emptyWorkspace('keep'), null);
    const bad = svc.importFromBuffer('{ not json');
    expect(bad.ok).toBe(false);
    expect(svc.current.name).toBe('keep');
  });

  it('autosave writes after debounce', async () => {
    const dir = tmpDir();
    const svc = new WorkspaceService(dir);
    const file = path.join(dir, 'auto.workspace.json');
    svc.adopt(emptyWorkspace('auto'), file);
    svc.mutate((ws) => ({ ...ws, name: 'changed' }));
    await new Promise((r) => setTimeout(r, 1000));
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8')) as { name: string };
    expect(onDisk.name).toBe('changed');
  });
});

describe('History store', () => {
  it('reads legacy transaction metadata alongside optional raw frames', async () => {
    const dbPath = path.join(tmpDir(), 'history.db');
    const row: TransactionMetadataRow = {
      traceId: 't1', connectionId: 'c1', slaveId: 's1', unitId: 1,
      sourceKind: 'temporary-read', sourceId: null, functionCode: 3, result: 'ok',
      tMs: 5, startUtc: '2026-09-25T00:00:00.000Z', durationMs: 0,
      exceptionCode: null, mbapTransactionId: 12, summary: 'FC03 read',
    };
    await writeLegacyHistoryFixture(dbPath, [{ id: 'meta', groupId: 'g', groupName: 'g', schema: [],
      transactions: [row, { ...row, traceId: 't2', tMs: 6 }], rawComm: [
        { tMs: 5, traceId: 't1', direction: 'tx', hex: '0103', pduHex: '03' },
        { tMs: 5, traceId: 't1', direction: 'rx', hex: '010302', pduHex: '0302' },
      ] }]);
    const db = await HistoryStore.open(dbPath);
    try {
      expect(db.readTransactionMetadata('meta').map(tx => tx.traceId)).toEqual(['t1', 't2']);
      expect(db.readRawComm('meta').map(frame => [frame.traceId, frame.direction, frame.pduHex])).toEqual([
        ['t1', 'tx', '03'], ['t1', 'rx', '0302'],
      ]);
    } finally { db.close(); }
  });

  it('keeps Tx before Rx when both legacy raw frames share a millisecond, including after reopen', async () => {
    const dbPath = path.join(tmpDir(), 'history.db');
    await writeLegacyHistoryFixture(dbPath, [{ id: 'raw-order', groupId: 'g', groupName: 'raw', schema: [], rawComm: [
      { tMs: 0, direction: 'tx', hex: '0103' }, { tMs: 0, direction: 'rx', hex: '010302' }, { tMs: 1, direction: 'tx', hex: '0104' },
    ] }]);
    const db = await HistoryStore.open(dbPath);
    db.close();
    const reopened = await HistoryStore.open(dbPath);
    try {
      expect(reopened.readRawComm('raw-order')).toEqual([
        { tMs: 0, direction: 'tx', hex: '0103', pduHex: null, traceId: null },
        { tMs: 0, direction: 'rx', hex: '010302', pduHex: null, traceId: null },
        { tMs: 1, direction: 'tx', hex: '0104', pduHex: null, traceId: null },
      ]);
    } finally { reopened.close(); }
  });

  it('opens an old raw_comm schema without losing frames and adds the metadata table', async () => {
    const dbPath = path.join(tmpDir(), 'legacy.db');
    const wasm = fs.readFileSync(path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'));
    const SQL = await initSqlJs({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) });
    const legacy = new SQL.Database();
    legacy.run('CREATE TABLE raw_comm (session_id TEXT NOT NULL, t_ms INTEGER NOT NULL, direction TEXT NOT NULL, hex TEXT NOT NULL)');
    legacy.run("INSERT INTO raw_comm VALUES ('old-session', 7, 'tx', '0103')");
    fs.writeFileSync(dbPath, Buffer.from(legacy.export()));
    legacy.close();
    const store = await HistoryStore.open(dbPath);
    try {
      expect(store.readRawComm('old-session')).toEqual([{ tMs: 7, direction: 'tx', hex: '0103', pduHex: null, traceId: null }]);
      expect(store.readTransactionMetadata('old-session')).toEqual([]);
    } finally { store.close(); }
    const reopened = await HistoryStore.open(dbPath);
    try { expect(reopened.readRawComm('old-session')).toHaveLength(1); }
    finally { reopened.close(); }
  });

  it('raises the size reminder only above the 10 GiB threshold without allocating a huge database', async () => {
    const db = await HistoryStore.open(path.join(tmpDir(), 'history.db'));
    const size = vi.spyOn(db, 'sizeBytes');
    try {
      size.mockReturnValueOnce(10 * 1024 ** 3).mockReturnValueOnce(10 * 1024 ** 3 + 1);
      expect(db.overTenGb()).toBe(false);
      expect(db.overTenGb()).toBe(true);
    } finally { db.close(); }
  });

  it('reads persisted session schemas, full precision samples and events', async () => {
    const dbPath = path.join(tmpDir(), 'history.db');
    await writeLegacyHistoryFixture(dbPath, [{ id: 's1', groupId: 'g1', groupName: 'group', schema: [
      { signalId: 'sig1', pointId: 'p1', pointName: 'speed', connectionName: 'c', slaveName: 's', blockName: 'b', rawType: 'Float64', unit: 'rpm', scale: 1, offset: 0, decimalPlaces: 2, enumMap: {}, recordMode: 'samples' },
      { signalId: 'sig2', pointId: 'p2', pointName: 'mode', connectionName: 'c', slaveName: 's', blockName: 'b', rawType: 'BitField', unit: '', scale: 1, offset: 0, enumMap: { '0': 'pos' }, recordMode: 'events' },
    ], samples: [{ signalId: 'sig1', tMs: 0, value: 1.234567890123 }, { signalId: 'sig1', tMs: 100, value: 2.345678901234 }],
    events: [{ signalId: 'sig2', tMs: 50, kind: 'enum', value: 'pos' }] }]);
    const db = await HistoryStore.open(dbPath);
    try {
      expect(db.listSessions()[0]).toMatchObject({ status: 'completed', sampleCount: 2, eventCount: 1 });
      expect(db.getSession('s1')?.schema[0]).toMatchObject({ pointName: 'speed', decimalPlaces: 2 });
      expect(db.readSamples('s1').map(row => row.value)).toEqual([1.234567890123, 2.345678901234]);
      expect(db.readEvents('s1')[0]?.value).toBe('pos');
    } finally { db.close(); }
  });

  it('preserves old session definitions when the current workspace changes', async () => {
    const dir = tmpDir();
    const workspace = new WorkspaceService(dir);
    const fixture = templateWorkspace();
    const dbPath = path.join(dir, 'history.db');
    await writeLegacyHistoryFixture(dbPath, [{ id: 's2', groupId: 'g', groupName: 'g', schema: [
      { signalId: 'a', pointId: 'p', pointName: 'old-name', connectionName: '', slaveName: '', blockName: '', rawType: 'UInt16', unit: '', scale: 1, offset: 0, enumMap: {}, recordMode: 'samples' },
    ] }]);
    workspace.set(fixture);
    fixture.templates[0]!.points[0]!.name = 'new-name';
    workspace.set(fixture);
    const db = await HistoryStore.open(dbPath);
    try { expect(db.getSession('s2')?.schema[0]?.pointName).toBe('old-name'); }
    finally { db.close(); }
  });

  it('reads persisted samples in timestamp order and filters by signal', async () => {
    const dbPath = path.join(tmpDir(), 'history.db');
    await writeLegacyHistoryFixture(dbPath, [{ id: 's3', groupId: 'g', groupName: 'g', schema: [], samples: [
      { signalId: 'a', tMs: 300, value: 3 }, { signalId: 'b', tMs: 200, value: 2 }, { signalId: 'a', tMs: 100, value: 1 },
    ] }]);
    const db = await HistoryStore.open(dbPath);
    try {
      expect(db.readSamples('s3').map(row => row.tMs)).toEqual([100, 200, 300]);
      expect(db.readSamples('s3', 'a').map(row => row.value)).toEqual([1, 3]);
    } finally { db.close(); }
  });

  it('adds notes atomically to unfinished legacy sessions and preserves them after reopening', async () => {
    const dbPath = path.join(tmpDir(), 'history.db');
    await writeLegacyHistoryFixture(dbPath, [{ id: 'unfinished', groupId: 'g', groupName: 'old', status: 'recording', schema: [] }]);
    const db = await HistoryStore.open(dbPath);
    db.addNote('unfinished', 42, 'quoted "note", line');
    expect(() => db.addNote('missing', 42, 'invalid')).toThrow('session not found');
    expect(db.readEvents('missing')).toEqual([]);
    db.close();
    const reopened = await HistoryStore.open(dbPath);
    try {
      expect(reopened.getSession('unfinished')).toMatchObject({ status: 'recording', eventCount: 1 });
      expect(reopened.readEvents('unfinished')[0]).toMatchObject({ tMs: 42, kind: 'marker', value: 'quoted "note", line' });
    } finally { reopened.close(); }
  });
});
