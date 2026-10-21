import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CommScreen } from '../../../src/renderer/screens/comm';
import { useApp } from '../../../src/renderer/store/app';
import { DEFAULT_PREFS } from '../../../src/main/services/workspace';
import { loopbackWorkspace } from '../../support/loopback-workspace';

vi.mock('../../../src/renderer/components/chart', () => ({ NumericChart: () => null }));
const originalCommand = useApp.getState().command;
afterEach(() => { cleanup(); vi.restoreAllMocks(); useApp.setState({ command: originalCommand }); });

it('keeps shared-template health rows distinct, displays real Unit IDs, and opens their block', () => {
  const errors = vi.spyOn(console, 'error');
  const workspace = loopbackWorkspace({ tcpPort: 15030, transports: ['tcp'] });
  const slaves = workspace.slaves.filter(slave => slave.connectionId === 'tcp-master');
  slaves[0]!.id = 'random-instance-alpha'; slaves[1]!.id = 'random-instance-beta';
  const blocks = slaves.map(slave => ({ slaveId: slave.id, blockId: 'holding', blockName: 'HR', configuredPeriodMs: 800, actualPeriodMs: 803, p95Ms: 2, timeoutRate: 0 }));
  useApp.setState({
    module: 'comm', selection: { ...useApp.getState().selection, connectionId: 'tcp-master', commView: 'health' },
    command: async <T,>() => ({ ok: true, value: [] as T }),
    snapshot: { revision: 1, workspace, workspacePath: null, dirty: false, connections: {}, blocks: {}, points: {}, transactions: [], parseEvents: [], diagRev: 0,
      health: { 'tcp-master': { connectionId: 'tcp-master', busLoadPercent: 5, requestRatePerSec: 1, p50Ms: 1, p95Ms: 2, timeouts: 0, crcErrors: 0, exceptions: 0, unexpected: 0, windowSec: 60, blocks } },
      recording: null, warnings: [], prefs: DEFAULT_PREFS, historyDbPath: '', sessions: [] },
  });
  render(<CommScreen />);
  expect(screen.getByText('从站 1 / HR')).toBeInTheDocument();
  expect(screen.getByText('从站 2 / HR')).toBeInTheDocument();
  expect(screen.getAllByRole('row')).toHaveLength(3);
  expect(errors.mock.calls.flat().join(' ')).not.toContain('same key');
  fireEvent.click(screen.getAllByRole('button', { name: '打开模板' })[1]!);
  expect(useApp.getState().module).toBe('templates');
  expect(useApp.getState().selection).toMatchObject({ templateId: slaves[1]!.templateId, editBlockId: 'holding', templateEditing: true });
});
