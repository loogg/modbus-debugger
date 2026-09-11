import React, { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import { fmtDuration, fmtDurationMs, fmtEpoch, fmtEpochDateTime } from '../time';

export interface LineSeries {
  name: string;
  color: string;
  data: Array<[number, number]>;
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
    const fmtX = props.xMode === 'duration' ? fmtDuration : fmtEpoch;
    const fmtXFull = props.xMode === 'duration' ? fmtDurationMs : fmtEpochDateTime;
    const apply = () => {
      lastSetAt.current = Date.now();
      chart.setOption(
        {
          animation: false,
          grid: { left: 56, right: 24, top: 40, bottom: 28 },
          tooltip: {
            trigger: 'axis',
            // axis values are epoch ms; format them in the user-configured display timezone
            formatter: (raw: unknown) => {
              const list = raw as Array<{ seriesName?: string; value?: [number, number]; marker?: string }>;
              if (!Array.isArray(list) || list.length === 0) return '';
              const head = fmtXFull(list[0]?.value?.[0] ?? 0);
              return [head, ...list.map((it) => `${it.marker ?? ''} ${it.seriesName ?? ''}: ${it.value?.[1] ?? ''}`)].join('<br/>');
            },
          },
          legend: { top: 4, right: 8, type: 'scroll', textStyle: { fontSize: 11 } },
          xAxis: {
            type: 'time',
            min: props.startMs,
            max: props.endMs,
            axisLabel: { fontSize: 10, color: '#62666F', formatter: (v: number) => fmtX(v) },
            axisLine: { lineStyle: { color: '#D9DEE5' } },
            splitLine: { show: true, lineStyle: { color: '#EEF1F4' } },
          },
          yAxis: {
            type: 'value',
            scale: true,
            axisLabel: { fontSize: 10, color: '#62666F' },
            splitLine: { lineStyle: { color: '#EEF1F4' } },
          },
          series: props.series.map((s) => ({
            name: s.name,
            type: 'line',
            showSymbol: false,
            lineStyle: { width: 1.5, color: s.color },
            itemStyle: { color: s.color },
            data: s.data,
          })),
        },
        { replaceMerge: ['series'] },
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

  return <div ref={ref} style={{ width: '100%', height: props.height ?? 300 }} />;
}
