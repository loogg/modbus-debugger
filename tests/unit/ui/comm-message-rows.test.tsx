import React from 'react';
import fs from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CommScreen, transactionMessageRows } from '../../../src/renderer/screens/comm';
import { useApp } from '../../../src/renderer/store/app';
import { workspaceSchema } from '../../../src/domain/model';
import { DEFAULT_PREFS } from '../../../src/main/services/workspace';
import type { TransactionRecord } from '../../../src/shared/contracts';

afterEach(cleanup);

function transaction(traceId: string, result: TransactionRecord['result'], responseAduHex: string | null): TransactionRecord {
  return {
    traceId, connectionId: 'conn-tcp', unitId: 1, functionCode: 3,
    sourceKind: 'temporary-read', sourceId: null, startUtc: '2026-09-25T00:00:00.000Z',
    startMono: 0, durationMs: 12, requestAduHex: '001200000006010300000002',
    responseAduHex, result, exceptionCode: result === 'exception' ? 2 : null,
    mbapTransactionId: 18, summary: `trace-${traceId}`,
  };
}

it('projects a successful exchange into ordered RX and TX rows with distinct times and keys', () => {
  const tx = transaction('ok', 'ok', '0012000000070103041234ABCD');
  const rows = transactionMessageRows([tx]);
  expect(rows.map(row => [row.key, row.direction, row.timeUtc])).toEqual([
    ['ok:RX', 'RX', '2026-09-25T00:00:00.012Z'],
    ['ok:TX', 'TX', '2026-09-25T00:00:00.000Z'],
  ]);
  expect(rows.every(row => row.transaction === tx)).toBe(true);
});

it('keeps a timeout as TX only, and caps the expanded stream at 200 message rows', () => {
  expect(transactionMessageRows([transaction('timeout', 'timeout', null)]).map(row => row.direction)).toEqual(['TX']);
  expect(transactionMessageRows([transaction('bad', 'malformed', 'BAD0')]).map(row => row.direction)).toEqual(['RX', 'TX']);
  const many = Array.from({ length: 150 }, (_, index) => transaction(`t${index}`, 'ok', '010302'));
  const rows = transactionMessageRows(many);
  expect(rows).toHaveLength(200);
  expect(rows[0]?.key).toBe('t149:RX');
  expect(rows.at(-1)?.key).toBe('t50:TX');
  expect(transactionMessageRows(many, 0)).toEqual([]);
});

it('renders sent TX and successful RX separately; selecting either opens the same trace detail', () => {
  const success = transaction('success', 'ok', '0012000000070103041234ABCD');
  const timeout = transaction('timeout', 'timeout', null);
  useApp.setState({
    module: 'comm', toasts: [], commSlaveFilter: {},
    commResultFilter: { ok: true, timeout: true, exception: true, other: true },
    selection: { ...useApp.getState().selection, connectionId: 'conn-tcp', commView: 'messages' },
    snapshot: {
      revision: 1,
      workspace: workspaceSchema.parse(JSON.parse(fs.readFileSync('tools/e2e/demo.workspace.json', 'utf8'))),
      workspacePath: null, dirty: false, connections: {}, blocks: {}, points: {},
      transactions: [success, timeout], parseEvents: [], diagRev: 0, health: {}, recording: null,
      sessions: [], warnings: [], prefs: DEFAULT_PREFS, historyDbPath: '',
    },
  });
  const { container } = render(<CommScreen />);
  const rows = [...container.querySelectorAll('tbody tr')];
  expect(rows).toHaveLength(3);
  expect(rows[0]?.textContent).toContain('TX');
  expect(rows[0]?.textContent).toContain('超时');
  expect(rows[1]?.textContent).toContain('RX');
  expect(rows[1]?.textContent).toContain('成功');
  expect(rows[1]?.textContent).toContain('FC03');
  expect(rows[1]?.textContent).toContain('13 bytes');
  expect(rows[2]?.textContent).toContain('TX');
  expect(rows[2]?.textContent).toContain('已发送');
  expect(rows[2]?.textContent).toContain('FC03');
  expect(rows[2]?.textContent).toContain('trace-success');
  fireEvent.click(rows[2]!);
  expect(screen.getByText('地址 trace-success')).toBeInTheDocument();
  fireEvent.click(rows[1]!);
  expect(screen.getByText('地址 trace-success')).toBeInTheDocument();
});
