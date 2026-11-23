import React from 'react';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BufferExportDialog } from '../../../src/renderer/features/buffers/buffer-ui';
import { appStore } from '../../../src/renderer/store/app';
import type { Command, CommandResult } from '../../../src/shared/commands';

afterEach(cleanup);
it('submits the edited millisecond range from native date input events and retains export errors', async () => {
  const calls = vi.fn();
  const first = Date.parse('2026-11-12T08:00:00.111Z');
  const last = Date.parse('2026-11-12T08:00:10.222Z');
  appStore.setState({ api: null, command: async <T,>(command: Command): Promise<CommandResult<T>> => {
    calls(command);
    if (command.type === 'data.read') return { ok: true, value: { buffers: { 's::p': { generation: 'g', capacity: 1000, count: 400, firstSeq: 1, lastSeq: 400, firstTimeMs: first, lastTimeMs: last, references: [] } } } as T };
    return { ok: false, error: '文件被占用' };
  } });
  render(<BufferExportDialog points={[{ slaveId: 's', pointId: 'p' }]} name="范围测试" />);
  await screen.findByText(/400 个样本/);
  fireEvent.click(screen.getByRole('checkbox', { name: '指定时间范围' }));
  const start = screen.getByLabelText('导出起始时间') as HTMLInputElement;
  // Native date widgets and browser automation can update the value tracker before input.
  start.value = '2026-11-12T08:00:09.222';
  fireEvent.input(start);
  const output = path.resolve('out/test-temp/range-test.csv');
  fireEvent.change(screen.getByLabelText('采样导出路径'), { target: { value: output } });
  fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }));
  await waitFor(() => expect(calls).toHaveBeenCalledWith({ type: 'buffer.export', points: [{ slaveId: 's', pointId: 'p' }], path: output, startMs: last - 1000, endMs: last }));
  expect(screen.getByRole('alert')).toHaveTextContent('文件被占用');
});
