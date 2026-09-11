import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceService } from '../../src/main/services/workspace';
import { HistoryStore } from '../../src/main/services/history';
import { emptyWorkspace } from '../../src/domain/model';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mbtest-'));
}

describe('Workspace persistence', () => {
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
  it('records sessions with schema snapshot, samples and events', async () => {
    const dir = tmpDir();
    const db = await HistoryStore.open(path.join(dir, 'history.db'));
    db.createSession('s1', 'g1', 'group', [
      { signalId: 'sig1', pointId: 'p1', pointName: 'speed', connectionName: 'c', slaveName: 's', blockName: 'b', rawType: 'Int16', unit: 'rpm', scale: 1, offset: 0, enumMap: {}, recordMode: 'samples' },
      { signalId: 'sig2', pointId: 'p2', pointName: 'mode', connectionName: 'c', slaveName: 's', blockName: 'b', rawType: 'BitField', unit: '', scale: 1, offset: 0, enumMap: { '0': 'pos' }, recordMode: 'events' },
    ]);
    db.insertSamples('s1', [{ signalId: 'sig1', tMs: 0, value: 1 }, { signalId: 'sig1', tMs: 100, value: 2 }]);
    db.insertEvents('s1', [{ signalId: 'sig2', tMs: 50, kind: 'enum', value: 'pos' }]);
    db.endSession('s1');
    const detail = db.getSession('s1');
    expect(detail?.schema.length).toBe(2);
    expect(detail?.status).toBe('completed');
    expect(db.readSamples('s1').length).toBe(2);
    expect(db.readEvents('s1')[0]?.value).toBe('pos');
    db.close();
  });

  it('schema snapshot survives later template changes', async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, 'history.db');
    const db = await HistoryStore.open(dbPath);
    db.createSession('s2', 'g', 'g', [{ signalId: 'a', pointId: 'p', pointName: 'old-name', connectionName: '', slaveName: '', blockName: '', rawType: 'UInt16', unit: '', scale: 1, offset: 0, enumMap: {}, recordMode: 'samples' }]);
    db.close();
    const db2 = await HistoryStore.open(dbPath);
    expect(db2.getSession('s2')?.schema[0]?.pointName).toBe('old-name');
    db2.close();
  });
});