import { beforeEach, describe, expect, it } from 'vitest';
import { emptyWorkspace } from '../../src/domain/model';
import { DEFAULT_PREFS } from '../../src/main/services/workspace';
import type { TransactionRecord } from '../../src/main/runtime/diagnostics';
import type { AppSnapshot } from '../../src/shared/snapshot';
import { useApp } from '../../src/renderer/store/app';
import { getDisplayTimeZone, setDisplayTimeZone } from '../../src/renderer/time';
import { i18n } from '../../src/renderer/i18n';

function tx(i: number, over: Partial<TransactionRecord> = {}): TransactionRecord {
  return {
    traceId: `t${i}`,
    connectionId: 'c1',
    unitId: 1,
    functionCode: 3,
    sourceKind: 'poll',
    sourceId: null,
    startUtc: new Date(1700000000000 + i).toISOString(),
    startMono: i,
    durationMs: 1,
    requestAduHex: '00',
    responseAduHex: '00',
    result: 'ok',
    exceptionCode: null,
    mbapTransactionId: null,
    summary: `s${i}`,
    ...over,
  };
}

function snapshot(revision: number): AppSnapshot {
  return {
    revision,
    workspace: emptyWorkspace(),
    workspacePath: null,
    dirty: false,
    connections: {},
    blocks: {},
    points: {},
    transactions: [],
    parseEvents: [],
    diagRev: 0,
    health: {},
    recording: null,
    sessions: [],
    warnings: [],
    prefs: { ...DEFAULT_PREFS },
    historyDbPath: ':memory:',
  };
}

/**
 * Regression: applyDelta() used to handle prefs AFTER the `if (d.transactions) { ... return; }`
 * branch. While a connection polls, Main routinely bundles a prefs.set change into the same
 * delta as new transactions, so the early return dropped it and 时区/语言 silently did nothing.
 */
describe('store applyDelta display prefs', () => {
  beforeEach(() => {
    setDisplayTimeZone('local');
    useApp.setState({ snapshot: snapshot(1) });
  });

  it('applies a timezone change bundled with polling transactions', () => {
    const base = useApp.getState().snapshot!;
    useApp.getState().applyDelta({
      revision: 2,
      transactions: [tx(1), tx(2)],
      prefs: { ...base.prefs, timezone: 'UTC' },
    });
    expect(getDisplayTimeZone()).toBe('UTC');
    // the transactions branch must still have run
    expect(useApp.getState().snapshot?.transactions).toHaveLength(2);
    expect(useApp.getState().snapshot?.prefs.timezone).toBe('UTC');
  });

  it('applies a language change bundled with polling transactions', async () => {
    const base = useApp.getState().snapshot!;
    useApp.getState().applyDelta({
      revision: 3,
      transactions: [tx(1)],
      prefs: { ...base.prefs, language: 'zh-CN' },
    });
    expect(i18n.language).toBe('zh-CN');
  });

  it('applies a prefs-only delta', () => {
    const base = useApp.getState().snapshot!;
    useApp.getState().applyDelta({ revision: 4, prefs: { ...base.prefs, timezone: 'Asia/Tokyo' } });
    expect(getDisplayTimeZone()).toBe('Asia/Tokyo');
  });

  it('leaves the display timezone alone when a delta carries no prefs', () => {
    setDisplayTimeZone('UTC');
    useApp.getState().applyDelta({ revision: 5, transactions: [tx(1)] });
    expect(getDisplayTimeZone()).toBe('UTC');
  });

  it('falls back to OS-local for the "local" preference and ignores unknown zones', () => {
    const base = useApp.getState().snapshot!;
    useApp.getState().applyDelta({ revision: 6, prefs: { ...base.prefs, timezone: 'Not/AZone' } });
    expect(getDisplayTimeZone()).toBeUndefined();
    useApp.getState().applyDelta({ revision: 7, prefs: { ...base.prefs, timezone: 'local' } });
    expect(getDisplayTimeZone()).toBeUndefined();
  });
});