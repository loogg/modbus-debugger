import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ScanView, TempReadView } from '../../../src/renderer/screens/devices';
import { useApp } from '../../../src/renderer/store/app';
import { emptyWorkspace } from '../../../src/domain/model';
import { DEFAULT_PREFS } from '../../../src/main/services/workspace';
import type { AppSnapshot } from '../../../src/shared/snapshot';
import type { RequestOutcome } from '../../../src/main/runtime/connection-runtime';

const outcome = (result: RequestOutcome['result'], exceptionCode: number | null = null): RequestOutcome => ({
  result, exceptionCode, response: result === 'ok' ? { kind: 'registers', fc: 3, registers: [7, 8] } : null,
  durationMs: 500, requestAduHex: '', responseAduHex: null, traceId: 'trace-test',
});
beforeEach(() => {
  const snapshot: AppSnapshot = {
    revision: 1, workspace: { ...emptyWorkspace(), connections: [{
      id: 'c1', name: 'TCP', transport: 'tcp', tcp: { host: '127.0.0.1', port: 502 },
      timeoutMs: 500, retries: 1, reconnect: 'manual', interFrameMs: 0, rtsControl: 'none', logLevel: 'info',
    }] },
    workspacePath: null, dirty: false, connections: { c1: { state: 'online', detail: null, lastResponseUtc: null } },
    blocks: {}, points: {}, transactions: [], parseEvents: [], diagRev: 0, health: {}, recording: null,
    sessions: [], warnings: [], prefs: DEFAULT_PREFS, historyDbPath: '',
  };
  useApp.setState({ snapshot, overlay: null, module: 'devices' });
});
afterEach(cleanup);

describe('temporary read feedback', () => {
  it('distinguishes checked slave addresses from discovered devices in scan progress', () => {
    useApp.getState().applyDelta({ revision: 1, connections: { c1: {
      state: 'online', detail: null, lastResponseUtc: null,
      scan: { phase: 'running', from: 1, to: 247, currentUnit: 5, checked: 4, found: [], elapsedMs: 1000,
        options: { fc: 3, start: 0, timeoutMs: 150, retries: 1 } },
    } } });
    render(<ScanView connectionId="c1" />);
    expect(screen.getByRole('status')).toHaveTextContent('已检查 4 / 247 个从站地址');
    expect(screen.getByRole('status')).toHaveTextContent('正在探测 Unit 5');
    expect(screen.getByRole('status')).toHaveTextContent('已发现 0 个从站');
  });
  it.each([
    ['timeout', null, '读取超时'], ['exception', 2, '设备返回异常 0x02：寄存器/位地址或读取范围无效'],
    ['exception', 1, '不支持此功能码'], ['exception', 99, '0x63'],
    ['transport', null, '连接或传输失败'], ['crc', null, 'CRC 校验失败'],
    ['malformed', null, '响应格式或长度不正确'], ['unexpected', null, '响应与本次请求不匹配'],
  ] as const)('shows persistent %s failure details and a diagnostics entry point', async (kind, code, message) => {
    useApp.setState({ command: vi.fn().mockResolvedValue({ ok: true, value: outcome(kind, code) }) });
    render(<TempReadView connectionId="c1" />);
    fireEvent.click(screen.getByRole('button', { name: '读取' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(message));
    expect(screen.getByRole('alert')).toHaveTextContent('Unit 1 · FC03 · Start 0 · Qty 10');
    expect(screen.getByRole('alert')).toHaveTextContent('trace-test');
    expect(screen.queryByText('读取成功')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看通信诊断' }));
    expect(useApp.getState().module).toBe('comm');
    expect(useApp.getState().selection).toMatchObject({ connectionId: 'c1', commView: 'messages' });
  });

  it('locks the request during reading and clears stale success data on a failed retry', async () => {
    const command = vi.fn().mockResolvedValueOnce({ ok: true, value: outcome('ok') });
    useApp.setState({ command });
    render(<TempReadView connectionId="c1" />);
    fireEvent.change(screen.getByRole('spinbutton', { name: '数量（寄存器）' }), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '读取' }));
    await screen.findByText('读取成功');
    let settle: (value: unknown) => void = () => undefined;
    command.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: '读取' }));
    expect(screen.getByRole('button', { name: '读取中…' })).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: '数量（寄存器）' })).toBeDisabled();
    expect(screen.queryByText('读取成功')).toBeNull();
    await act(async () => settle({ ok: true, value: outcome('timeout') }));
    expect(screen.getByRole('alert')).toHaveTextContent('读取超时');
    expect(screen.queryByText('保存为数据块')).toBeNull();
    command.mockResolvedValueOnce({ ok: true, value: outcome('ok') });
    fireEvent.click(screen.getByRole('button', { name: '读取' }));
    await screen.findByText('读取成功');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps successful data and save-as-block bound to the submitted request after editing fields', async () => {
    useApp.setState({ command: vi.fn().mockResolvedValue({ ok: true, value: outcome('ok') }) });
    render(<TempReadView connectionId="c1" />);
    fireEvent.change(screen.getByRole('spinbutton', { name: '数量（寄存器）' }), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '读取' }));
    await screen.findByText('读取成功');
    fireEvent.change(screen.getByRole('spinbutton', { name: '起始地址' }), { target: { value: '100' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: '从站' }), { target: { value: '2' } });
    expect(screen.getByText(/Unit 1 · 2 个寄存器 · 地址 0–1/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '保存为数据块' }));
    expect(useApp.getState().overlay).toMatchObject({ id: 'save-as-block', unitId: 1, area: 3, start: 0, quantity: 2, registers: [7, 8] });
  });

  it.each([false, true])('surfaces command rejection or IPC failure and allows another attempt (%s)', async rejected => {
    const command = rejected ? vi.fn().mockRejectedValue(new Error('IPC unavailable')) : vi.fn().mockResolvedValue({ ok: false, error: 'Connection stopped' });
    useApp.setState({ command });
    render(<TempReadView connectionId="c1" />);
    fireEvent.click(screen.getByRole('button', { name: '读取' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(rejected ? 'IPC unavailable' : 'Connection stopped'));
    expect(screen.getByRole('button', { name: '读取' })).not.toBeDisabled();
  });

  it('explains offline and scanning states and never sends a read in either state', () => {
    const command = vi.fn();
    const snapshot = useApp.getState().snapshot!;
    useApp.setState({ command, snapshot: { ...snapshot, connections: { c1: { state: 'offline', detail: null, lastResponseUtc: null } } } });
    render(<TempReadView connectionId="c1" />);
    expect(screen.getByRole('button', { name: '读取' })).toBeDisabled();
    expect(screen.getByText('连接后才能临时读取')).toBeTruthy();
    act(() => useApp.getState().applyDelta({ revision: 1, connections: { c1: {
      state: 'online', detail: null, lastResponseUtc: null,
      scan: { phase: 'running', from: 1, to: 247, currentUnit: 5, checked: 4, found: [], elapsedMs: 500,
        options: { fc: 3, start: 0, timeoutMs: 150, retries: 1 } },
    } } }));
    expect(screen.getByText(/请先停止扫描/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '读取' })).toBeDisabled();
    expect(command).not.toHaveBeenCalled();
  });
});
