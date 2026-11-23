import React from 'react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DevicesScreen } from '../../../src/renderer/screens/devices';
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
      transactions: [], parseEvents: [], diagRev: 0, health: {}, sessions: [], warnings: [], prefs: DEFAULT_PREFS, historyDbPath: '',
    },
    command: async <T,>(cmd: Command): Promise<CommandResult<T>> => {
      calls.push(cmd);
      return { ok: true, value: (cmd.type === 'serial.list' ? [{ path: 'COM8', manufacturer: 'Test' }] : null) as T };
    },
  });
});
afterEach(cleanup);

it('retains inline connection drafts and submits their original baseline after another view changes the connection', async () => {
  useApp.setState({ selection: { ...useApp.getState().selection, connectionId: 'c1', slaveId: null, deviceView: 'topology' }, command: async <T,>(cmd: Command): Promise<CommandResult<T>> => { calls.push(cmd); return { ok: false, error: '此对象已被其他页面修改' }; } });
  render(<DevicesScreen />);
  const input = screen.getByRole('group', { name: '连接名称' }).querySelector('input')!;
  fireEvent.change(input, { target: { value: 'Local draft' } });
  act(() => {
    const snapshot = useApp.getState().snapshot!;
    useApp.setState({ snapshot: { ...snapshot, workspace: { ...snapshot.workspace, connections: [{ ...connection, name: 'Remote edit' }] } } });
  });
  expect(input).toHaveValue('Local draft');
  expect(screen.getByRole('alert')).toHaveTextContent('其他页面修改');
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({ type: 'connection.upsert', expected: connection, connection: expect.objectContaining({ name: 'Local draft' }) })));
  expect(input).toHaveValue('Local draft');
});

it('preserves all RTU settings when saving an existing connection', async () => {
  useApp.setState({ overlay: { kind: 'dialog', id: 'add-connection', connectionId: 'c1' } });
  render(<Overlays />);
  expect(screen.getByTestId('port-combo')).toHaveValue('COM7');
  expect(screen.getByTestId('baud-combo')).toHaveValue('19200');
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
  await waitFor(() => expect(calls).toContainEqual({ type: 'connection.upsert', connection: { ...connection, retryDelayMs: 50, connectTimeoutMs: 3000, reconnectIntervalMs: 1000 }, expected: connection }));
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

it.each([0, 75])('saves a %i ms retry delay through the connection dialog', async delay => {
  useApp.setState({ overlay: { kind: 'dialog', id: 'add-connection', connectionId: 'c1' } });
  render(<Overlays />);
  fireEvent.change(screen.getByRole('spinbutton', { name: '重试间隔 (ms)' }), { target: { value: String(delay) } });
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
  await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({
    type: 'connection.upsert', expected: connection, connection: expect.objectContaining({ retryDelayMs: delay }),
  })));
});

it('blocks invalid retry delays and recovers when zero is entered', () => {
  useApp.setState({ overlay: { kind: 'dialog', id: 'add-connection' } });
  render(<Overlays />);
  const input = screen.getByRole('spinbutton', { name: '重试间隔 (ms)' });
  for (const value of ['', '-1', '0.5', '60001']) {
    fireEvent.change(input, { target: { value } });
    expect(screen.getByRole('alert')).toHaveTextContent('0–60000');
    expect(screen.getByRole('button', { name: '创建连接' })).toBeDisabled();
  }
  fireEvent.change(input, { target: { value: '0' } });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '创建连接' })).toBeEnabled();
});

it('edits retry delay inline and locks it while the connection is online', async () => {
  useApp.setState({ selection: { ...useApp.getState().selection, connectionId: 'c1', slaveId: null, deviceView: 'topology' } });
  render(<DevicesScreen />);
  const input = screen.getByRole('spinbutton', { name: '重试间隔 (ms)' });
  expect(input).toHaveValue(50);
  fireEvent.change(input, { target: { value: '125' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({
    type: 'connection.upsert', connection: expect.objectContaining({ retryDelayMs: 125 }),
  })));
  act(() => {
    const snapshot = useApp.getState().snapshot!;
    useApp.setState({ snapshot: { ...snapshot, connections: { c1: { state: 'online', detail: null, lastResponseUtc: null } } } });
  });
  expect(input).toBeDisabled();
});

it.each(['dialog', 'inline'])('allows switching to a slave after an invalid hidden retry draft in the %s form', async form => {
  if (form === 'dialog') {
    useApp.setState({ overlay: { kind: 'dialog', id: 'add-connection', connectionId: 'c1' } });
    render(<Overlays />);
  } else {
    useApp.setState({ selection: { ...useApp.getState().selection, connectionId: 'c1', slaveId: null, deviceView: 'topology' } });
    render(<DevicesScreen />);
  }
  fireEvent.change(screen.getByRole('spinbutton', { name: '重试间隔 (ms)' }), { target: { value: '-1' } });
  const role = screen.getByRole('group', { name: '工作角色' }).querySelector('[role="combobox"]')!;
  fireEvent.keyDown(role, { key: 'ArrowDown' });
  fireEvent.click(screen.getByRole('option', { name: '从站 / Server' }));
  fireEvent.click(screen.getByRole('button', { name: form === 'dialog' ? '保存修改' : '保存' }));
  await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({
    type: 'connection.upsert', connection: expect.objectContaining({ role: 'slave', retryDelayMs: 50 }),
  })));
});

it.each(['dialog', 'inline'])('saves separate connection timing values in the %s form', async form => {
  if (form === 'dialog') {
    useApp.setState({ overlay: { kind: 'dialog', id: 'add-connection', connectionId: 'c1' } });
    render(<Overlays />);
  } else {
    useApp.setState({ selection: { ...useApp.getState().selection, connectionId: 'c1', slaveId: null, deviceView: 'topology' } });
    render(<DevicesScreen />);
  }
  fireEvent.change(screen.getByRole('spinbutton', { name: '连接超时 (ms)' }), { target: { value: '250' } });
  fireEvent.change(screen.getByRole('spinbutton', { name: '重连间隔 (ms)' }), { target: { value: '0' } });
  fireEvent.click(screen.getByRole('button', { name: form === 'dialog' ? '保存修改' : '保存' }));
  await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({
    type: 'connection.upsert', connection: expect.objectContaining({ timeoutMs: 750, connectTimeoutMs: 250, reconnectIntervalMs: 0 }),
  })));
});

it('validates timing ranges and ignores an inactive reconnect draft under manual policy', () => {
  useApp.setState({ overlay: { kind: 'dialog', id: 'add-connection' } });
  render(<Overlays />);
  const timeout = screen.getByRole('spinbutton', { name: '连接超时 (ms)' });
  const interval = screen.getByRole('spinbutton', { name: '重连间隔 (ms)' });
  for (const value of ['', '0', '0.5', '60001']) {
    fireEvent.change(timeout, { target: { value } });
    expect(screen.getByRole('button', { name: '创建连接' })).toBeDisabled();
  }
  fireEvent.change(timeout, { target: { value: '3000' } });
  fireEvent.change(interval, { target: { value: '-1' } });
  expect(screen.getByRole('alert')).toHaveTextContent('重连间隔');
  const policy = screen.getByRole('group', { name: '重连策略' }).querySelector('[role="combobox"]')!;
  fireEvent.keyDown(policy, { key: 'ArrowDown' });
  fireEvent.click(screen.getByRole('option', { name: '手动' }));
  expect(interval).toBeDisabled();
  expect(screen.getByRole('button', { name: '创建连接' })).toBeEnabled();
});

it('allows cancelling a pending connection before its configured timeout', async () => {
  let finishConnect: (() => void) | undefined;
  useApp.setState({
    selection: { ...useApp.getState().selection, connectionId: 'c1', slaveId: null, deviceView: 'topology' },
    command: async <T,>(cmd: Command): Promise<CommandResult<T>> => {
      calls.push(cmd);
      if (cmd.type === 'connection.connect') return new Promise(resolve => { finishConnect = () => resolve({ ok: true, value: null as T }); });
      return { ok: true, value: null as T };
    },
  });
  render(<DevicesScreen />);
  fireEvent.click(screen.getByRole('button', { name: '连接' }));
  act(() => {
    const snapshot = useApp.getState().snapshot!;
    useApp.setState({ snapshot: { ...snapshot, connections: { c1: { state: 'connecting', detail: null, lastResponseUtc: null } } } });
  });
  expect(screen.getByRole('button', { name: '断开连接' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '断开连接' }));
  await waitFor(() => expect(calls).toContainEqual({ type: 'connection.disconnect', connectionId: 'c1' }));
  await act(async () => { finishConnect?.(); });
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

it('never reports an out-of-range or fractional Unit ID as available', () => {
  useApp.setState({ overlay: { kind: 'dialog', id: 'add-slave', connectionId: 'c1' } });
  render(<Overlays />);
  const unit = screen.getByRole('group', { name: '从站地址 (Unit ID)' }).querySelector('input')!;
  for (const value of ['0', '248', '1.5', '']) {
    fireEvent.change(unit, { target: { value } });
    expect(screen.getByRole('alert')).toHaveTextContent('Unit ID 必须为 1–247 的整数');
    expect(screen.getByRole('button', { name: '添加从站' })).toBeDisabled();
  }
});
