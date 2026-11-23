import React, { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import { fmtDuration, fmtDurationMs, fmtEpoch, fmtEpochDateTimeMs } from '../time';
import { formatEngineeringNumber } from '../../domain/point-format';
import { useViewDocument } from '../workbench/view-context';
import { drawingSamples, sampleCursor, type SampleCursor } from './chart-data';

export interface LineSeries {
  name: string;
  unit?: string;
  color: string;
  data: Array<[number, number, number?]>;
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
    const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
    const unit = series[index]?.unit;
    return `${item.marker ?? ''} ${escape(item.seriesName ?? '')}: ${display}${unit ? ` ${escape(unit)}` : ''}`;
  })].join('<br/>');
}

export function formatSampleCursor(cursor: SampleCursor, formatTime: (time: number) => string): string {
  const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
  const rows = cursor.rows.map(({ series, sample }) => {
    const color = /^#[0-9a-f]{6}$/i.test(series.color) ? series.color : '#0078D4';
    const name = `<span style="color:${color}">●</span> ${escape(series.name)}`;
    if (!sample) return `<tr><td>${name}</td><td colspan="3">无样本</td></tr>`;
    return `<tr data-sample-time="${sample[0]}" data-sample-seq="${sample[2] ?? ''}"><td>${name}</td><td>${escape(formatTime(sample[0]))}</td><td>${sample[2] ?? '—'}</td><td>${formatEngineeringNumber(sample[1], series.decimalPlaces)} ${escape(series.unit ?? '')}</td></tr>`;
  });
  return `<div data-sample-cursor="${cursor.time}"><div style="margin-bottom:6px">${escape(formatTime(cursor.time))}</div><table style="border-spacing:10px 3px;border-collapse:separate;font-size:11px"><thead><tr><th>信号</th><th>采样时间</th><th>序号</th><th>值</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

export interface NumericChartProps {
  series: LineSeries[];
  height?: number | '100%';
  startMs?: number;
  endMs?: number;
  /**
   * 'epoch' (default): X values are wall-clock epoch ms, rendered in the display timezone.
   * 'duration': X values are ms since session start (history replay), rendered as an offset.
   */
  xMode?: 'epoch' | 'duration';
  interactive?: boolean;
  resetKey?: number;
  updateIntervalMs?: number;
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
  const viewDocument = useViewDocument();
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const lastSetAt = useRef(0);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedView = useRef<{ zoom?: Array<{ start?: number; end?: number }>; selected?: Record<string, boolean> }>({});
  const restoreView = useRef(true);
  const currentProps = useRef(props);
  currentProps.current = props;
  const cursor = useRef<SampleCursor | null>(null);
  const redraw = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    // Retained inactive tabs have zero layout size; ResizeObserver supplies real bounds when shown.
    const chart = echarts.init(ref.current, undefined, { width: Math.max(1, ref.current.clientWidth), height: Math.max(1, ref.current.clientHeight) });
    chartRef.current = chart;
    restoreView.current = true;
    chart.on('datazoom', () => redraw.current?.());
    chart.on('legendselectchanged', (event: unknown) => { savedView.current.selected = (event as { selected: Record<string, boolean> }).selected; });
    const renderer = chart.getZr?.();
    const ownerWindow = viewDocument.defaultView;
    let frame: number | null = null;
    let hiding: ReturnType<typeof setTimeout> | null = null;
    const markers = renderer ? new echarts.graphic.Group({ silent: true }) : null;
    if (markers) renderer!.add(markers);
    const hide = () => {
      markers?.removeAll(); cursor.current = null;
      chart.dispatchAction({ type: 'hideTip' });
      chart.dispatchAction({ type: 'updateAxisPointer', currTrigger: 'leave' });
    };
    const leave = () => {
      if (hiding) clearTimeout(hiding);
      hiding = setTimeout(() => { if (!ref.current?.querySelector('.modbus-chart-tooltip:hover')) hide(); }, 180);
    };
    const move = (event: { offsetX: number; offsetY: number }) => {
      if (!ownerWindow || frame !== null) return;
      if (hiding) clearTimeout(hiding);
      frame = ownerWindow.requestAnimationFrame(() => {
        frame = null;
        const pixel = [event.offsetX, event.offsetY];
        if (!chart.containPixel({ gridIndex: 0 }, pixel)) { leave(); return; }
        const current = currentProps.current;
        const units = [...new Set(current.series.map(item => item.unit ?? ''))];
        const start = chart.convertFromPixel({ xAxisIndex: 0 }, 48) as number;
        const end = chart.convertFromPixel({ xAxisIndex: 0 }, chart.getWidth() - (units.length > 1 ? 48 : 16)) as number;
        const time = chart.convertFromPixel({ xAxisIndex: 0 }, event.offsetX) as number;
        const found = sampleCursor(current.series, time, Math.min(start, end), Math.max(start, end), savedView.current.selected);
        cursor.current = found;
        markers?.removeAll();
        if (!found) { hide(); return; }
        for (const row of found.rows) {
          if (!row.sample || !markers) continue;
          const x = chart.convertToPixel({ xAxisIndex: 0 }, row.sample[0]) as number;
          const y = chart.convertToPixel({ yAxisIndex: units.indexOf(row.series.unit ?? '') }, row.sample[1]) as number;
          if (Number.isFinite(x) && Number.isFinite(y)) markers.add(new echarts.graphic.Circle({ silent: true, z: 1000, shape: { cx: x, cy: y, r: 4 }, style: { fill: '#FFFFFF', stroke: row.series.color, lineWidth: 2 } }));
        }
        chart.dispatchAction({ type: 'updateAxisPointer', x: chart.convertToPixel({ xAxisIndex: 0 }, found.time), y: event.offsetY, axesInfo: [{ axisDim: 'x', axisIndex: 0, value: found.time }] });
        const formatTime = current.xMode === 'duration' ? fmtDurationMs : fmtEpochDateTimeMs;
        chart.dispatchAction({ type: 'showTip', x: event.offsetX, y: event.offsetY, tooltip: { content: formatSampleCursor(found, formatTime), formatter: () => formatSampleCursor(found, formatTime) } });
      });
    };
    renderer?.on('mousemove', move);
    renderer?.on('globalout', leave);
    const ro = new ResizeObserver(entries => {
      const bounds = entries[0]?.contentRect;
      if (bounds) chart.resize({ width: Math.max(1, bounds.width), height: Math.max(1, bounds.height) });
    });
    ro.observe(ref.current);
    return () => {
      const option = (chart.getOption() ?? {}) as { dataZoom?: Array<{ start?: number; end?: number }>; legend?: Array<{ selected?: Record<string, boolean> }> };
      savedView.current = { zoom: option.dataZoom?.map(z => ({ start: z.start, end: z.end })), selected: option.legend?.[0]?.selected };
      ro.disconnect();
      if (frame !== null) ownerWindow?.cancelAnimationFrame(frame);
      if (hiding) clearTimeout(hiding);
      renderer?.off('mousemove', move); renderer?.off('globalout', leave);
      chart.dispose();
      chartRef.current = null;
    };
  }, [viewDocument]);

  useEffect(() => {
    savedView.current.zoom = undefined;
    if (props.interactive) chartRef.current?.dispatchAction({ type: 'dataZoom', start: 0, end: 100 }, { silent: true });
  }, [props.resetKey, props.interactive]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const units = [...new Set(props.series.map(s => s.unit ?? ''))];
    if (!units.length) units.push('');
    const fmtX = props.xMode === 'duration' ? fmtDuration : fmtEpoch;
    const fmtXFull = props.xMode === 'duration' ? fmtDurationMs : fmtEpochDateTimeMs;
    const apply = () => {
      lastSetAt.current = Date.now();
      const zoom = (chart.getOption() as { dataZoom?: Array<{ start?: number; end?: number }> } | undefined)?.dataZoom?.[0];
      const lower = props.startMs ?? Math.min(...props.series.map(item => item.data[0]?.[0] ?? 0));
      const upper = props.endMs ?? Math.max(...props.series.map(item => item.data.at(-1)?.[0] ?? lower));
      const visibleStart = lower + (upper - lower) * (zoom?.start ?? 0) / 100;
      const visibleEnd = lower + (upper - lower) * (zoom?.end ?? 100) / 100;
      if (ref.current) {
        ref.current.dataset.viewStartMs = String(visibleStart);
        ref.current.dataset.viewEndMs = String(visibleEnd);
      }
      const drawingLimit = Math.max(200, Math.min(3000, (ref.current?.clientWidth || 1000) * 2));
      chart.setOption(
        {
          animation: false,
          axisPointer: { triggerOn: 'none' },
          grid: { left: 48, right: units.length > 1 ? 48 : 16, top: 52, bottom: props.interactive ? 48 : 28 },
          tooltip: {
            trigger: 'axis',
            triggerOn: 'none',
            renderMode: 'html',
            className: 'modbus-chart-tooltip',
            confine: true,
            enterable: true,
            extraCssText: 'max-height:280px;overflow:auto;max-width:100%;',
            axisPointer: { type: props.interactive ? 'cross' : 'line', snap: false },
            // axis values are epoch ms; format them in the user-configured display timezone
            formatter: (raw: unknown) => cursor.current ? formatSampleCursor(cursor.current, fmtXFull) : formatChartTooltip(raw, props.series, fmtXFull),
          },
          legend: { top: 2, left: 4, right: props.interactive ? 66 : 8, type: 'scroll', textStyle: { fontSize: 11 },
            formatter: (name: string) => { const unit = props.series.find(s => s.name === name)?.unit; return props.interactive && unit ? `${name} (${unit})` : name; },
            ...(restoreView.current && savedView.current.selected ? { selected: savedView.current.selected } : {}) },
          toolbox: props.interactive ? { top: 0, right: 0, itemSize: 13, feature: { dataZoom: { yAxisIndex: 'none', title: { zoom: '框选缩放', back: '撤销缩放' } }, restore: { title: '还原视图' } } } : undefined,
          dataZoom: props.interactive ? [
            { id: 'inside', type: 'inside', xAxisIndex: 0, filterMode: 'none', ...(restoreView.current ? savedView.current.zoom?.[0] : {}) },
            { id: 'slider', type: 'slider', xAxisIndex: 0, filterMode: 'none', bottom: 2, height: 16, borderColor: '#D9DEE5', fillerColor: 'rgba(0,120,212,0.12)', showDetail: false, ...(restoreView.current ? savedView.current.zoom?.[1] : {}) },
          ] : [],
          xAxis: {
            type: 'time',
            axisPointer: { snap: false, label: { formatter: (item: { value: number }) => fmtXFull(item.value) } },
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
            encode: { x: 0, y: 1 },
            emphasis: { disabled: true },
            lineStyle: { width: 1.5, color: s.color },
            itemStyle: { color: s.color },
            data: drawingSamples(s.data, visibleStart, visibleEnd, drawingLimit),
          })),
        },
        { replaceMerge: ['series', 'yAxis'] },
      );
      restoreView.current = false;
    };
    redraw.current = apply;
    // Live screens push new samples several times a second; ECharts setOption is the
    // expensive part, so coalesce updates to at most one per 250 ms.
    const since = Date.now() - lastSetAt.current;
    const interval = Math.max(16, props.updateIntervalMs ?? MIN_SET_INTERVAL_MS);
    if (since >= interval) {
      apply();
    } else {
      if (pendingTimer.current) clearTimeout(pendingTimer.current);
      pendingTimer.current = setTimeout(apply, interval - since);
    }
    return () => {
      if (pendingTimer.current) clearTimeout(pendingTimer.current);
    };
  }, [props.series, props.startMs, props.endMs, props.xMode, props.interactive, props.updateIntervalMs, viewDocument]);

  return <div ref={ref} data-chart-units={JSON.stringify([...new Set(props.series.map(s => s.unit ?? ''))])} data-series-count={props.series.length} data-sample-count={props.series.reduce((sum, series) => sum + series.data.length, 0)} data-last-seq={Math.max(0, ...props.series.map(series => series.data.at(-1)?.[2] ?? 0))} style={{ width: '100%', height: props.height ?? 300 }} />;
}
