/** Opt-in packaged-app capacity smoke. Never included in the ordinary E2E spec list. */
import fs from 'node:fs';
import path from 'node:path';
import { config as base } from './wdio.conf';
import { HistoryStore } from './src/main/services/history';

export const config = {
  ...base,
  specs: ['./tests/capacity/history-capacity.e2e.ts'],
  onPrepare: async () => {
    await base.onPrepare();
    const runDir = process.env.MODBUS_TEST_RUN_DIR;
    if (!runDir) throw new Error('Capacity E2E requires MODBUS_TEST_RUN_DIR');
    const dbPath = path.join(runDir, 'data', 'history.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const history = await HistoryStore.open(dbPath);
    try {
      history.createSession('capacity-1m', 'capacity', 'Capacity 1M', [{
        signalId: 'signal-1', pointId: 'point-1', pointName: 'Temperature',
        connectionName: 'TCP', slaveName: 'Unit 1', blockName: 'Holding',
        rawType: 'Float32', unit: '°C', scale: 1, offset: 0,
        enumMap: {}, recordMode: 'samples',
      }]);
      for (let start = 0; start < 1_000_000; start += 1000) {
        history.insertSamples('capacity-1m', Array.from({ length: 1000 }, (_, index) => ({
          signalId: 'signal-1', tMs: (start + index) * 1000,
          value: 20 + ((start + index) % 1000) / 10,
        })));
      }
      history.endSession('capacity-1m');
    } finally {
      history.close();
    }
  },
};
