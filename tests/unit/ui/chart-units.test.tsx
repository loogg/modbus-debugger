import React from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { NumericChart, type LineSeries } from '../../../src/renderer/components/chart';
const mocks = vi.hoisted(() => ({ setOption: vi.fn(), resize: vi.fn(), observers: [] as ResizeObserverCallback[] }));
vi.mock('echarts', () => ({ init: () => ({ setOption: mocks.setOption, dispose: vi.fn(), resize: mocks.resize, on: vi.fn(), dispatchAction: vi.fn(), getOption: () => undefined }) }));
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { mocks.observers.push(callback); } observe() {} disconnect() {} }); });
afterEach(() => { cleanup(); mocks.setOption.mockClear(); mocks.resize.mockClear(); mocks.observers.length = 0; });
const series = (unit: string, value: number): LineSeries => ({ name: unit, unit, color: '#000', data: [[0, value], [1, value]] });
describe('numeric chart unit axes', () => {
  it('passes current layout dimensions when a Host is resized or shown', () => {
    render(<NumericChart series={[series('V', 48)]} />);
    const observer = mocks.observers[0]!;
    observer([{ contentRect: { width: 609, height: 300 } } as ResizeObserverEntry], {} as ResizeObserver);
    expect(mocks.resize).toHaveBeenLastCalledWith({ width: 609, height: 300 });
    observer([{ contentRect: { width: 0, height: 0 } } as ResizeObserverEntry], {} as ResizeObserver);
    expect(mocks.resize).toHaveBeenLastCalledWith({ width: 1, height: 1 });
  });
  it('exposes real zoom and crosshair controls for interactive curve views', () => {
    render(<NumericChart series={[series('V', 48), series('A', 1.2)]} interactive />);
    const option = mocks.setOption.mock.calls[0]![0];
    expect(option.dataZoom.map((zoom: { type: string }) => zoom.type)).toEqual(['inside', 'slider']);
    expect(option.tooltip.axisPointer.type).toBe('cross');
    expect(option.toolbox.feature.dataZoom.yAxisIndex).toBe('none');
    expect(option.legend.formatter('V')).toBe('V (V)');
  });
  it('uses independent axes and matching series indices for unlike physical units', () => {
    render(<NumericChart series={[series('V', 48), series('rpm', 1500), { ...series('V', 24), name: 'supply' }]} />);
    const option = mocks.setOption.mock.calls[0]![0];
    expect(option.yAxis.map((axis: { name: string }) => axis.name)).toEqual(['V','rpm']);
    expect(option.series.map((s: { yAxisIndex: number }) => s.yAxisIndex)).toEqual([0,1,0]);
  });
  it('renders extra unit groups as separate plots instead of squeezing axes off-screen', () => {
    render(<NumericChart series={[series('V',48), series('rpm',1500), series('A',1.2)]} />);
    expect(mocks.setOption).toHaveBeenCalledTimes(3);
    expect(mocks.setOption.mock.calls.every(call => call[0].yAxis.length === 1)).toBe(true);
  });
});

it('preserves all 12 signals across four units and switches back to shared dual axes after hiding groups', () => {
  const many = Array.from({length: 12}, (_, i) => ({...series(['V','A','rpm','°C'][i % 4]!, i), name:`signal-${i}`}));
  const {rerender} = render(<NumericChart series={many} />);
  expect(mocks.setOption.mock.calls.flatMap(call => call[0].series).map((s: {name:string})=>s.name).sort()).toEqual(many.map(s=>s.name).sort());
  expect(mocks.setOption.mock.calls.every(call => call[0].series.length === 3 && call[0].yAxis.length === 1)).toBe(true);
  mocks.setOption.mockClear();
  rerender(<NumericChart series={many.filter(s=>s.unit === 'V' || s.unit === 'A')} />);
  const option = mocks.setOption.mock.calls.at(-1)![0];
  expect(option.series).toHaveLength(6);
  expect(option.yAxis.map((a:{name:string})=>a.name)).toEqual(['V','A']);
});
