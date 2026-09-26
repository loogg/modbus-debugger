import { expect, it } from 'vitest';
import { formatChartTooltip, type LineSeries } from '../../../src/renderer/components/chart';

it('formats each trend signal with its point precision without changing sample values', () => {
  const originalA = 48.5990173339844;
  const originalB = 48.3711196899414;
  const series: LineSeries[] = [
    { name: '母线电压', color: '#0078D4', decimalPlaces: 2, data: [[1000, originalA]] },
    { name: '输入电压', color: '#0E7C86', decimalPlaces: 1, data: [[1000, originalB]] },
  ];
  const html = formatChartTooltip([
    { seriesIndex: 0, seriesName: '母线电压', value: [1000, originalA], marker: '●' },
    { seriesIndex: 1, seriesName: '输入电压', value: [1000, originalB], marker: '●' },
  ], series, () => '00:00:01.000');
  expect(html).toBe('00:00:01.000<br/>● 母线电压: 48.6<br/>● 输入电压: 48.4');
  expect(series[0]?.data[0]?.[1]).toBe(originalA);
  expect(series[1]?.data[0]?.[1]).toBe(originalB);
});
