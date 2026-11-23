import React, { useEffect, useId, useMemo } from 'react';
import { appStore, useApp, useViewStore, type LiveSeries } from '../store/app';
import { dataCacheFor, type HostNeeds } from '../store/data-cache';
import { useViewActive } from './view-context';
import { pointKey } from '../../shared/point-key';

export function useHostData(needs: Omit<HostNeeds, 'intervalMs' | 'active'>) {
  const store = useViewStore();
  const api = useApp(state => state.api);
  const intervalMs = useApp(state => state.selection.refreshMs ?? 100);
  const active = useViewActive();
  const workspace = useApp(state => state.snapshot?.workspace);
  const pointDefinitions = useMemo(() => {
    const definitions = new Map<string, Record<string, string>>();
    for (const slave of workspace?.slaves ?? []) {
      for (const point of workspace?.templates.find(template => template.id === slave.templateId)?.points ?? []) {
        if (Object.keys(point.enumMap).length) definitions.set(pointKey(slave.id, point.id), point.enumMap);
      }
    }
    return definitions;
  }, [workspace]);
  const id = useId();
  const signature = JSON.stringify({ ...needs, series: needs.series?.map(ref => ({ ...ref, labels: pointDefinitions.get(pointKey(ref.slaveId, ref.pointId)) })) });
  const stableNeeds = useMemo(() => JSON.parse(signature) as typeof needs, [signature]);
  useEffect(() => {
    if (!api) return;
    const cache = dataCacheFor(api);
    store.setState({ dataManaged: true });
    const release = cache.register(id, { ...stableNeeds, intervalMs, active }, values => {
      const current = store.getState();
      if (!current.snapshot) return;
      const live: Record<string, LiveSeries> = {};
      for (const ref of stableNeeds.series ?? []) {
        const key = pointKey(ref.slaveId, ref.pointId);
        const series = values.series[key];
        if (!series) continue;
        live[key] = { samples: series.data.samples, events: series.data.events, generation: series.generation, gap: series.gap, loading: series.hasMore,
          rangeStatus: series.rangeStatus, firstTimeMs: series.firstTimeMs, lastTimeMs: series.lastTimeMs, firstSeq: series.firstSeq };
      }
      const connections = appStore.getState().snapshot?.connections ?? current.snapshot.connections;
      const bufferError = Object.values(values.buffers).find(info => info.error)?.error ?? null;
      store.setState({ snapshot: { ...current.snapshot, points: values.points, blocks: values.blocks, connections }, live, dataBuffers: values.buffers, dataError: values.error ?? bufferError });
    });
    return () => { release(); store.setState({ dataManaged: false }); };
  }, [active, api, id, intervalMs, stableNeeds, store]);
}

export function HostRefreshControl() {
  const interval = useApp(state => state.selection.refreshMs ?? 100);
  const select = useApp(state => state.select);
  return <label className="flex shrink-0 items-center gap-2 text-xs text-ink2">刷新
    <select aria-label="界面刷新周期" className="focus-ring rounded border border-line bg-surface px-2 py-1" value={interval} onChange={event => select({ refreshMs: Number(event.target.value) })}>
      {[50, 100, 200, 500, 1000, 2000, 5000, 10000].map(value => <option key={value} value={value}>{value < 1000 ? `${value} ms` : `${value / 1000} s`}</option>)}
    </select>
  </label>;
}

export function HostDataStatus() {
  const error = useApp(state => state.dataError);
  return error ? <div role="status" className="border-b border-line bg-surface2 px-4 py-2 text-xs text-err">数据读取失败 · {error}</div> : null;
}
