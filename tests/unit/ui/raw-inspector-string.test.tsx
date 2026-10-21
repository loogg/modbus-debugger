import React from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Overlays } from '../../../src/renderer/screens/overlays';
import { useApp } from '../../../src/renderer/store/app';
import { DEFAULT_PREFS } from '../../../src/main/services/workspace';
import { loopbackWorkspace } from '../../support/loopback-workspace';

afterEach(cleanup);
it('shows the complete String memory beyond four registers without inventing a new request', () => {
  const registers = Array<number>(125).fill(0);
  registers.splice(60, 6, 0x4142, 0x4344, 0x4546, 0x4748, 0x494a, 0x4b4c);
  useApp.setState({
    selection: { ...useApp.getState().selection, slaveId: 'tcp-master-1' },
    overlay: { kind: 'drawer', id: 'inspector', pointId: 'UTF8-holding' },
    snapshot: { revision: 1, workspace: loopbackWorkspace({ tcpPort: 15030, transports: ['tcp'] }), workspacePath: null, dirty: false,
      connections: {}, blocks: { key: { key: 'tcp-master-1::holding', slaveId: 'tcp-master-1', blockId: 'holding', blockName: 'holding', area: 3, start: 100, length: 125, periodMs: 800, status: 'ok', exceptionCode: null, lastUpdateUtc: '2026-10-21T00:00:00Z', lastDurationMs: 1, revision: 1, registers } },
      points: {}, transactions: [], parseEvents: [], diagRev: 0, health: {}, recording: null, sessions: [], warnings: [], prefs: DEFAULT_PREFS, historyDbPath: '' },
  });
  render(<Overlays />);
  expect(screen.getByText('0x494A')).toBeInTheDocument();
  expect(screen.getByText('0x4B4C')).toBeInTheDocument();
  expect(screen.getByText(/字节：41 42 43 44 45 46 47 48 49 4A 4B 4C/)).toBeInTheDocument();
  expect(screen.getByText(/来自 Block Cache，不额外请求设备/)).toBeInTheDocument();
  expect(screen.getByText('UTF-8 文本 · 12 字节 · 短文本以零填充')).toBeInTheDocument();
  expect(screen.queryByText(/显示：工程值 = Raw/)).toBeNull();
});
