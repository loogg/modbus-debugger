import React from 'react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Overlays } from '../../../src/renderer/screens/overlays';
import { useApp } from '../../../src/renderer/store/app';
import { emptyWorkspace } from '../../../src/domain/model';
import { DEFAULT_PREFS } from '../../../src/main/services/workspace';
import type { Command, CommandResult } from '../../../src/shared/commands';

const connection = {
  id: 'c1', name: 'Line A', transport: 'rtu' as const,
  rtu: { port: 'COM7', baudRate: 19200, dataBits: 7 as const, parity: 'even' as const, stopBits: 2 as const },
  timeoutMs: 750, retries: 2, reconnect: 'auto' as const, interFrameMs: 15,
  rtsControl: 'toggle' as const, logLevel: 'debug' as const,
};
let calls: Command[];

beforeEach(() => {
  calls = [];
  useApp.setState({
    overlay: null,
    snapshot: {
      revision: 1,
      workspace: { ...emptyWorkspace(), connections: [connection] },
      workspacePath: null, dirty: false, connections: {}, blocks: {}, points: {},
      transactions: [], parseEvents: [], diagRev: 0, health: {}, recording: null,
      sessions: [], warnings: [], prefs: DEFAULT_PREFS, historyDbPath: '',
    },
    command: async <T,>(cmd: Command): Promise<CommandResult<T>> => {
      calls.push(cmd);
      return { ok: true, value: (cmd.type === 'serial.list' ? [{ path: 'COM8', manufacturer: 'Test' }] : null) as T };
    },
  });
});
afterEach(cleanup);

it('preserves all RTU settings when saving an existing connection', async () => {
  useApp.setState({ overlay: { kind: 'dialog', id: 'add-connection', connectionId: 'c1' } });
  render(<Overlays />);
  expect(screen.getByTestId('port-combo')).toHaveValue('COM7');
  expect(screen.getByTestId('baud-combo')).toHaveValue('19200');
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
  await waitFor(() => expect(calls).toContainEqual({ type: 'connection.upsert', connection }));
  expect(useApp.getState().overlay).toBeNull();
});

it('creates a TCP connection through the typed command', async () => {
  useApp.setState({ overlay: { kind: 'dialog', id: 'add-connection' } });
  render(<Overlays />);
  fireEvent.click(screen.getByRole('button', { name: 'TCP' }));
  fireEvent.change(screen.getByRole('group', { name: '主机' }).querySelector('input')!, { target: { value: '10.0.0.5' } });
  fireEvent.click(screen.getByRole('button', { name: '创建连接' }));
  await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({
    type: 'connection.upsert',
    connection: expect.objectContaining({ transport: 'tcp', tcp: { host: '10.0.0.5', port: 502 } }),
  })));
});

it('defaults to a free Unit ID and blocks a duplicate before saving', async () => {
  const snapshot = useApp.getState().snapshot!;
  useApp.setState({
    snapshot: { ...snapshot, workspace: { ...snapshot.workspace, slaves: [{ id: 's1', connectionId: 'c1', unitId: 1, name: 'Existing', templateId: '', enabled: true }] } },
    overlay: { kind: 'dialog', id: 'add-slave', connectionId: 'c1' },
  });
  render(<Overlays />);
  const unit = screen.getByRole('group', { name: '从站地址 (Unit ID)' }).querySelector('input')!;
  expect(unit).toHaveValue(2);
  fireEvent.change(unit, { target: { value: '1' } });
  expect(screen.getByText('Unit ID 1 已被占用')).toBeTruthy();
  expect(screen.getByRole('button', { name: '添加从站' })).toBeDisabled();
  fireEvent.change(unit, { target: { value: '3' } });
  fireEvent.click(screen.getByRole('button', { name: '添加从站' }));
  await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({
    type: 'slave.upsert', slave: expect.objectContaining({ connectionId: 'c1', unitId: 3 }),
  })));
});
