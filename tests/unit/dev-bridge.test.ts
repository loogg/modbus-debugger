import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DevBridgeServer } from '../../src/main/services/dev-bridge';
import { AppBackendService } from '../../src/main/services/backend-service';
import { RuntimeManager } from '../../src/main/runtime/manager';
import { WorkspaceService } from '../../src/main/services/workspace';
import { HistoryStore } from '../../src/main/services/history';
import { UpdateService } from '../../src/main/services/updater';
import path from 'node:path';
import fs from 'node:fs';

const testDir = path.resolve(__dirname, '../../out/test-temp/dev-bridge-test');

describe('DevBridgeServer and AppBackendService', () => {
  let wsSvc: WorkspaceService;
  let history: HistoryStore;
  let manager: RuntimeManager;
  let updater: UpdateService;
  let backend: AppBackendService;
  let server: DevBridgeServer;
  let port: number;

  beforeEach(async () => {
    fs.mkdirSync(testDir, { recursive: true });
    wsSvc = new WorkspaceService(testDir);
    history = await HistoryStore.open(path.join(testDir, 'test.db'));
    manager = new RuntimeManager(wsSvc, history);
    updater = new UpdateService({
      currentVersion: '0.11.0',
      packageKind: 'zip',
      platform: 'win32',
      arch: 'x64',
      dataDirectory: testDir,
      tempDirectory: testDir,
      fetch: async () => ({ ok: true, json: async () => ({}) }) as unknown as Response,
      reveal: () => {},
      openExternal: async () => {},
      canInstall: false,
      bootPending: false,
      installMessage: null,
      confirmBoot: async () => null,
      install: async () => {},
    });
    backend = new AppBackendService(manager, updater);
    server = new DevBridgeServer(backend, { port: 0, host: '127.0.0.1' });
    port = await server.start();
  });

  afterEach(async () => {
    await server.close();
    await manager.stop();
    await updater.dispose();
  });

  it('connects via WebSocket, receives hello, and responds to snapshot request', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);

    const messages: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'snapshot', id: 'req_1' }));
      };
      ws.onmessage = (event) => {
        messages.push(JSON.parse(String(event.data)));
        if (messages.length === 2) {
          ws.close();
          resolve();
        }
      };
      ws.onerror = (e) => reject(new Error(`WebSocket error: ${String(e)}`));
    });

    expect(messages[0]).toMatchObject({ type: 'hello' });
    expect(messages[1]).toMatchObject({
      type: 'response',
      id: 'req_1',
      ok: true,
      value: expect.objectContaining({ revision: expect.any(Number) }),
    });
  });

  it('rejects disallowed non-whitelisted message types', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);

    const res = await new Promise<unknown>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'eval_shell', id: 'evil_1', code: 'rm -rf /' }));
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(String(event.data));
        if (msg.type === 'response' && msg.id === 'evil_1') {
          ws.close();
          resolve(msg);
        }
      };
      ws.onerror = (e) => reject(new Error(`WebSocket error: ${String(e)}`));
    });

    expect(res).toMatchObject({
      type: 'response',
      id: 'evil_1',
      ok: false,
      error: expect.stringContaining('disallowed'),
    });
  });

  it('broadcasts delta events to connected clients', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);

    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });

    const deltaPromise = new Promise<unknown>((resolve) => {
      ws.onmessage = (event) => {
        const msg = JSON.parse(String(event.data));
        if (msg.type === 'delta') {
          ws.close();
          resolve(msg);
        }
      };
    });

    // Trigger delta through manager.onDelta
    if (manager.onDelta) {
      manager.onDelta({ revision: 42, warnings: ['Test Warning'] });
    }

    const deltaMsg = await deltaPromise;
    expect(deltaMsg).toMatchObject({
      type: 'delta',
      delta: expect.objectContaining({ revision: 42 }),
    });
  });
});
