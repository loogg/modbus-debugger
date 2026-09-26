/**
 * Reproducible sql.js HistoryStore capacity probe.
 *
 * Run: node --expose-gc node_modules/vite-node/vite-node.mjs tools/bench-history.mjs
 * Optional: --rows=100000,500000,1000000 --batch=1000
 * Each run writes only to a new directory under out/test-temp/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { HistoryStore } from '../src/main/services/history.ts';
import { WorkspaceService } from '../src/main/services/workspace.ts';
import { RuntimeManager } from '../src/main/runtime/manager.ts';
import { buildHistoryCsv, chartSamples, groupSamplesBySignal, sampleAtOrBefore } from '../src/renderer/history-data.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratchRoot = path.join(root, 'out', 'test-temp');
const option = (name, fallback) => process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
const checkpoints = option('--rows', '100000,500000,1000000').split(',').map(Number);
const batchSize = Number(option('--batch', '1000'));
if (!checkpoints.length || checkpoints.some((n, i) => !Number.isSafeInteger(n) || n <= 0 || (i > 0 && n <= checkpoints[i - 1]))) {
  throw new Error('--rows must be an increasing comma-separated list of positive integers');
}
if (!Number.isSafeInteger(batchSize) || batchSize <= 0) throw new Error('--batch must be a positive integer');
fs.mkdirSync(scratchRoot, { recursive: true });
const runDir = fs.mkdtempSync(path.join(scratchRoot, 'history-capacity-'));
const dbPath = path.join(runDir, 'history.db');
const memory = () => {
  const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage();
  return { rss, heapUsed, external, arrayBuffers };
};
const elapsed = (start) => Math.round((performance.now() - start) * 10) / 10;
const schema = [{
  signalId: 'signal-1', pointId: 'point-1', pointName: 'Temperature',
  connectionName: 'TCP', slaveName: 'Unit 1', blockName: 'Holding',
  rawType: 'Float32', unit: '°C', scale: 1, offset: 0,
  enumMap: {}, recordMode: 'samples',
}];

const result = {
  command: process.argv.join(' '),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  timestampUtc: new Date().toISOString(),
  runDir,
  batchSize,
  checkpoints: [],
};
let store;
try {
  const openedAt = performance.now();
  store = await HistoryStore.open(dbPath);
  result.openEmptyMs = elapsed(openedAt);
  store.createSession('session-1', 'group-1', 'Capacity probe', schema);
  let inserted = 0;
  for (const target of checkpoints) {
    const insertStartedAt = performance.now();
    while (inserted < target) {
      const count = Math.min(batchSize, target - inserted);
      const rows = Array.from({ length: count }, (_, index) => ({
        signalId: 'signal-1',
        tMs: (inserted + index) * 1000,
        value: 20 + ((inserted + index) % 1000) / 10,
      }));
      store.insertSamples('session-1', rows);
      inserted += count;
    }
    const insertMs = elapsed(insertStartedAt);
    global.gc?.();
    const beforeFlush = memory();
    const flushedAt = performance.now();
    store.flush();
    const flushMs = elapsed(flushedAt);
    const afterFlush = memory();
    const sizeBytes = fs.statSync(dbPath).size;
    const entry = { rows: inserted, insertMs, flushMs, sizeBytes, beforeFlush, afterFlush };
    result.checkpoints.push(entry);
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  }
  store.endSession('session-1');
  const closeStartedAt = performance.now();
  store.close();
  store = undefined;
  result.closeMs = elapsed(closeStartedAt);
  global.gc?.();
  const beforeReopen = memory();
  const reopenedAt = performance.now();
  const reopened = await HistoryStore.open(dbPath);
  result.reopenMs = elapsed(reopenedAt);
  result.reopenMemory = { before: beforeReopen, after: memory() };
  result.persistedSampleCount = reopened.getSession('session-1')?.sampleCount;
  {
    global.gc?.();
    const beforeRead = memory();
    const readStartedAt = performance.now();
    const readRows = reopened.readSamples('session-1');
    result.readAll = { ms: elapsed(readStartedAt), rows: readRows.length, before: beforeRead, after: memory() };
    if (result.persistedSampleCount !== inserted || readRows.length !== inserted) {
      throw new Error(`Reopen count mismatch: metadata=${result.persistedSampleCount}, read=${readRows.length}, expected=${inserted}`);
    }
  }

  // This is the exact Main command used by HistoryScreen, before Electron IPC serializes it.
  global.gc?.();
  const manager = new RuntimeManager(new WorkspaceService(path.join(runDir, 'workspace')), reopened);
  const beforeCommand = memory();
  const commandStartedAt = performance.now();
  const response = await manager.handleCommand({ type: 'history.sessionData', sessionId: 'session-1' });
  if (!response.ok) throw new Error(response.error);
  const payload = response.value;
  result.sessionDataCommand = {
    ms: elapsed(commandStartedAt), rows: payload.samples.length,
    before: beforeCommand, after: memory(),
  };

  // V8 structured clone is an IPC payload proxy, not an Electron cross-process measurement.
  {
    global.gc?.();
    const beforeClone = memory();
    const cloneStartedAt = performance.now();
    const cloned = structuredClone(payload);
    result.structuredClone = { ms: elapsed(cloneStartedAt), rows: cloned.samples.length, before: beforeClone, after: memory() };
    if (cloned.samples.length !== inserted) throw new Error('IPC clone row count mismatch');
  }

  // Call the same pure chart/cursor helpers as HistoryScreen; ECharts DOM rendering is separate.
  global.gc?.();
  const beforeSeries = memory();
  const seriesStartedAt = performance.now();
  const samplesBySignal = groupSamplesBySignal(payload.samples);
  const series = payload.detail.schema.filter((signal) => signal.recordMode === 'samples').map((signal) => ({
    signalId: signal.signalId,
    data: chartSamples(samplesBySignal.get(signal.signalId) ?? []),
  }));
  result.series = { ms: elapsed(seriesStartedAt), points: series.reduce((sum, item) => sum + item.data.length, 0), before: beforeSeries, after: memory() };
  const totalMs = payload.samples.at(-1)?.tMs ?? 0;
  result.replayCursors = [];
  for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
    global.gc?.();
    const cursorMs = Math.round(totalMs * fraction);
    const beforeCursor = memory();
    const cursorStartedAt = performance.now();
    const cursorEvents = payload.events.filter((event) => event.tMs <= cursorMs);
    const clippedSeries = series.map((signal) => ({ ...signal, data: signal.data.filter(([tMs]) => tMs <= cursorMs) }));
    const lastSample = sampleAtOrBefore(samplesBySignal.get('signal-1') ?? [], cursorMs);
    result.replayCursors.push({ fraction, ms: elapsed(cursorStartedAt), visiblePoints: clippedSeries[0]?.data.length ?? 0, lastValue: lastSample?.value ?? null, events: cursorEvents.length, before: beforeCursor, after: memory() });
  }

  // Match HistoryScreen.exportCsv up to its clipboard write; a file write is measured separately.
  global.gc?.();
  const beforeCsv = memory();
  const csvStartedAt = performance.now();
  const csv = buildHistoryCsv(payload.samples, payload.events);
  result.csvBuild = { ms: elapsed(csvStartedAt), rows: payload.samples.length + payload.events.length, utf8Bytes: Buffer.byteLength(csv), before: beforeCsv, after: memory() };
  const csvWriteStartedAt = performance.now();
  const csvPath = path.join(runDir, 'session-export.csv');
  fs.writeFileSync(csvPath, csv);
  result.csvFileWrite = { ms: elapsed(csvWriteStartedAt), sizeBytes: fs.statSync(csvPath).size, after: memory() };
  reopened.close();
  fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2));
  process.stdout.write(`Result: ${path.join(runDir, 'result.json')}\n`);
} finally {
  store?.close();
}
