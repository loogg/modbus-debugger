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
  phase, from: 1, to: 247, currentUnit: 2, checked: 1,
  found: [{ unitId: 1, responseMs: 3, exceptionCode: 2 }], elapsedMs: 100,
});
const publish = (scan: ScanStateView) => useApp.getState().applyDelta({
  revision: 1, connections: { c1: { state: 'online', detail: null, lastResponseUtc: null, scan } },
});
let calls: Command[];
beforeEach(() => {
  calls = [];
  useApp.setState({ snapshot: snapshot(), command: async <T,>(cmd: Command): Promise<CommandResult<T>> => {
    calls.push(cmd);
    return { ok: true, value: null as T };
  } });
});
afterEach(cleanup);

describe('device tools', () => {
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
    expect(screen.getByText('2 次')).toBeTruthy();
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
