import React from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { NumericChart, type LineSeries } from '../../../src/renderer/components/chart';
const mocks = vi.hoisted(() => ({ setOption: vi.fn() }));
vi.mock('echarts', () => ({ init: () => ({ setOption: mocks.setOption, dispose: vi.fn(), resize: vi.fn() }) }));
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); });
afterEach(() => { cleanup(); mocks.setOption.mockClear(); });
const series = (unit: string, value: number): LineSeries => ({ name: unit, unit, color: '#000', data: [[0, value], [1, value]] });
describe('numeric chart unit axes', () => {
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
