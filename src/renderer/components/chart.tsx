import React, { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

export interface LineSeries {
  name: string;
  color: string;
  data: Array<[number, number]>;
}

/** Numeric trend chart. Axis text and line widths never scale with the window. */
export function NumericChart(props: { series: LineSeries[]; height?: number; startMs?: number; endMs?: number; cursorMs?: number | null; onCursor?: (ms: number | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    chart.on('click', (params) => {
      if (props.onCursor && Array.isArray(params.value)) props.onCursor(params.value[0] as number);
    });
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
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
  }, [props.series, props.startMs, props.endMs]);

  return <div ref={ref} style={{ width: '100%', height: props.height ?? 300 }} />;
}