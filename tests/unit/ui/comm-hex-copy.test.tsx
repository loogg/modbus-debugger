import React from 'react';
import fs from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CommScreen } from '../../../src/renderer/screens/comm';
import { useApp } from '../../../src/renderer/store/app';
import { workspaceSchema } from '../../../src/domain/model';
import { DEFAULT_PREFS } from '../../../src/main/services/workspace';
import type { TransactionRecord } from '../../../src/shared/contracts';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('copies request and response Raw ADU bytes exactly, without display spacing', () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const transaction: TransactionRecord = {
    traceId: 'trace-hex', connectionId: 'conn-tcp', unitId: 1, functionCode: 3,
    sourceKind: 'temporary-read', sourceId: null,
    startUtc: '2026-09-25T00:00:00.000Z', startMono: 0, durationMs: 2,
    requestAduHex: '001200000006010300000002',
    responseAduHex: '0012000000070103041234ABCD',
    result: 'ok', exceptionCode: null, mbapTransactionId: 18, summary: 'Read Holding 0–1',
  };
  useApp.setState({
    module: 'comm', toasts: [], commSlaveFilter: {},
    commResultFilter: { ok: true, timeout: true, exception: true, other: true },
    selection: { ...useApp.getState().selection, connectionId: 'conn-tcp', commView: 'messages' },
    snapshot: {
      revision: 1,
      workspace: workspaceSchema.parse(JSON.parse(fs.readFileSync('tools/e2e/demo.workspace.json', 'utf8'))),
      workspacePath: null, dirty: false, connections: {}, blocks: {}, points: {},
      transactions: [transaction], parseEvents: [], diagRev: 0, health: {}, recording: null,
      sessions: [], warnings: [], prefs: DEFAULT_PREFS, historyDbPath: '',
    },
  });
  render(<CommScreen />);
  const buttons = screen.getAllByRole('button', { name: '复制 Hex' });
  expect(buttons).toHaveLength(2);
  fireEvent.click(buttons[0]!);
  fireEvent.click(buttons[1]!);
  expect(writeText.mock.calls).toEqual([
    ['001200000006010300000002'],
    ['0012000000070103041234ABCD'],
  ]);
});
