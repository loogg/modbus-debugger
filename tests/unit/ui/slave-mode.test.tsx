import React from 'react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApp } from '../../../src/renderer/store/app';
import { DevicesScreen } from '../../../src/renderer/screens/devices';
import { AddConnectionDialog } from '../../../src/renderer/features/devices/connection-dialog';
import { AddSlaveDialog } from '../../../src/renderer/features/devices/slave-dialog';
import { ValueCell } from '../../../src/renderer/components/value-cell';
import { DEFAULT_PREFS } from '../../../src/main/services/workspace';
import { slaveWorkspace } from '../../support/slave-workspace';
import type { Command, CommandResult } from '../../../src/shared/commands';

let calls: Command[];
beforeEach(() => {
  calls = [];
  useApp.setState({ overlay: null, toasts: [],
    selection: { ...useApp.getState().selection, connectionId: 'server', slaveId: null, deviceView: 'topology' },
    snapshot: { revision: 1, workspace: slaveWorkspace(), workspacePath: null, dirty: false,
      connections: { server: { state: 'offline', detail: null, lastResponseUtc: null, clientCount: 0 } },
      blocks: { 's1::b3': { key: 's1::b3', slaveId: 's1', blockId: 'b3', blockName: '区 3', area: 3, start: 0, length: 16, periodMs: 20, status: 'ok', exceptionCode: null, lastUpdateUtc: '2026-10-21T00:00:00Z', lastDurationMs: 0, revision: 1, registers: Array(16).fill(0) as number[] } },
      points: {}, transactions: [], parseEvents: [], diagRev: 0, health: {}, recording: null, sessions: [], warnings: [], prefs: DEFAULT_PREFS, historyDbPath: '' },
    command: async <T,>(command: Command): Promise<CommandResult<T>> => { calls.push(command); return { ok: true, value: (command.type === 'serial.list' ? [] : null) as T }; },
  });
});
afterEach(cleanup);

function choose(label: string, option: string) {
  const group = screen.getByRole('group', { name: label });
  fireEvent.keyDown(group.querySelector('[role="combobox"]')!, { key: 'ArrowDown' });
  fireEvent.click(screen.getByRole('option', { name: option }));
}

it('creates a TCP slave with a local bind address and hides master-only settings', async () => {
  render(<AddConnectionDialog />);
  choose('工作角色', '从站 / Server');
  fireEvent.click(screen.getByRole('button', { name: 'TCP' }));
  expect(screen.getByRole('group', { name: '本机监听地址' }).querySelector('input')).toHaveValue('127.0.0.1');
  expect(screen.queryByTestId('timeout-input')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '创建连接' }));
  await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({ type: 'connection.upsert', connection: expect.objectContaining({ role: 'slave', transport: 'tcp', tcp: { host: '127.0.0.1', port: 502 } }) })));
}, 30000);

it('shows passive lifecycle controls and never offers scanner or temporary read on a slave connection', () => {
  render(<DevicesScreen />);
  expect(screen.getByRole('button', { name: '启动从站' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '扫描' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '临时读取' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '启动从站' }));
  expect(calls).toContainEqual({ type: 'connection.connect', connectionId: 'server' });
});

it('local memory keeps drafts separate from confirmed values, validates, and saves initial values', async () => {
  useApp.setState({ selection: { ...useApp.getState().selection, slaveId: 's1', deviceView: 'memory' } });
  render(<DevicesScreen />);
  choose('数据区 / 数据块', '区 3 · Holding Register (03) · 0–15');
  const input = screen.getByRole('textbox', { name: '地址 0 的设定值' });
  fireEvent.change(input, { target: { value: '65536' } }); fireEvent.keyDown(input, { key: 'Enter' });
  expect(screen.getByRole('alert')).toBeInTheDocument(); expect(calls).toEqual([]);
  fireEvent.change(input, { target: { value: '0x1234' } });
  expect(screen.getByTestId('slave-value-0')).toHaveTextContent('0');
  await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
  expect(calls).toContainEqual({ type: 'slave.setValues', slaveId: 's1', blockId: 'b3', offset: 0, values: [4660] });
  expect(screen.getByTestId('slave-value-0')).toHaveTextContent('0');
  const block = useApp.getState().snapshot!.blocks['s1::b3']!;
  act(() => useApp.getState().applyDelta({ revision: 2, blocks: { 's1::b3': { ...block, registers: [4660, ...Array<number>(15).fill(0)], revision: 2 } } }));
  expect(screen.getByTestId('slave-value-0')).toHaveTextContent('4660');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存为启动初始值' })); });
  expect(calls).toContainEqual({ type: 'slave.saveInitialValues', slaveId: 's1' });
}, 30000);

it('creates a usable template with all four memory areas from the add-slave dialog', async () => {
  render(<AddSlaveDialog connectionId="server" />);
  fireEvent.click(screen.getByRole('button', { name: '新建四区模板' }));
  await waitFor(() => expect(calls.some(command => command.type === 'template.add')).toBe(true));
  const command = calls.find(command => command.type === 'template.add');
  if (command?.type !== 'template.add') throw new Error('Missing template');
  expect(command.template.blocks.map(block => block.area)).toEqual([1, 2, 3, 4]);
  expect(command.template.points).toHaveLength(64);
  expect(command.template.points.filter(point => ['b1', 'b3'].some(suffix => point.blockId.endsWith(suffix))).every(point => point.access === 'ro')).toBe(true);
});

it('paginates the complete block without hiding the final address', () => {
  const snapshot = useApp.getState().snapshot!;
  const template = snapshot.workspace.templates[0]!;
  const block = { ...template.blocks.find(item => item.id === 'b3')!, length: 65 };
  useApp.setState({ selection: { ...useApp.getState().selection, slaveId: 's1', deviceView: 'memory' },
    snapshot: { ...snapshot, workspace: { ...snapshot.workspace, templates: [{ ...template, blocks: [block], points: template.points.filter(point => point.blockId === 'b3') }] },
      blocks: { 's1::b3': { ...snapshot.blocks['s1::b3']!, length: 65, registers: Array.from({ length: 65 }, (_, index) => index) } } } });
  render(<DevicesScreen />);
  expect(screen.getByTestId('slave-value-0')).toHaveTextContent('0');
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  expect(screen.getByTestId('slave-value-32')).toHaveTextContent('32');
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  expect(screen.getByTestId('slave-value-64')).toHaveTextContent('64');
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
});

it('finishes a local point edit when Main returns confirmed without waiting for a wire read-back', async () => {
  const snapshot = useApp.getState().snapshot!;
  const point = snapshot.workspace.templates[0]!.points.find(item => item.id === 'p3')!;
  useApp.setState({ writeStates: {}, command: async <T,>(command: Command): Promise<CommandResult<T>> => {
    calls.push(command); return { ok: true, value: { phase: 'confirmed', result: 'ok', exceptionCode: null } as T };
  } });
  render(<ValueCell point={point} view={{ slaveId: 's1', pointId: 'p3', rawText: '0', engText: '0', rawNumber: 0, engNumber: 0, boolValue: null, stringValue: null, enumLabel: null, hasValue: true, finite: true }} />);
  fireEvent.doubleClick(screen.getByText('0'));
  const input = screen.getByDisplayValue('0'); fireEvent.change(input, { target: { value: '42' } });
  await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
  expect(useApp.getState().writeStates['s1::p3']?.phase).toBe('confirmed');
  expect(document.querySelector('.spin')).toBeNull();
});
