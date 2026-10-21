import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { HistoryScreen } from '../../../src/renderer/screens/history';
import { useApp } from '../../../src/renderer/store/app';
import { emptyWorkspace } from '../../../src/domain/model';
import { DEFAULT_PREFS } from '../../../src/main/services/workspace';

vi.mock('../../../src/renderer/components/chart', () => ({ NumericChart: () => null }));
const originalCommand = useApp.getState().command;
afterEach(() => { cleanup(); useApp.setState({ command: originalCommand }); });

it('makes samples beyond 500 reachable, identifies both sources, and resets paging on session change', async () => {
  const schema = ['master', 'slave'].map((id) => ({
    signalId: id, pointName: 'Pressure', rawType: 'Float64', unit: 'bar', decimalPlaces: 3,
    recordMode: 'samples', enumMap: {}, connectionName: id === 'master' ? '主站连接' : '从站连接', slaveName: 'Unit 1', blockName: 'HR',
  }));
  const sessions = ['large', 'small'].map(id => ({ id, groupId: id, groupName: id, slaveNames: ['Unit 1'], startUtc: '2026-10-21T00:00:00Z', endUtc: '2026-10-21T00:00:01Z', status: 'completed' as const, signalCount: 2, sampleCount: id === 'large' ? 502 : 1, eventCount: 0, sizeBytes: 0 }));
  useApp.setState({
    selection: { ...useApp.getState().selection, sessionId: 'large', historyTab: 'data' },
    command: async <T,>(cmd: Parameters<typeof originalCommand>[0]) => {
      const large = cmd.type === 'history.sessionData' && cmd.sessionId === 'large';
      return { ok: true, value: { detail: { ...sessions[large ? 0 : 1], schema }, samples: Array.from({ length: large ? 502 : 1 }, (_, i) => ({ signalId: i % 2 ? 'slave' : 'master', tMs: i * 1000, value: i === 501 ? 9876.543 : i })), events: [], rawComm: [] } as T };
    },
    snapshot: { revision: 1, workspace: emptyWorkspace(), workspacePath: null, dirty: false, connections: {}, blocks: {}, points: {}, transactions: [], parseEvents: [], diagRev: 0, health: {}, recording: null, warnings: [], prefs: DEFAULT_PREFS, historyDbPath: '', sessions },
  });
  render(<HistoryScreen />);
  expect(await screen.findByText('第 1 / 2 页 · 共 502 个数值样本 · 每页 500 条')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
  expect(screen.queryByText('9876.543')).toBeNull();
  const rows = screen.getAllByRole('row');
  expect(within(rows[1]!).getByText('主站连接 / Unit 1')).toBeInTheDocument();
  expect(within(rows[2]!).getByText('从站连接 / Unit 1')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  expect(screen.getByText('9876.543')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '上一页' }));
  expect(screen.queryByText('9876.543')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  useApp.getState().select({ sessionId: 'small' });
  expect(await screen.findByText('第 1 / 1 页 · 共 1 个数值样本 · 每页 500 条')).toBeInTheDocument();
  expect(screen.getAllByRole('row')).toHaveLength(2);
});
