/** Opt-in packaged-app capacity smoke. Never included in the ordinary E2E spec list. */
import path from 'node:path';
import { config as base } from './wdio.conf';
import { writeLegacyHistoryFixture } from './tools/legacy-history-fixture';

function* capacitySamples() {
  for (let index = 0; index < 1_000_000; index++) {
    yield { signalId: 'signal-1', tMs: index * 1000, value: 20 + (index % 1000) / 10 };
  }
}

export const config = {
  ...base,
  specs: ['./tests/capacity/history-capacity.e2e.ts'],
  beforeSession: async () => {
    const runDir = process.env.MODBUS_TEST_RUN_DIR;
    if (!runDir) throw new Error('Capacity E2E requires MODBUS_TEST_RUN_DIR');
    const dbPath = path.join(runDir, 'data', 'history.db');
    const start = Date.UTC(2026, 10, 1);
    await writeLegacyHistoryFixture(dbPath, [{
      id: 'capacity-1m', groupId: 'capacity', groupName: 'Capacity 1M',
      startUtc: new Date(start).toISOString(), endUtc: new Date(start + 999_999_000).toISOString(),
      schema: [{
        signalId: 'signal-1', pointId: 'point-1', pointName: 'Temperature',
        connectionName: 'TCP', slaveName: 'Unit 1', blockName: 'Holding',
        rawType: 'Float32', unit: '°C', scale: 1, offset: 0,
        enumMap: {}, recordMode: 'samples',
      }],
      samples: capacitySamples(),
    }]);
  },
};
