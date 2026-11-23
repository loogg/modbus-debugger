import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasWidgetView } from '../../../src/renderer/features/canvas/widget';
import { canvasWidgetSchema } from '../../../src/domain/canvas';
import { appStore } from '../../../src/renderer/store/app';
import { templateWorkspace } from '../../support/template-workspace';
import { DEFAULT_PREFS } from '../../../src/main/services/workspace';
import type { Command, CommandResult } from '../../../src/shared/commands';
import { Overlays } from '../../../src/renderer/screens/overlays';
import userEvent from '@testing-library/user-event';
import { lampConfigSchema, lampRuleSchema } from '../../../src/domain/canvas-lamp';
import { defaultWidgetPreview } from '../../../src/renderer/features/canvas/preview';
import { statusLampConfig } from '../../../src/renderer/features/canvas/status-lamp';

const calls = vi.fn();
const widget = canvasWidgetSchema.parse({ id: 'input', kind: 'input', label: '设定值', x: 0, y: 0, width: 240, height: 120, binding: { slaveId: 's1', pointId: 'Ia' } });
beforeEach(() => {
  calls.mockReset();
  const workspace = templateWorkspace(); workspace.slaves[0]!.enabled = true;
  appStore.setState({ overlay: null, toasts: [], writeStates: {}, live: {},
    command: async <T,>(command: Command) => { calls(command); return { ok: true, value: { phase: 'confirmed', result: 'ok', exceptionCode: null } as T }; },
    snapshot: { revision: 1, workspace, workspacePath: null, dirty: false, connections: { c1: { state: 'online', detail: null, lastResponseUtc: null } }, blocks: {}, points: { 's1::Ia': { pointId: 'Ia', slaveId: 's1', rawText: '12', engText: '12', finite: true, engNumber: 12, rawNumber: 12, boolValue: null, stringValue: null, enumLabel: null, hasValue: true } }, transactions: [], parseEvents: [], diagRev: 0, health: {}, sessions: [], warnings: [], prefs: DEFAULT_PREFS, historyDbPath: '' },
  });
});
afterEach(cleanup);

it('shows live communication lamps independently and applies a device-only delta', () => {
  const snapshot = appStore.getState().snapshot!;
  const second = { ...snapshot.workspace.slaves[0]!, id: 's2', unitId: 2 };
  appStore.setState({ snapshot: {
    ...snapshot,
    workspace: { ...snapshot.workspace, slaves: [snapshot.workspace.slaves[0]!, second] },
    slaveStates: {
      s1: { state: 'online', lastResponseUtc: '2026-11-18T00:00:00.000Z' },
      s2: { state: 'offline', lastResponseUtc: null },
    },
  } });
  const lamp = canvasWidgetSchema.parse({
    ...widget, kind: 'lamp', binding: { kind: 'slave-status', slaveId: 's1' }, lamp: statusLampConfig(), showStateText: true,
  });
  render(<>
    <CanvasWidgetView widget={lamp} editing={false} />
    <CanvasWidgetView widget={{ ...lamp, id: 'second', lamp: { ...lamp.lamp, mode: 'binary' }, binding: { kind: 'slave-status', slaveId: 's2' } }} editing={false} />
  </>);
  expect(screen.getByRole('img', { name: '在线' })).toBeInTheDocument();
  expect(screen.getByRole('img', { name: '离线' })).toBeInTheDocument();
  act(() => appStore.getState().applyDelta({ revision: 2, slaveStates: { s2: { state: 'online', lastResponseUtc: '2026-11-18T00:00:01.000Z' } } }));
  expect(screen.getAllByRole('img', { name: '在线' })).toHaveLength(2);
  act(() => appStore.getState().applyDelta({ revision: 3, slaveStates: { s2: { state: 'disabled', lastResponseUtc: null } } }));
  expect(screen.getByRole('img', { name: '停用' })).toBeInTheDocument();
  expect(calls).not.toHaveBeenCalled();
});

it('reports the initial Modbus read exception before any value is confirmed', () => {
  const snapshot = appStore.getState().snapshot!;
  const block = snapshot.workspace.templates[0]!.blocks.find(item => item.id === snapshot.workspace.templates[0]!.points.find(point => point.id === 'Ia')?.blockId)!;
  const key = `s1::${block.id}`;
  appStore.setState({ snapshot: {
    ...snapshot, points: {}, slaveStates: { s1: { state: 'online', lastResponseUtc: '2026-11-18T00:00:00.000Z' } },
    blocks: { [key]: { key, slaveId: 's1', blockId: block.id, blockName: block.name, area: block.area, start: block.start, length: block.length,
      periodMs: block.periodMs, status: 'exception', exceptionCode: 2, lastUpdateUtc: null, lastDurationMs: null, revision: 1 } },
  } });
  render(<CanvasWidgetView widget={{ ...widget, kind: 'value' }} editing={false} />);
  expect(screen.getByRole('status')).toHaveTextContent('读取异常 0x02');
  expect(screen.getByRole('status')).toHaveAttribute('title', expect.stringContaining('读取范围无效'));
  act(() => appStore.getState().applyDelta({ revision: 2, slaveStates: { s1: { state: 'offline', lastResponseUtc: null } } }));
  expect(screen.getByRole('status')).toHaveAccessibleName('离线');
});

it('allows the first write-only switch command and keeps it unchanged while pending or rejected', async () => {
  const snapshot = appStore.getState().snapshot!;
  const point = snapshot.workspace.templates[0]!.points.find(item => item.id === 'Flag')!;
  point.access = 'wo';
  let finish: (result: unknown) => void = () => undefined;
  appStore.setState({ command: async <T,>(command: Command) => {
    calls(command);
    return new Promise<CommandResult<T>>(resolve => { finish = result => resolve(result as CommandResult<T>); });
  } });
  const control = { ...widget, kind: 'switch' as const, binding: { slaveId: 's1', pointId: 'Flag' } };
  render(<CanvasWidgetView widget={control} editing={false} />);
  const toggle = screen.getByRole('switch', { name: '设定值' });
  expect(toggle).not.toBeDisabled();
  expect(toggle).toHaveAttribute('aria-checked', 'false');
  expect(screen.getByText('命令')).toBeInTheDocument();
  fireEvent.click(toggle);
  expect(calls).toHaveBeenCalledWith(expect.objectContaining({ type: 'point.write', boolValue: true }));
  expect(toggle).toBeDisabled();
  expect(toggle).toHaveAttribute('aria-checked', 'false');
  await act(async () => { finish({ ok: true, value: { phase: 'rejected', result: 'exception', exceptionCode: 1 } }); });
  expect(toggle).not.toBeDisabled();
  expect(toggle).toHaveAttribute('aria-checked', 'false');
  expect(screen.getByRole('status')).toHaveTextContent('设备不支持此功能码');
});

it('shows the last accepted write-only command separately from device values', () => {
  const snapshot = appStore.getState().snapshot!;
  snapshot.workspace.templates[0]!.points[0]!.access = 'wo';
  snapshot.points['s1::Ia'] = { ...snapshot.points['s1::Ia']!, hasValue: false, engNumber: null, engText: '—', lastWrite: {
    phase: 'unknown', attempted: '80', atMs: 1000, exceptionCode: null,
    accepted: { value: 45, engineering: 45, text: '45', atMs: 900 },
  } };
  render(<CanvasWidgetView widget={widget} editing={false} />);
  expect(screen.getByText('上次写入：45')).toBeInTheDocument();
  expect(screen.queryByText(/确认值/)).not.toBeInTheDocument();
  expect(screen.getByLabelText('设定值 写入值')).not.toBeDisabled();
  expect(screen.getByText('上次写入：45').closest('[title]')).toHaveAttribute('title', expect.stringContaining('结果未知'));
  expect(snapshot.points['s1::Ia']!.hasValue).toBe(false);
});

it('isolates simulated input, click and keyboard actions from confirmed values and real drafts', () => {
  const points = appStore.getState().snapshot!.points;
  const live = appStore.getState().live;
  const states = appStore.getState().writeStates;
  const preview = { ...defaultWidgetPreview(widget), value: '900' };
  const { rerender, container } = render(<CanvasWidgetView widget={widget} editing preview={preview} />);
  const input = screen.getByLabelText('设定值 写入值');
  expect(input).toHaveValue(900);
  expect(input).toHaveAttribute('tabindex', '-1');
  expect(screen.getByText('预览值：900')).toBeInTheDocument();
  expect(container.querySelector('[data-preview=true]')).not.toBeNull();
  fireEvent.change(input, { target: { value: '999' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.click(screen.getByRole('button', { name: '写入' }));
  expect(calls).not.toHaveBeenCalled();
  expect(appStore.getState().snapshot!.points).toBe(points);
  expect(points['s1::Ia']!.engNumber).toBe(12);
  expect(appStore.getState().live).toBe(live);
  expect(appStore.getState().writeStates).toBe(states);
  // Runtime ignores even a stale preview prop and never turns it into an input draft.
  rerender(<CanvasWidgetView widget={widget} editing={false} preview={preview} />);
  expect(input).toHaveValue(null);
  expect(screen.getByText('确认值：12')).toBeInTheDocument();
  expect(container.querySelector('[data-preview=true]')).toBeNull();
  expect(screen.getByRole('button', { name: '写入' })).toBeDisabled();
});

it.each(['disabled', 'writing', 'error'] as const)('shows simulated %s input state without mutating actual write state', uiState => {
  render(<CanvasWidgetView widget={widget} editing preview={{ ...defaultWidgetPreview(widget), value: '33', uiState }} />);
  expect(screen.getByRole('status')).toHaveTextContent(uiState === 'disabled' ? '已禁用' : uiState === 'writing' ? '写入中' : '写入失败');
  const button = screen.getByRole('button', { name: uiState === 'writing' ? '写入中…' : '写入' });
  if (uiState !== 'error') expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(calls).not.toHaveBeenCalled();
  expect(appStore.getState().writeStates).toEqual({});
});

it.each(['button', 'switch'] as const)('blocks actual %s writes while showing a normal active preview', kind => {
  const control = { ...widget, kind };
  render(<CanvasWidgetView widget={control} editing preview={{ ...defaultWidgetPreview(control), value: '1' }} />);
  const button = screen.getByRole(kind === 'switch' ? 'switch' : 'button');
  expect(button).not.toBeDisabled();
  if (kind === 'switch') expect(button).toHaveAttribute('aria-checked', 'true');
  expect(button).toHaveAttribute('tabindex', '-1');
  fireEvent.click(button);
  expect(calls).not.toHaveBeenCalled();
  expect(appStore.getState().overlay).toBeNull();
});

it('previews gauge values before binding and restores the unavailable runtime state', () => {
  const gauge = { ...widget, kind: 'gauge' as const, binding: null };
  const preview = { ...defaultWidgetPreview(gauge), value: '75' };
  const { rerender } = render(<CanvasWidgetView widget={gauge} editing preview={preview} />);
  expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '75');
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  rerender(<CanvasWidgetView widget={gauge} editing={false} preview={preview} />);
  expect(screen.getByRole('meter')).not.toHaveAttribute('aria-valuenow');
  expect(screen.getByRole('status')).toHaveTextContent('未绑定点位');
});

it('previews every lamp state including a shadowed rule without changing its rules or source', () => {
  const lamp = { ...widget, kind: 'lamp' as const, lamp: lampConfigSchema.parse({ mode: 'states', rules: [{ id: 'first', value: 12, label: '运行' }, { id: 'second', value: 12, label: '停机' }] }) };
  const preview = { ...defaultWidgetPreview(lamp), value: '12', lampState: 'rule:second' };
  const { rerender, container } = render(<CanvasWidgetView widget={lamp} editing preview={preview} />);
  expect(screen.getByRole('img')).toHaveAttribute('aria-label', '停机');
  rerender(<CanvasWidgetView widget={lamp} editing preview={{ ...preview, lampState: 'fallback' }} />);
  expect(container.querySelector('[data-lamp-state]')).toHaveAttribute('data-lamp-state', 'fallback');
  rerender(<CanvasWidgetView widget={lamp} editing={false} preview={preview} />);
  expect(screen.getByRole('img')).toHaveAttribute('aria-label', '运行');
  expect(lamp.lamp.rules).toHaveLength(2);
  expect(calls).not.toHaveBeenCalled();
});

it('keeps confirmed values separate from input and uses the existing point.write command', async () => {
  render(<CanvasWidgetView widget={widget} editing={false} />);
  fireEvent.change(screen.getByLabelText('设定值 写入值'), { target: { value: '45.5' } });
  expect(screen.getByText('确认值：12')).toBeInTheDocument();
  expect(appStore.getState().snapshot?.points['s1::Ia']?.engNumber).toBe(12);
  fireEvent.click(screen.getByRole('button', { name: '写入' }));
  await waitFor(() => expect(calls).toHaveBeenCalledWith({ type: 'point.write', slaveId: 's1', pointId: 'Ia', engineering: 45.5, boolValue: null, stringValue: null }));
  expect(appStore.getState().snapshot?.points['s1::Ia']?.engNumber).toBe(12);
});
it('locks device writes in edit mode and when offline', () => {
  const { rerender } = render(<CanvasWidgetView widget={widget} editing />);
  expect(screen.getByLabelText('设定值 写入值')).toBeDisabled();
  act(() => { const snapshot = appStore.getState().snapshot!; appStore.setState({ snapshot: { ...snapshot, connections: { c1: { state: 'offline', detail: null, lastResponseUtc: null } } } }); });
  rerender(<CanvasWidgetView widget={widget} editing={false} />);
  expect(screen.getByLabelText('设定值 写入值')).toBeDisabled();
  expect(screen.getByRole('status')).toHaveTextContent('离线');
});
it('requires high-risk confirmation before sending and preserves drafts on rejection', async () => {
  const snapshot = appStore.getState().snapshot!;
  snapshot.workspace.templates[0]!.points[0]!.highRisk = true;
  appStore.setState({ snapshot });
  render(<><CanvasWidgetView widget={widget} editing={false} /><Overlays /></>);
  fireEvent.change(screen.getByLabelText('设定值 写入值'), { target: { value: '50' } });
  fireEvent.click(screen.getByRole('button', { name: '写入' }));
  expect(calls).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toHaveTextContent('确认设备写入');
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(screen.getByLabelText('设定值 写入值')).toHaveValue(50);
});
it('metadata-only deltas do not erase offline confirmed cache or append synthetic trend samples', () => {
  const original = appStore.getState().snapshot!.points;
  const live = { 's1::Ia': { samples: [[1, 12] as [number, number]], events: [] } };
  appStore.setState({ live });
  appStore.getState().applyDelta({ revision: 2, workspace: { ...appStore.getState().snapshot!.workspace, canvases: [] }, workspaceMetadataOnly: true });
  expect(appStore.getState().snapshot!.points).toBe(original);
  expect(appStore.getState().live).toBe(live);
});

it.each(['arc', 'dial', 'bar', 'vertical', 'tank'] as const)('renders %s gauges from the same confirmed value', gaugeStyle => {
  render(<CanvasWidgetView widget={{ ...widget, kind: 'gauge', gaugeStyle, min: 0, max: 10 }} editing={false} />);
  expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '12');
  expect(screen.getByRole('meter')).toHaveAttribute('aria-valuetext', '12');
  expect(screen.getByRole('meter').querySelector('[d*="NaN"]')).toBeNull();
});

it('writes String drafts including an explicit empty value while preserving confirmed text', async () => {
  const snapshot = appStore.getState().snapshot!;
  const original = snapshot.points['s1::Ia']!;
  appStore.setState({ snapshot: { ...snapshot, points: { 's1::Late': { ...original, pointId: 'Late', engText: 'OLD', engNumber: null, stringValue: 'OLD' } } } });
  render(<CanvasWidgetView widget={{ ...widget, inputMode: 'text', binding: { slaveId: 's1', pointId: 'Late' } }} editing={false} />);
  fireEvent.change(screen.getByLabelText('设定值 写入值'), { target: { value: 'TEST' } });
  expect(screen.getByText('确认值：OLD')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '写入' }));
  await waitFor(() => expect(calls).toHaveBeenLastCalledWith({ type: 'point.write', slaveId: 's1', pointId: 'Late', engineering: null, boolValue: null, stringValue: 'TEST' }));
  await waitFor(() => expect(screen.getByLabelText('设定值 写入值')).toHaveValue('OLD'));
  fireEvent.change(screen.getByLabelText('设定值 写入值'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: '写入' }));
  await waitFor(() => expect(calls).toHaveBeenLastCalledWith({ type: 'point.write', slaveId: 's1', pointId: 'Late', engineering: null, boolValue: null, stringValue: '' }));
  expect(appStore.getState().snapshot!.points['s1::Late']!.stringValue).toBe('OLD');
});

it.each(['Mode', 'Flag'])('uses the point enum/Bool options and explicitly submits %s', async pointId => {
  const snapshot = appStore.getState().snapshot!;
  snapshot.workspace.templates[0]!.points.find(p => p.id === 'Mode')!.enumMap = { '0': '停止', '1': '运行' };
  appStore.setState({ snapshot: { ...snapshot, points: { [`s1::${pointId}`]: { ...snapshot.points['s1::Ia']!, pointId, engText: '0', engNumber: null, rawNumber: pointId === 'Flag' ? null : 0, enumLabel: pointId === 'Mode' ? '停止' : null, boolValue: pointId === 'Flag' ? false : null } } } });
  render(<CanvasWidgetView widget={{ ...widget, inputMode: 'select', binding: { slaveId: 's1', pointId } }} editing={false} />);
  expect(screen.getByLabelText('设定值 选择值')).toHaveTextContent(pointId === 'Flag' ? 'OFF' : '停止');
  const user = userEvent.setup();
  screen.getByRole('combobox', { name: '设定值 选择值' }).focus();
  await user.keyboard('{ArrowDown}');
  await screen.findByRole('option', { name: pointId === 'Flag' ? 'ON' : '运行' });
  await user.keyboard('{End}{Enter}');
  expect(calls).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '写入' }));
  await waitFor(() => expect(calls).toHaveBeenCalledWith({ type: 'point.write', slaveId: 's1', pointId,
    engineering: pointId === 'Flag' ? null : 1, boolValue: pointId === 'Flag' ? true : null, stringValue: null }));
});

it('keeps stepper and slider edits in drafts until explicitly written', async () => {
  const { rerender } = render(<CanvasWidgetView widget={{ ...widget, inputMode: 'stepper', step: 2, limitInput: true, min: 0, max: 20 }} editing={false} />);
  fireEvent.click(screen.getByLabelText('设定值 增加'));
  expect(screen.getByLabelText('设定值 写入值')).toHaveValue(14);
  expect(calls).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '写入' }));
  await waitFor(() => expect(calls).toHaveBeenCalledWith(expect.objectContaining({ engineering: 14 })));
  await waitFor(() => expect(screen.getByLabelText('设定值 写入值')).toHaveValue(12));
  calls.mockClear();
  rerender(<CanvasWidgetView widget={{ ...widget, inputMode: 'slider', step: .5, min: 0, max: 20 }} editing={false} />);
  fireEvent.change(screen.getByLabelText('设定值 滑动值'), { target: { value: '16.5' } });
  expect(calls).not.toHaveBeenCalled();
  expect(appStore.getState().snapshot!.points['s1::Ia']!.engNumber).toBe(12);
  fireEvent.click(screen.getByRole('button', { name: '写入' }));
  await waitFor(() => expect(calls).toHaveBeenCalledWith(expect.objectContaining({ engineering: 16.5 })));
});

it('lights an enum-backed point and keeps its last confirmed state when offline', () => {
  const snapshot = appStore.getState().snapshot!;
  snapshot.workspace.templates[0]!.points[0]!.enumMap = { '1': '运行' };
  appStore.setState({ snapshot: { ...snapshot, points: { 's1::Ia': { ...snapshot.points['s1::Ia']!, engNumber: null, rawNumber: 1, engText: '运行', enumLabel: '运行' } } } });
  render(<CanvasWidgetView widget={{ ...widget, kind: 'lamp' }} editing={false} />);
  expect(screen.getByRole('img', { name: 'ON' })).toBeInTheDocument();
  act(() => appStore.setState({ snapshot: { ...appStore.getState().snapshot!, connections: { c1: { state: 'offline', detail: null, lastResponseUtc: null } } } }));
  expect(screen.getByRole('img', { name: 'ON' })).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('离线');
});

it('renders configured multi-state and fallback labels without interpreting missing values as OFF', () => {
  const lamp = lampConfigSchema.parse({ mode: 'states', rules: [lampRuleSchema.parse({ id: 'running', value: 12, label: '运行', color: '#178A4D' })], fallback: { label: '其它状态', color: '#D97706' } });
  render(<CanvasWidgetView widget={{ ...widget, kind: 'lamp', showStateText: true, lamp }} editing={false} />);
  expect(screen.getByRole('img', { name: '运行' })).toBeInTheDocument();
  act(() => { const snapshot = appStore.getState().snapshot!; appStore.setState({ snapshot: { ...snapshot, points: { 's1::Ia': { ...snapshot.points['s1::Ia']!, engNumber: 5, rawNumber: 5 } } } }); });
  expect(screen.getByRole('img', { name: '其它状态' })).toBeInTheDocument();
  act(() => { const snapshot = appStore.getState().snapshot!; appStore.setState({ snapshot: { ...snapshot, points: { 's1::Ia': { ...snapshot.points['s1::Ia']!, engNumber: null, rawNumber: NaN } } } }); });
  expect(screen.getByRole('img', { name: '其它状态' })).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('数值无效');
});
