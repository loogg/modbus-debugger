import React, { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

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
    const apply = () => {
      lastSetAt.current = Date.now();
      chart.setOption(
        {
          animation: false,
          grid: { left: 56, right: 24, top: 40, bottom: 28 },
          tooltip: { trigger: 'axis' },
          legend: { top: 4, right: 8, type: 'scroll', textStyle: { fontSize: 11 } },
          xAxis: {
            type: 'time',
            min: props.startMs,
            max: props.endMs,
            axisLabel: { fontSize: 10, color: '#62666F' },
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
  }, [props.series, props.startMs, props.endMs]);

  return <div ref={ref} style={{ width: '100%', height: props.height ?? 300 }} />;
}
