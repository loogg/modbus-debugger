import React, { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import { fmtDuration, fmtDurationMs, fmtEpoch, fmtEpochDateTime } from '../time';
import { formatEngineeringNumber } from '../../domain/point-format';

export interface LineSeries {
  name: string;
  unit?: string;
  color: string;
  data: Array<[number, number]>;
  decimalPlaces?: number;
}

interface TooltipItem {
  seriesIndex?: number;
  seriesName?: string;
  value?: [number, number];
  marker?: string;
}

export function formatChartTooltip(raw: unknown, series: LineSeries[], formatTime: (time: number) => string): string {
  const items = raw as TooltipItem[];
  if (!Array.isArray(items) || items.length === 0) return '';
  const head = formatTime(items[0]?.value?.[0] ?? 0);
  return [head, ...items.map((item) => {
    const index = item.seriesIndex ?? series.findIndex((candidate) => candidate.name === item.seriesName);
    const value = item.value?.[1];
    const display = typeof value === 'number' ? formatEngineeringNumber(value, series[index]?.decimalPlaces) : '—';
    return `${item.marker ?? ''} ${item.seriesName ?? ''}: ${display}`;
  })].join('<br/>');
}

export interface NumericChartProps {
  series: LineSeries[];
  height?: number;
  startMs?: number;
  endMs?: number;
  /**
   * 'epoch' (default): X values are wall-clock epoch ms, rendered in the display timezone.
   * 'duration': X values are ms since session start (history replay), rendered as an offset.
   */
  xMode?: 'epoch' | 'duration';
}

const MIN_SET_INTERVAL_MS = 250;

/** Numeric trend chart. Axis text and line widths never scale with the window. */
export function NumericChart(props: NumericChartProps) {
  const units = [...new Set(props.series.map(s => s.unit ?? ''))];
  // Two axes fit compact windows. More unit groups get full-width plots rather than overlapping labels.
  if (units.length > 2) return <div>{units.map(unit => <div key={unit}><div className="text-xs text-ink2">{unit || '—'}</div><UnitChart {...props} series={props.series.filter(s => (s.unit ?? '') === unit)} /></div>)}</div>;
  return <UnitChart {...props} />;
}

function UnitChart(props: NumericChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const lastSetAt = useRef(0);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const units = [...new Set(props.series.map(s => s.unit ?? ''))];
    if (!units.length) units.push('');
    const fmtX = props.xMode === 'duration' ? fmtDuration : fmtEpoch;
    const fmtXFull = props.xMode === 'duration' ? fmtDurationMs : fmtEpochDateTime;
    const apply = () => {
      lastSetAt.current = Date.now();
      chart.setOption(
        {
          animation: false,
          grid: { left: 56, right: units.length > 1 ? 56 : 24, top: 40, bottom: 28 },
          tooltip: {
            trigger: 'axis',
            renderMode: 'html',
            className: 'modbus-chart-tooltip',
            confine: true,
            // axis values are epoch ms; format them in the user-configured display timezone
            formatter: (raw: unknown) => formatChartTooltip(raw, props.series, fmtXFull),
          },
          legend: { top: 4, right: 8, type: 'scroll', textStyle: { fontSize: 11 } },
          xAxis: {
            type: 'time',
            min: props.startMs,
            max: props.endMs,
            axisLabel: { hideOverlap: true, fontSize: 10, color: '#62666F', formatter: (v: number) => fmtX(v) },
            axisLine: { lineStyle: { color: '#D9DEE5' } },
            splitLine: { show: true, lineStyle: { color: '#EEF1F4' } },
          },
          yAxis: units.map((unit, index) => ({
            type: 'value',
            name: unit,
            position: index === 0 ? 'left' : 'right',
            scale: true,
            axisLabel: { fontSize: 10, color: '#62666F' },
            splitLine: { show: index === 0, lineStyle: { color: '#EEF1F4' } },
          })),
          series: props.series.map((s) => ({
            name: s.name,
            yAxisIndex: units.indexOf(s.unit ?? ''),
            type: 'line',
            showSymbol: false,
            lineStyle: { width: 1.5, color: s.color },
            itemStyle: { color: s.color },
            data: s.data,
          })),
        },
        { replaceMerge: ['series', 'yAxis'] },
      );
    };
    // Live screens push new samples several times a second; ECharts setOption is the
    // expensive part, so coalesce updates to at most one per 250 ms.
    const since = Date.now() - lastSetAt.current;
    if (since >= MIN_SET_INTERVAL_MS) {
      apply();
    } else {
      if (pendingTimer.current) clearTimeout(pendingTimer.current);
      pendingTimer.current = setTimeout(apply, MIN_SET_INTERVAL_MS - since);
    }
    return () => {
      if (pendingTimer.current) clearTimeout(pendingTimer.current);
    };
  }, [props.series, props.startMs, props.endMs, props.xMode]);

  return <div ref={ref} data-chart-units={JSON.stringify([...new Set(props.series.map(s => s.unit ?? ''))])} data-series-count={props.series.length} style={{ width: '100%', height: props.height ?? 300 }} />;
}
