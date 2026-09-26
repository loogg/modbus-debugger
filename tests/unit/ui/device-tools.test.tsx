import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ScanView, TempReadView } from '../../../src/renderer/screens/devices';
import { useApp } from '../../../src/renderer/store/app';
import { emptyWorkspace } from '../../../src/domain/model';
import { DEFAULT_PREFS } from '../../../src/main/services/workspace';
import type { AppSnapshot, ScanStateView } from '../../../src/shared/snapshot';
import type { Command, CommandResult } from '../../../src/shared/commands';

const snapshot = (): AppSnapshot => ({
  revision: 1, workspace: { ...emptyWorkspace(), connections: [{
    id: 'c1', name: 'TCP', transport: 'tcp', tcp: { host: '127.0.0.1', port: 502 },
    timeoutMs: 500, retries: 2, reconnect: 'manual', interFrameMs: 0, rtsControl: 'none', logLevel: 'info',
  }] },
  workspacePath: null, dirty: false, connections: { c1: { state: 'online', detail: null, lastResponseUtc: null } },
  blocks: {}, points: {}, transactions: [], parseEvents: [], diagRev: 0, health: {}, recording: null,
  sessions: [], warnings: [], prefs: DEFAULT_PREFS, historyDbPath: '',
});
const scanState = (phase: ScanStateView['phase']): ScanStateView => ({
  options: { fc: 3, start: 0, timeoutMs: 150, retries: 2 },
  phase, from: 1, to: 247, currentUnit: 2, checked: 1,
  found: [{ unitId: 1, responseMs: 3, exceptionCode: 2 }], elapsedMs: 100,
});
const publish = (scan: ScanStateView) => useApp.getState().applyDelta({
  revision: (useApp.getState().snapshot?.revision ?? 0) + 1,
  connections: { c1: { state: 'online', detail: null, lastResponseUtc: null, scan } },
});
let calls: Command[];
beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  calls = [];
  useApp.setState({ snapshot: snapshot(), command: async <T,>(cmd: Command): Promise<CommandResult<T>> => {
    calls.push(cmd);
    return { ok: true, value: null as T };
  } });
});
afterEach(cleanup);

function selectSetting(label: string, optionText: RegExp): void {
  const group = [...document.querySelectorAll('[role="group"]')].find(node => node.firstElementChild?.textContent === label);
  const trigger = group?.querySelector('[role="combobox"]');
  expect(trigger).toBeTruthy();
  fireEvent.keyDown(trigger!, { key: 'ArrowDown' });
  const option = [...document.querySelectorAll('[role="option"]')].find(node => optionText.test(node.textContent ?? ''));
  expect(option).toBeTruthy();
  fireEvent.click(option!);
}

describe('device tools', () => {
  it('range presets only update the draft until Start sends the selected range', async () => {
    render(<ScanView connectionId="c1" />);
    for (const [label, end] of [['1~16', '16'], ['1~32', '32'], ['1~64', '64'], ['1~247', '247']] as const) {
      fireEvent.click(screen.getByRole('button', { name: label }));
      expect(screen.getByTestId('scan-from')).toHaveValue(1);
      expect(screen.getByTestId('scan-to')).toHaveValue(Number(end));
      expect(calls).toHaveLength(0);
    }
    fireEvent.click(screen.getByRole('button', { name: '1~64' }));
    fireEvent.click(screen.getByRole('button', { name: '开始扫描' }));
    await waitFor(() => expect(calls).toEqual([expect.objectContaining({
      type: 'device.scan', connectionId: 'c1', from: 1, to: 64,
      options: { fc: 3, start: 0, timeoutMs: 150, retries: undefined },
    })]));
  });

  it('keeps advanced settings collapsed by default and sends the default probe', async () => {
    render(<ScanView connectionId="c1" />);
    expect(screen.getByText('高级扫描配置').closest('details')?.open).toBe(false);
    expect(screen.getByText('FC03 · Start 0 · Qty 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '开始扫描' }));
    await waitFor(() => expect(calls[0]).toMatchObject({
      type: 'device.scan', options: { fc: 3, start: 0, timeoutMs: 150, retries: undefined },
    }));
  });

  it('expands, edits and submits advanced settings even after collapsing them again', async () => {
    render(<ScanView connectionId="c1" />);
    const summary = screen.getByText('高级扫描配置');
    fireEvent.click(summary);
    expect(summary.closest('details')?.open).toBe(true);
    selectSetting('读取功能码', /FC04/);
    fireEvent.change(screen.getByRole('spinbutton', { name: '起始地址（0-based）' }), { target: { value: '123' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: '单次超时（ms）' }), { target: { value: '500' } });
    selectSetting('重试', /^0 次$/);
    expect(screen.getByText('FC04 · Start 123 · Qty 1')).toBeTruthy();
    fireEvent.click(summary);
    expect(summary.closest('details')?.open).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '开始扫描' }));
    await waitFor(() => expect(calls[0]).toMatchObject({
      type: 'device.scan', options: { fc: 4, start: 123, timeoutMs: 500, retries: 0 },
    }));
    expect(useApp.getState().snapshot?.workspace.connections[0]?.retries).toBe(2);
  });

  it('rejects empty or out-of-range probe settings without sending a request', () => {
    render(<ScanView connectionId="c1" />);
    fireEvent.click(screen.getByText('高级扫描配置'));
    const start = screen.getByRole('spinbutton', { name: '起始地址（0-based）' });
    const timeout = screen.getByRole('spinbutton', { name: '单次超时（ms）' });
    for (const invalid of ['', '-1', '65536', '0.5']) {
      fireEvent.change(start, { target: { value: invalid } });
      expect(screen.getByRole('button', { name: '开始扫描' })).toBeDisabled();
    }
    fireEvent.change(start, { target: { value: '65535' } });
    for (const invalid of ['', '0', '10001']) {
      fireEvent.change(timeout, { target: { value: invalid } });
      expect(screen.getByRole('button', { name: '开始扫描' })).toBeDisabled();
    }
    expect(calls).toHaveLength(0);
  });

  it('shows Main probe settings after remount and locks them while stopping', () => {
    publish({ ...scanState('stopping'), options: { fc: 2, start: 88, timeoutMs: 600, retries: 0 } });
    render(<ScanView connectionId="c1" />);
    expect(screen.getByText('FC02 · Start 88 · Qty 1')).toBeTruthy();
    fireEvent.click(screen.getByText('高级扫描配置'));
    expect(screen.getByRole('spinbutton', { name: '起始地址（0-based）' })).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: '单次超时（ms）' })).toBeDisabled();
    for (const select of screen.getAllByRole('combobox')) expect(select).toBeDisabled();
    expect(screen.getByRole('button', { name: '正在停止…' })).toBeDisabled();
  });

  it('defaults temporary reads to 10 and sends that quantity', async () => {
    useApp.setState({ command: async <T,>(cmd: Command): Promise<CommandResult<T>> => {
      calls.push(cmd);
      return { ok: false, error: 'test device unavailable' };
    } });
    render(<TempReadView connectionId="c1" />);
    expect((screen.getByRole('spinbutton', { name: '数量（寄存器）' }) as HTMLInputElement).value).toBe('10');
    expect(screen.getByText('FC03 · Start 0 · Qty 10')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '读取' }));
    await waitFor(() => expect(calls[0]).toMatchObject({ type: 'device.temporaryRead', quantity: 10 }));
  });

  it('shows a running Main scan after remount, stops via IPC, and retains partial results', async () => {
    publish(scanState('running'));
    const view = render(<ScanView connectionId="c1" />);
    expect(screen.getAllByText('2 次').length).toBeGreaterThan(0);
    expect(screen.getByText('异常响应 0x02')).toBeTruthy();
    expect((screen.getByTestId('scan-from') as HTMLInputElement).disabled).toBe(true);
    view.unmount();
    render(<ScanView connectionId="c1" />);
    fireEvent.click(screen.getByRole('button', { name: '停止扫描' }));
    await waitFor(() => expect(calls).toContainEqual({ type: 'device.stopScan', connectionId: 'c1' }));
    expect((screen.getByRole('button', { name: '正在停止…' }) as HTMLButtonElement).disabled).toBe(true);
    act(() => publish({ ...scanState('stopped'), currentUnit: null }));
    expect(screen.getByText('扫描已停止')).toBeTruthy();
    expect(screen.getByText('已发现 1 个从站')).toBeTruthy();
    expect(screen.getByRole('button', { name: '开始扫描' })).toBeTruthy();
  });

  it('blocks inverted ranges and releases the start button after a failed command', async () => {
    useApp.setState({ command: vi.fn().mockRejectedValue(new Error('IPC unavailable')) });
    render(<ScanView connectionId="c1" />);
    fireEvent.change(screen.getByTestId('scan-from'), { target: { value: '20' } });
    fireEvent.change(screen.getByTestId('scan-to'), { target: { value: '10' } });
    expect((screen.getByRole('button', { name: '开始扫描' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('scan-to'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: '开始扫描' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('IPC unavailable'));
    expect((screen.getByRole('button', { name: '开始扫描' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
