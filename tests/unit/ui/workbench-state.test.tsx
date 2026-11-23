import React from 'react';
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AppStoreContext, appStore, createViewStore, useApp } from '../../../src/renderer/store/app';
import { templateWorkspace } from '../../support/template-workspace';
import { DEFAULT_PREFS } from '../../../src/main/services/workspace';
import type { AppSnapshot, BlockViewState } from '../../../src/shared/snapshot';

afterEach(cleanup);
it('updates communication status immediately while retaining a slow Host display snapshot', () => {
  const original = appStore.getState();
  const block: BlockViewState = { key: 's1::b2', slaveId: 's1', blockId: 'b2', blockName: '状态寄存器', area: 3, start: 100, length: 4, periodMs: 100, status: 'ok', exceptionCode: null, lastUpdateUtc: '2026-11-12T08:00:00.000Z', lastDurationMs: 1, revision: 1, registers: [42, 0, 0, 0] };
  const snapshot: AppSnapshot = { revision: 1, workspace: templateWorkspace(), workspacePath: null, dirty: false,
    connections: { c1: { state: 'online', detail: null, lastResponseUtc: null } }, blocks: { 's1::b2': block },
    points: { 's1::Keep': { slaveId: 's1', pointId: 'Keep', hasValue: true, finite: true, rawText: '42', engText: '42', rawNumber: 42, engNumber: 42, boolValue: null, stringValue: null, enumLabel: null } },
    transactions: [], parseEvents: [], diagRev: 0, health: {}, sessions: [], warnings: [], prefs: DEFAULT_PREFS, historyDbPath: '' };
  appStore.setState({ snapshot, api: null, dataEpoch: 0 });
  const view = createViewStore({ module: 'canvas', selection: { refreshMs: 10000 } });
  view.connect(); view.store.setState({ dataManaged: true });
  try {
    appStore.getState().applyDelta({ revision: 2, connections: { c1: { state: 'offline', detail: null, lastResponseUtc: null } }, blocks: { 's1::b2': { ...block, status: 'timeout', registers: undefined } } });
    const current = view.store.getState().snapshot!;
    expect(current.connections.c1!.state).toBe('offline');
    expect(current.blocks['s1::b2']!.status).toBe('timeout');
    expect(current.blocks['s1::b2']!.registers).toEqual([42, 0, 0, 0]);
    expect(current.points['s1::Keep']).toBe(snapshot.points['s1::Keep']);
    appStore.getState().applyDelta({ revision: 3, connections: { c1: { state: 'offline', detail: null, lastResponseUtc: '2026-11-12T08:00:01.000Z' } } });
    expect(view.store.getState().snapshot!.connections).toBe(current.connections);
  } finally { view.dispose(); appStore.setState(original); }
});
it('isolates selection and filters while all instances consume the exact same confirmed data', () => {
  const first = createViewStore({ module: 'realtime', selection: {} });
  const second = createViewStore({ module: 'realtime', selection: {} });
  first.connect(); second.connect();
  function Probe() {
    const selection = useApp(s => s.selection);
    const select = useApp(s => s.select);
    return <button onClick={() => select({ slaveId: 'device-A' })}>{selection.slaveId ?? 'choose'}</button>;
  }
  render(<><div data-testid="first"><AppStoreContext.Provider value={first.store}><Probe /></AppStoreContext.Provider></div><div data-testid="second"><AppStoreContext.Provider value={second.store}><Probe /></AppStoreContext.Provider></div></>);
  fireEvent.click(within(screen.getByTestId('first')).getByRole('button'));
  expect(within(screen.getByTestId('first')).getByRole('button')).toHaveTextContent('device-A');
  expect(within(screen.getByTestId('second')).getByRole('button')).toHaveTextContent('choose');
  act(() => { appStore.setState({ live: { shared: { samples: [[1, 42]], events: [] } } }); });
  expect(first.store.getState().live).toBe(second.store.getState().live);
  expect(first.store.getState().selection.slaveId).toBe('device-A');
  expect(second.store.getState().selection.slaveId).toBeNull();
  first.store.getState().select({ groupId: 'g1', trendWindowSec: 300 });
  second.store.getState().select({ groupId: 'g1' });
  expect(first.store.getState().selection.trendWindowSec).toBe(300);
  expect(second.store.getState().selection.trendWindowSec).toBeNull();
  first.store.getState().select({ groupId: 'g2' });
  expect(first.store.getState().selection.trendWindowSec).toBeNull();
  first.dispose(); second.dispose();
});
