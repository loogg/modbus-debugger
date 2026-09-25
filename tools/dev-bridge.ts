/* eslint-disable no-console */
import path from 'node:path';
import fs from 'node:fs';
import { RuntimeManager } from '../src/main/runtime/manager';
import { WorkspaceService } from '../src/main/services/workspace';
import { HistoryStore } from '../src/main/services/history';
import { UpdateService } from '../src/main/services/updater';
import { AppBackendService } from '../src/main/services/backend-service';
import { DevBridgeServer } from '../src/main/services/dev-bridge';

async function main() {
  const dataDir = path.resolve(__dirname, '../data');
  const tempDir = path.resolve(__dirname, '../data/temp');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });

  const wsSvc = new WorkspaceService(dataDir);
  const historyPath = path.join(dataDir, 'history.db');
  const history = await HistoryStore.open(historyPath);
  const manager = new RuntimeManager(wsSvc, history);
  wsSvc.loadFrom(null);
  if (wsSvc.current.connections.length === 0 && wsSvc.current.templates.length === 0) {
    const demoPath = path.resolve(__dirname, 'e2e/demo.workspace.json');
    if (fs.existsSync(demoPath)) {
      wsSvc.loadFrom(demoPath);
    }
  }
  manager.start();

  const updater = new UpdateService({
    currentVersion: '0.11.0',
    packageKind: 'zip',
    platform: process.platform,
    arch: process.arch,
    dataDirectory: dataDir,
    tempDirectory: tempDir,
    fetch: (async (url: string | URL, init?: RequestInit) => fetch(url, init)) as unknown as typeof import('electron').net.fetch,
    reveal: () => {},
    openExternal: async () => {},
    canInstall: false,
    bootPending: false,
    installMessage: null,
    confirmBoot: async () => null,
    install: async () => {},
  });

  const backend = new AppBackendService(manager, updater);
  const port = Number(process.env.MODBUS_DEV_BRIDGE_PORT || 5174);
  const server = new DevBridgeServer(backend, { port, host: '127.0.0.1' });

  const actualPort = await server.start();
  console.log(`[DevBridge] Server listening on ws://127.0.0.1:${actualPort}`);

  const cleanup = async () => {
    console.log('[DevBridge] Shutting down...');
    await server.close();
    await manager.stop();
    await updater.dispose();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main().catch((err) => {
  console.error('[DevBridge] Fatal error:', err);
  process.exit(1);
});
