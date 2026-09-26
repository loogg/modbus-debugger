import React from 'react';
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { DevicesScreen } from '../../../src/renderer/screens/devices';
import { useApp } from '../../../src/renderer/store/app';
import { DEFAULT_PREFS } from '../../../src/main/services/workspace';
import { templateWorkspace } from '../../support/template-workspace';

afterEach(cleanup);

it('defaults to the first slave only without a selection and preserves an explicit choice across deltas', () => {
  useApp.setState({
    module: 'devices',
    selection: { ...useApp.getState().selection, connectionId: null, slaveId: null, deviceView: 'topology' },
    snapshot: {
      revision: 1, workspace: templateWorkspace(), workspacePath: null, dirty: false,
      connections: {}, blocks: {}, points: {}, transactions: [], parseEvents: [], diagRev: 0,
      health: {}, recording: null, sessions: [], warnings: [], prefs: DEFAULT_PREFS, historyDbPath: '',
    },
  });
  render(<DevicesScreen />);
  expect(screen.getByRole('heading', { name: 'A1' })).toBeTruthy();
  act(() => useApp.getState().select({ connectionId: 'c1', slaveId: 's2' }));
  expect(screen.getByRole('heading', { name: 'A2' })).toBeTruthy();
  act(() => useApp.getState().applyDelta({ revision: 2, points: {} }));
  expect(screen.getByRole('heading', { name: 'A2' })).toBeTruthy();
});
