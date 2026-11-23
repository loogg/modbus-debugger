import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useDiagnostics } from '../../../src/renderer/features/diagnostics/use-diagnostics';
import { appStore } from '../../../src/renderer/store/app';
import { DEFAULT_PREFS } from '../../../src/main/services/workspace';
import { emptyWorkspace } from '../../../src/domain/model';
import type { ModbusApi } from '../../../src/shared/preload-api';
import type { DiagnosticsPage } from '../../../src/shared/diagnostics';

const page: DiagnosticsPage = { generation: 'g', transactions: [], parseEvents: [], transactionCursor: 2, eventCursor: 0, throughTransactions: 2, throughEvents: 0, hasMore: false, overwritten: false, reset: false };
function setup() {
  const command = vi.fn(async () => ({ ok: true, value: page }));
  appStore.setState({ api: { command } as unknown as ModbusApi, dataEpoch: 0,
    snapshot: { revision: 1, workspace: emptyWorkspace(), workspacePath: null, dirty: false, connections: {}, blocks: {}, points: {}, transactions: [], parseEvents: [], diagRev: 0, health: {}, sessions: [], warnings: [], prefs: DEFAULT_PREFS, historyDbPath: '' } });
  return command;
}
afterEach(() => { cleanup(); appStore.setState({ api: null }); });

it('polls only enabled diagnostics pages and carries its independent cursor', async () => {
  const command = setup();
  const { rerender } = renderHook(({ enabled }) => useDiagnostics('c', enabled), { initialProps: { enabled: true } });
  await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(command).toHaveBeenCalledWith(expect.objectContaining({ afterTransactions: 2, generation: 'g' })));
  rerender({ enabled: false });
  const count = command.mock.calls.length;
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(command).toHaveBeenCalledTimes(count);
});

it('restarts its cursor after a diagnostics clear', async () => {
  const command = setup();
  renderHook(() => useDiagnostics('c'));
  await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
  command.mockClear();
  act(() => { const snapshot = appStore.getState().snapshot!; appStore.setState({ snapshot: { ...snapshot, diagRev: 1 } }); });
  await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
  expect(command.mock.calls[0]).toEqual([{ type: 'diagnostics.read', connectionId: 'c', limit: 500 }]);
});
