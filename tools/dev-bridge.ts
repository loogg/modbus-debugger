/* eslint-disable no-console */
import path from 'node:path';
import fs from 'node:fs';
import { RuntimeManager } from '../src/main/runtime/manager';
import { WorkspaceService } from '../src/main/services/workspace';
import { HistoryStore } from '../src/main/services/history';
import { UpdateService } from '../src/main/services/updater';
import { AppBackendService } from '../src/main/services/backend-service';
import packageJson from '../package.json';
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

  // If COM1 exists in the environment and no RTU connection is defined yet, dynamically enrich workspace
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { SerialPort } = require('serialport') as { SerialPort: { list(): Promise<Array<{ path: string }>> } };
    const ports = await SerialPort.list();
    const hasCom1 = ports.some((p) => p.path?.toUpperCase() === 'COM1');
    const ws = wsSvc.current;
    if (hasCom1 && !ws.connections.some((c) => c.transport === 'rtu')) {
      const rtuConn = {
        id: 'conn-rtu',
        name: '现场总线 RTU (COM1 115200)',
        transport: 'rtu' as const,
        rtu: {
          port: 'COM1',
          baudRate: 115200,
          dataBits: 8 as const,
          parity: 'none' as const,
          stopBits: 1 as const,
        },
        timeoutMs: 1000,
        retries: 2,
        reconnect: 'auto' as const,
        interFrameMs: 4,
        rtsControl: 'none' as const,
        logLevel: 'info' as const,
      };
      const tplFlow = {
        id: 'tpl-flow',
        name: 'FlowMeter-485',
        version: '1.0',
        description: 'RTU 流量计模板',
        blocks: [
          { id: 'blk-flow-hold', name: '过程量保持寄存器', area: 3 as const, start: 0, length: 8, periodMs: 400 },
        ],
        points: [
          { id: 'pt-flow-inst', blockId: 'blk-flow-hold', name: '瞬时流量', mapping: { rawType: 'Float32' as const, offset: 0, registerCount: 2, wordOrder: 'ABCD' as const, byteSelector: 'low' as const, bitOffset: 0, bitWidth: 16, stringLength: 0, stringEncoding: 'ascii' as const }, scale: 1, offset: 0, unit: 'm³/h', access: 'ro' as const, displayFormat: 'auto' as const, enumMap: {}, highRisk: false, description: '' },
          { id: 'pt-flow-total', blockId: 'blk-flow-hold', name: '累计流量', mapping: { rawType: 'Float32' as const, offset: 2, registerCount: 2, wordOrder: 'ABCD' as const, byteSelector: 'low' as const, bitOffset: 0, bitWidth: 16, stringLength: 0, stringEncoding: 'ascii' as const }, scale: 1, offset: 0, unit: 'm³', access: 'ro' as const, displayFormat: 'auto' as const, enumMap: {}, highRisk: false, description: '' },
          { id: 'pt-flow-setpoint', blockId: 'blk-flow-hold', name: '设定流速阈值', mapping: { rawType: 'UInt16' as const, offset: 4, registerCount: 1, wordOrder: 'ABCD' as const, byteSelector: 'low' as const, bitOffset: 0, bitWidth: 16, stringLength: 0, stringEncoding: 'ascii' as const }, scale: 0.1, offset: 0, unit: 'm/s', access: 'rw' as const, displayFormat: 'auto' as const, enumMap: {}, highRisk: false, description: '' },
          { id: 'pt-flow-alarm', blockId: 'blk-flow-hold', name: '超限报警使能', mapping: { rawType: 'Bool' as const, offset: 5, registerCount: 1, wordOrder: 'ABCD' as const, byteSelector: 'low' as const, bitOffset: 0, bitWidth: 1, stringLength: 0, stringEncoding: 'ascii' as const }, scale: 1, offset: 0, unit: '', access: 'rw' as const, displayFormat: 'auto' as const, enumMap: {}, highRisk: false, description: '' },
          { id: 'pt-flow-reset', blockId: 'blk-flow-hold', name: '清空累计量(高危)', mapping: { rawType: 'UInt16' as const, offset: 6, registerCount: 1, wordOrder: 'ABCD' as const, byteSelector: 'low' as const, bitOffset: 0, bitWidth: 16, stringLength: 0, stringEncoding: 'ascii' as const }, scale: 1, offset: 0, unit: '', access: 'rw' as const, displayFormat: 'auto' as const, enumMap: {}, highRisk: true, description: '写入 0xAA55 清空从站累计数据' },
        ],
      };
      const rtuSlave = {
        id: 'slave-rtu-1',
        connectionId: 'conn-rtu',
        unitId: 1,
        name: '流量变送器 (COM1)',
        templateId: 'tpl-flow',
        enabled: true,
      };
      wsSvc.set({
        ...ws,
        name: '工业混合调试工作区 (TCP + RTU COM1)',
        connections: [...ws.connections, rtuConn],
        slaves: [...ws.slaves, rtuSlave],
        templates: [...ws.templates, tplFlow],
      });
    }
  } catch {
    // Ignore serial port detection error
  }
  manager.start();

  const updater = new UpdateService({
    currentVersion: packageJson.version,
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
