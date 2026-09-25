/* eslint-disable no-console */
import { RuntimeManager } from '../src/main/runtime/manager';
import { WorkspaceService } from '../src/main/services/workspace';
import { HistoryStore } from '../src/main/services/history';
import path from 'node:path';

async function run() {
  const dataDir = path.resolve(__dirname, '../data');
  const wsSvc = new WorkspaceService(dataDir);
  const history = await HistoryStore.open(':memory:');
  const manager = new RuntimeManager(wsSvc, history);

  const workspace = {
    schemaVersion: 1,
    name: 'RTU COM1 Test',
    connections: [
      {
        id: 'conn-rtu',
        name: '串口 COM1',
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
      },
    ],
    slaves: [
      {
        id: 'slave-rtu-1',
        connectionId: 'conn-rtu',
        unitId: 1,
        name: 'RTU 从站 1',
        templateId: 'tpl-rtu',
        enabled: true,
      },
    ],
    templates: [
      {
        id: 'tpl-rtu',
        name: 'RTU 测试模板',
        version: '1.0',
        description: 'RTU COM1 to COM2 test',
        blocks: [
          { id: 'blk-hold', name: '保持寄存器', area: 3 as const, start: 0, length: 4, periodMs: 300 },
        ],
        points: [
          {
            id: 'pt-h0',
            blockId: 'blk-hold',
            name: '寄存器0',
            mapping: { rawType: 'UInt16' as const, offset: 0, registerCount: 1, wordOrder: 'ABCD' as const, byteSelector: 'low' as const, bitOffset: 0, bitWidth: 16, stringLength: 0, stringEncoding: 'ascii' as const },
            scale: 1,
            offset: 0,
            unit: 'rpm',
            access: 'rw' as const,
            displayFormat: 'auto' as const,
            enumMap: {},
            highRisk: false,
            description: '',
          },
        ],
      },
    ],
    trendGroups: [],
    layout: { module: 'devices' as const, selection: {} },
  };

  wsSvc.loadFrom(null);
  manager.start();
  await manager.handleCommand({ type: 'workspace.apply', workspace });

  console.log('Connecting to conn-rtu (COM1 -> COM2)...');
  const connRes = await manager.handleCommand({ type: 'connection.connect', connectionId: 'conn-rtu' });
  console.log('Connect command result:', connRes);

  // Wait for 3 seconds to observe telemetry
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 600));
    const snap = manager.buildSnapshot();
    const conn = snap.connections['conn-rtu'];
    const pt = snap.points['slave-rtu-1:pt-h0'];
    console.log(`[RTU Poll ${i + 1}] State: ${conn?.state}, Quality: ${pt?.quality}, TX: ${conn?.stats?.txFrames}, RX: ${conn?.stats?.rxFrames}, Errors: ${conn?.stats?.errorFrames}, Val: ${JSON.stringify(pt?.value)}`);
  }

  // 1. Test Write Point
  console.log('\n--- 1. Testing Point Write (writing 4567 to pt-h0) ---');
  const writeRes = await manager.handleCommand({
    type: 'point.write',
    slaveId: 'slave-rtu-1',
    pointId: 'pt-h0',
    engineering: 4567,
    boolValue: null,
    stringValue: null,
  });
  console.log('Write result:', writeRes);

  await new Promise((r) => setTimeout(r, 800));
  const snapAfterWrite = manager.buildSnapshot();
  const readBack = snapAfterWrite.points['slave-rtu-1:pt-h0'];
  console.log('Confirmed read-back value after write:', readBack?.value);

  // 2. Test Temporary Read
  console.log('\n--- 2. Testing Temporary Read (Unit 1, Area 3, Start 0, Quantity 4) ---');
  const tempRes = await manager.handleCommand({
    type: 'device.temporaryRead',
    connectionId: 'conn-rtu',
    unitId: 1,
    area: 3,
    start: 0,
    quantity: 4,
  });
  console.log('Temporary read outcome:', JSON.stringify(tempRes, null, 2));

  // 3. Test Device Scan
  console.log('\n--- 3. Testing Device Scan (from 1 to 3) ---');
  const scanRes = await manager.handleCommand({
    type: 'device.scan',
    connectionId: 'conn-rtu',
    from: 1,
    to: 3,
    options: { timeoutMs: 300, retries: 0, fc: 3, start: 0 },
  });
  console.log('Scan outcome:', JSON.stringify(scanRes, null, 2));

  console.log('\nDisconnecting RTU...');
  await manager.handleCommand({ type: 'connection.disconnect', connectionId: 'conn-rtu' });
  await manager.stop();
  console.log('RTU Live Test Complete Successfully!');
}

run().catch((err) => {
  console.error('RTU Live Test Failed:', err);
  process.exit(1);
});
