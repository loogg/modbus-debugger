import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CanvasTrendView } from '../../../src/renderer/features/canvas/trend-widget';
import { canvasWidgetSchema } from '../../../src/domain/canvas';
import { appStore } from '../../../src/renderer/store/app';
import { templateWorkspace } from '../../support/template-workspace';
import { DEFAULT_PREFS } from '../../../src/main/services/workspace';
import type { NumericChartProps } from '../../../src/renderer/components/chart';
import { defaultWidgetPreview } from '../../../src/renderer/features/canvas/preview';
import { CurveWindowContext } from '../../../src/renderer/features/canvas/curve-window';

const chart = vi.hoisted(() => ({ props: null as NumericChartProps | null }));
vi.mock('../../../src/renderer/components/chart', () => ({ NumericChart: (props: NumericChartProps) => { chart.props = props; return <div />; } }));
afterEach(cleanup);

it('generates editor-only preview series and restores the existing live samples', () => {
  const workspace = templateWorkspace();
  const samples: [number, number][] = [[1000, 12], [2000, 13]];
  const live = { 's1::Ia': { samples, events: [] } };
  appStore.setState({ live, snapshot: { revision: 1, workspace, workspacePath: null, dirty: false, connections: {}, blocks: {}, points: {}, transactions: [], parseEvents: [], diagRev: 0, health: {}, sessions: [], warnings: [], prefs: DEFAULT_PREFS, historyDbPath: '' } });
  const widget = canvasWidgetSchema.parse({ id: 'curve', kind: 'trend', label: '趋势', windowSec: 5, x: 0, y: 0, width: 400, height: 240, signals: [{ slaveId: 's1', pointId: 'Ia' }] });
  const preview = { ...defaultWidgetPreview(widget), value: '200' };
  const { rerender } = render(<CanvasTrendView widget={widget} editing preview={preview} />);
  expect(chart.props!.series[0]!.data).toHaveLength(61);
  expect(chart.props!.series[0]!.data[0]![1]).toBe(200);
  expect(chart.props!.interactive).toBe(false);
  expect(appStore.getState().live).toBe(live);
  expect(samples).toEqual([[1000, 12], [2000, 13]]);
  rerender(<CanvasTrendView widget={widget} editing preview={{ ...preview, dataState: 'invalid' }} />);
  expect(chart.props!.series[0]!.data).toEqual([]);
  expect(screen.getByRole('status')).toHaveAttribute('aria-label', '预览：无效值');
  rerender(<CanvasTrendView widget={widget} editing={false} preview={preview} />);
  expect(chart.props!.series[0]!.data).toEqual(samples);
  expect(screen.getByText('实时')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('趋势 时间窗口'), { target: { value: '30' } });
  expect(screen.getByRole('option', { name: '5 秒' })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('趋势 时间窗口'), { target: { value: '5' } });
  expect(chart.props!.endMs! - chart.props!.startMs!).toBe(5000);
});

it('freezes a copy of all signal samples during inspection and resumes the shared live stream', () => {
  const workspace = templateWorkspace();
  workspace.templates[0]!.points[0]!.unit = 'V';
  workspace.templates[0]!.points[1]!.unit = 'A';
  workspace.slaves[0]!.enabled = true;
  const samples: [number, number][] = [[1000, 48], [2000, 49]];
  appStore.setState({
    live: { 's1::Ia': { samples, events: [] }, 's1::Ib': { samples: [[1000, 1.2]], events: [] } },
    snapshot: { revision: 1, workspace, workspacePath: null, dirty: false, connections: { c1: { state: 'online', detail: null, lastResponseUtc: null } }, blocks: {}, points: {}, transactions: [], parseEvents: [], diagRev: 0, health: {}, sessions: [], warnings: [], prefs: DEFAULT_PREFS, historyDbPath: '' },
  });
  const widget = canvasWidgetSchema.parse({ id: 'curve', kind: 'trend', label: '电源', x: 0, y: 0, width: 400, height: 240, signals: [{ slaveId: 's1', pointId: 'Ia' }, { slaveId: 's1', pointId: 'Ib' }] });
  const reportWindow = vi.fn();
  render(<CurveWindowContext.Provider value={reportWindow}><CanvasTrendView widget={widget} editing={false} /></CurveWindowContext.Provider>);
  expect(chart.props!.series.map(s => s.unit)).toEqual(['V', 'A']);
  fireEvent.click(screen.getByRole('button', { name: '暂停曲线' }));
  const frozenEnd = chart.props!.endMs;
  expect(reportWindow).toHaveBeenLastCalledWith('curve', { windowMs: 60000, endMs: frozenEnd });
  expect(screen.getByText('已暂停')).toBeInTheDocument();
  act(() => {
    samples[0]![1] = 999;
    appStore.setState({ live: { 's1::Ia': { samples: [[3000, 50]], events: [] }, 's1::Ib': { samples: [[3000, 2]], events: [] } } });
  });
  expect(chart.props!.series.map(s => s.data)).toEqual([[[1000, 48], [2000, 49]], [[1000, 1.2]]]);
  expect(chart.props!.endMs).toBe(frozenEnd);
  fireEvent.click(screen.getByRole('button', { name: '恢复跟随' }));
  expect(chart.props!.series.map(s => s.data)).toEqual([[[3000, 50]], [[3000, 2]]]);
  expect(chart.props!.resetKey).toBe(1);
  fireEvent.change(screen.getByLabelText('电源 时间窗口'), { target: { value: '300' } });
  expect(reportWindow).toHaveBeenLastCalledWith('curve', { windowMs: 300000, endMs: undefined });
  expect(chart.props!.endMs! - chart.props!.startMs!).toBe(300000);
});
