import React from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HistorySidebar } from '../../../src/renderer/shell';
import { useApp } from '../../../src/renderer/store/app';
import { emptyWorkspace } from '../../../src/domain/model';
import { DEFAULT_PREFS } from '../../../src/main/services/workspace';
afterEach(cleanup);
it('history date, group, slave and clear filters change the actual session cards', () => {
  useApp.setState({ snapshot: { revision: 1, workspace: emptyWorkspace(), workspacePath: null, dirty: false, connections: {}, blocks: {}, points: {}, transactions: [], parseEvents: [], diagRev: 0, health: {}, recording: null, warnings: [], prefs: DEFAULT_PREFS, historyDbPath: '', sessions: [
    { id: 'a', groupId: 'g1', groupName: 'Group1', slaveNames: ['Pump1'], startUtc: '2020-01-02T00:00:00Z', endUtc: '2020-01-02T00:00:01Z', status: 'completed', signalCount: 1, sampleCount: 1, eventCount: 0, sizeBytes: 0 },
    { id: 'b', groupId: 'g2', groupName: 'Group2', slaveNames: ['Pump2'], startUtc: '2021-01-02T00:00:00Z', endUtc: '2021-01-02T00:00:01Z', status: 'completed', signalCount: 1, sampleCount: 1, eventCount: 0, sizeBytes: 0 },
  ] } });
  render(<HistorySidebar />);
  const ids = () => [...document.querySelectorAll('[data-session-id]')].map(el => el.getAttribute('data-session-id'));
  expect(ids()).toEqual(['a','b']);
  fireEvent.change(screen.getByLabelText('历史起始日期'), { target: { value: '2021-01-01' } }); expect(ids()).toEqual(['b']);
  fireEvent.change(screen.getByLabelText('历史结束日期'), { target: { value: '2020-12-31' } }); expect(ids()).toEqual([]);
  fireEvent.click(screen.getByText('清除筛选')); expect(ids()).toEqual(['a','b']);
  fireEvent.change(screen.getByLabelText('历史趋势组'), { target: { value: 'g1' } }); expect(ids()).toEqual(['a']);
  fireEvent.change(screen.getByLabelText('历史从站筛选'), { target: { value: 'Pump2' } }); expect(ids()).toEqual([]);
  fireEvent.click(screen.getByText('清除筛选')); expect(ids()).toEqual(['a','b']);
});
