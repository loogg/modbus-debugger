import React, { useMemo, useState } from 'react';
import { slaveCommunicationState, useApp, usePoints, useWorkspace, type LiveSeries } from '../store/app';
import { Button, InfoBand, PageHeader, StatusDot, Tabs } from '../components/ui';
import { NumericChart, type LineSeries } from '../components/chart';
import { StateTrack } from '../components/state-track';
import { DataTable, type Column } from '../components/table';
import { useTranslation } from '../i18n';
import { pointKey } from '../../shared/point-key';
import { HostDataStatus, HostRefreshControl, useHostData } from '../workbench/host-data';
import { bufferCapacity } from '../../domain/point-buffers';
import { BufferRangeStatus } from '../features/buffers/range-status';
import { blockReadIssue } from '../features/devices/communication-status';

const SERIES_COLORS = ['#0078D4', '#D97706', '#178A4D', '#7A5AF8', '#C42B1C', '#0E7C86'];

interface SignalRow {
  signalId: string;
  pointId: string;
  instanceKey: string;
  name: string;
  source: string;
  type: string;
  visible: boolean;
}

export function TrendScreen() {
  const { t } = useTranslation();
  const workspace = useWorkspace();
  const points = usePoints();
  const live = useApp((s) => s.live);
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const openOverlay = useApp((s) => s.openOverlay);
  const command = useApp((s) => s.command);
  const [follow, setFollow] = useState(true);
  const [paused, setPaused] = useState(false);
  const [frozenEnd, setFrozenEnd] = useState<number | null>(null);
  const [frozenLive, setFrozenLive] = useState<Record<string, LiveSeries> | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const bufferInfos = useApp(state => state.dataBuffers);
  const connections = useApp(state => state.snapshot?.connections);
  const slaveStates = useApp(state => state.snapshot?.slaveStates);
  const blocks = useApp(state => state.snapshot?.blocks);

  const group = workspace?.trendGroups.find((g) => g.id === selection.groupId) ?? workspace?.trendGroups[0];
  const windowSec = selection.trendWindowSec ?? group?.windowSec ?? 60;
  const references = group?.signals.map(signal => signal.pointRef) ?? [];
  useHostData({ points: references, buffers: references, series: selection.trendTab === 'chart' ? group?.signals.filter(signal => signal.visible).map(signal => ({ ...signal.pointRef, windowMs: windowSec * 1000, endMs: paused || !follow ? frozenEnd ?? undefined : undefined })) ?? [] : [] });
  const shownLive = paused || !follow ? frozenLive ?? live : live;

  const rows = useMemo<SignalRow[]>(() => {
    if (!workspace || !group) return [];
    return group.signals.map((sig) => {
      const point = workspace.templates.flatMap((t) => t.points).find((p) => p.id === sig.pointRef.pointId);
      const slave = workspace.slaves.find((s) => s.id === sig.pointRef.slaveId);
      const conn = workspace.connections.find((c) => c.id === sig.pointRef.connectionId);
      const block = workspace.templates.flatMap((t) => t.blocks).find((b) => b.id === point?.blockId);
      return {
        signalId: sig.id,
        pointId: sig.pointRef.pointId,
        instanceKey: pointKey(sig.pointRef.slaveId, sig.pointRef.pointId),
        name: point?.name ?? sig.pointRef.pointId,
        source: `${conn?.name ?? ''} / ${slave ? t('trend.slaveUnit', { id: slave.unitId }) : ''} / ${block?.name ?? ''}`,
        type: point?.mapping.rawType ?? '—',
        visible: sig.visible,
      };
    });
  }, [workspace, group, t]);

  if (!workspace) return null;
  if (!group) {
    return (
      <>
        <PageHeader title={t('trend.title')} subtitle={t('trend.subtitle')} actions={<Button variant="primary" onClick={() => openOverlay({ kind: 'dialog', id: 'new-trend-group' })}>{t('trend.newGroup')}</Button>} />
        <InfoBand tone="blue">{t('trend.emptyHint')}</InfoBand>
      </>
    );
  }

  const now = Date.now();
  const end = follow && !paused ? now : frozenEnd ?? now;
  const start = end - windowSec * 1000;
  const resume = () => { setPaused(false); setFollow(true); setFrozenEnd(null); setFrozenLive(null); setResetKey(key => key + 1); };
  const freeze = () => { setFrozenEnd(end); setFrozenLive(structuredClone(live)); setPaused(true); setFollow(false); };

  const series: LineSeries[] = rows
    .filter((r) => r.visible && shownLive[r.instanceKey]?.samples.length && !Object.keys(workspace.templates.flatMap(template => template.points).find(point => point.id === r.pointId)?.enumMap ?? {}).length)
    .map((r, i) => {
      const point = workspace.templates.flatMap(t => t.points).find(p => p.id === r.pointId);
      return {
        name: rows.filter(other => other.name === r.name).length > 1 ? `${r.name} · ${r.source}` : r.name,
        unit: point?.unit ?? '',
        decimalPlaces: point?.decimalPlaces,
        color: SERIES_COLORS[i % SERIES_COLORS.length] ?? '#0078D4',
        data: shownLive[r.instanceKey]?.samples ?? [],
      };
    });

  const discrete = rows.filter((r) => {
    const buf = shownLive[r.instanceKey];
    const point = workspace.templates.flatMap((t) => t.points).find((p) => p.id === r.pointId);
    return buf && point && (point.mapping.rawType === 'Bool' || point.mapping.rawType === 'String' || Object.keys(point.enumMap).length > 0);
  });

  const cols: Array<Column<SignalRow>> = [
    {
      id: 'visible',
      header: t('trend.colVisible'),
      width: 56,
      render: (r) => (
        <button
          className="focus-ring cursor-pointer"
          title={r.visible ? t('trend.hideChart') : t('trend.showChart')}
          onClick={() => {
            void command({ type: 'trend.setSignalVisible', groupId: group.id, signalId: r.signalId, visible: !r.visible });
          }}
        >
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: r.visible ? SERIES_COLORS[rows.indexOf(r) % SERIES_COLORS.length] : '#D9DEE5' }} />
        </button>
      ),
    },
    { id: 'name', header: t('trend.colSignal'), width: 180, render: (r) => <span className="font-medium">{r.name}</span> },
    { id: 'source', header: t('trend.colSource'), width: 260, render: (r) => <span className="text-xs text-ink2">{r.source}</span> },
    {
      id: 'value',
      header: t('trend.colValue'),
      width: 150,
      render: (r) => {
        const v = points[r.instanceKey];
        return <span className={v?.enumLabel || v?.boolValue !== null && v?.boolValue !== undefined ? 'text-accent font-medium' : ''}>{v?.hasValue ? v.engText : '—'}</span>;
      },
    },
    { id: 'type', header: t('trend.colType'), width: 110, render: (r) => <span className="text-xs text-ink2">{r.type}</span> },
    { id: 'buffer', header: '采样缓冲', width: 190, render: row => {
      const ref = group.signals.find(signal => signal.id === row.signalId)!.pointRef;
      const info = bufferInfos[row.instanceKey];
      return <div className="flex items-center gap-3 text-xs"><button className="focus-ring text-accent" aria-label={`${row.name} 缓冲容量`} onClick={() => openOverlay({ kind: 'dialog', id: 'point-buffer', pointRef: ref })}>{info?.count ?? 0} / {bufferCapacity(workspace, ref)}</button><button className="focus-ring text-accent" aria-label={`导出 ${row.name}`} onClick={() => openOverlay({ kind: 'dialog', id: 'buffer-export', points: [ref], name: row.name })}>导出</button></div>;
    } },
    { id: 'status', header: t('trend.colStatus'), width: 128, render: row => {
      const ref = group.signals.find(signal => signal.id === row.signalId)!.pointRef;
      const point = workspace.templates.flatMap(template => template.points).find(item => item.id === ref.pointId);
      const slave = workspace.slaves.find(item => item.id === ref.slaveId);
      const state = slaveCommunicationState(connections && { connections, slaveStates }, slave);
      const block = blocks?.[pointKey(ref.slaveId, point?.blockId ?? '')];
      const issue = blockReadIssue(state, block);
      if (issue) return <StatusDot {...issue} />;
      if (!points[row.instanceKey]?.hasValue) return <StatusDot tone="idle" label="未采集" />;
      if (points[row.instanceKey]?.finite === false) return <StatusDot tone="warn" label="无效值" />;
      return <StatusDot tone="ok" label="正常" />;
    } },
    {
      id: 'op',
      header: t('trend.colOp'),
      width: 80,
      render: (r) => (
        <button
          className="focus-ring cursor-pointer text-xs text-accent hover:underline"
          onClick={() => {
            void command({ type: 'trend.removeSignal', groupId: group.id, signalId: r.signalId });
          }}
        >
          {t('trend.remove')}
        </button>
      ),
    },
  ];

  const slaveCount = new Set(group.signals.map((s) => s.pointRef.slaveId)).size;
  const blockCount = new Set(group.signals.map((s) => {
    const p = workspace.templates.flatMap((t) => t.points).find((x) => x.id === s.pointRef.pointId);
    return p?.blockId;
  })).size;

  return (
    <>
      <PageHeader
        title={group.name}
        subtitle={t('trend.headerSubtitle', { signals: group.signals.length, slaves: slaveCount, blocks: blockCount })}
        actions={
          <>
            <Button onClick={() => openOverlay({ kind: 'dialog', id: 'add-signal', groupId: group.id })}>{t('trend.addSignal')}</Button>
            <HostRefreshControl />
            <Button variant="primary" disabled={!references.length} onClick={() => openOverlay({ kind: 'dialog', id: 'buffer-export', points: references, name: group.name })}>导出采样数据</Button>
          </>
        }
      />
      <HostDataStatus />
      <div className="flex items-center justify-between">
        <Tabs tabs={[{ id: 'signals', label: t('trend.tabSignals') }, { id: 'chart', label: t('trend.tabChart') }]} active={selection.trendTab} onChange={(id) => select({ trendTab: id as 'signals' | 'chart' })} />
        <div className="flex items-center gap-4 pb-2">
          {selection.trendTab === 'chart' ? (
            <>
              <span className={`text-xs ${paused || !follow ? 'text-warn' : 'text-ink2'}`}>{paused || !follow ? '已暂停' : '实时'}</span>
              <select aria-label="趋势时间窗口" className="focus-ring h-8 rounded-ctl border border-line bg-surface px-2 text-xs" value={windowSec} onChange={(e) => { select({ trendWindowSec: Number(e.target.value) }); resume(); }}>
                {![30, 60, 300].includes(windowSec) && <option value={windowSec}>{windowSec} s</option>}
                <option value={30}>{t('trend.window30')}</option>
                <option value={60}>{t('trend.window60')}</option>
                <option value={300}>{t('trend.window300')}</option>
              </select>
              <button aria-pressed={follow} className="focus-ring cursor-pointer text-xs text-ink2 hover:text-ink" onClick={follow ? freeze : resume}>{t('trend.autoFollow')}</button>
              <button aria-label={paused || !follow ? '恢复跟随' : '暂停曲线'} aria-pressed={paused} className="focus-ring cursor-pointer text-xs text-accent hover:underline" onClick={paused || !follow ? resume : freeze}>{paused || !follow ? t('trend.resume') : t('trend.pause')}</button>
            </>
          ) : (
            <>
              <span className="text-xs text-ink2">{t('trend.dataSource')}</span>
              <StatusDot tone="ok" label={t('trend.refreshByBlockPeriod')} />
            </>
          )}
        </div>
      </div>

      {selection.trendTab === 'signals' ? (
        <DataTable columns={cols} rows={rows} rowKey={(r) => r.signalId} empty={t('trend.emptySignals')} />
      ) : (
        <>
          <div data-testid="trend-window" data-end-ms={end} className="rounded-card border border-line bg-surface p-4">
            <BufferRangeStatus points={references} live={live} paused={paused || !follow} startMs={start} endMs={end} />
            <div className="flex flex-wrap gap-4 px-2 pb-2">
              {Object.values(live).some(series => series.loading) && <span role="status" className="text-xs text-ink2">正在加载时间窗口…</span>}
              {series.map((s) => (
                <span key={s.name} className="inline-flex items-center gap-1.5 text-xs" style={{ color: s.color }}>
                  <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                  {s.name}
                </span>
              ))}
              <span className="text-[10px] text-ink2 self-center">{t('trend.axisPerUnit')}</span>
            </div>
            <NumericChart series={series} height={300} startMs={start} endMs={end} interactive resetKey={resetKey} updateIntervalMs={selection.refreshMs ?? 100} />
          </div>
          {discrete.length ? (
            <>
              <div className="text-sm font-bold mt-6 mb-3">{t('trend.stateAndText')}</div>
              <div className="rounded-card border border-line bg-surface2 px-4 py-3 flex flex-col gap-3">
                {discrete.map((r) => {
                  const point = workspace.templates.flatMap((t) => t.points).find((p) => p.id === r.pointId);
                  const buf = shownLive[r.instanceKey];
                  if (!point || !buf) return null;
                  const kind = point.mapping.rawType === 'Bool' ? 'bool' : point.mapping.rawType === 'String' ? 'string' : 'enum';
                  const initial = buf.events.filter(e => e.t <= start).at(-1)?.value ?? buf.events[0]?.value ?? null;
                  return (
                    <StateTrack
                      key={r.signalId}
                      kind={kind}
                      label={r.name}
                      sublabel={rows.filter(other => other.name === r.name).length > 1 ? r.source : kind === 'bool' ? t('trend.boolSublabel') : kind === 'string' ? t('trend.stringSublabel', { name: r.name }) : undefined}
                      initialValue={initial}
                      events={buf.events.filter((e) => e.t >= start && e.t <= end).map((e) => ({ tMs: e.t, value: e.value }))}
                      startMs={start}
                      endMs={end}
                    />
                  );
                })}
              </div>
            </>
          ) : null}
        </>
      )}

      <InfoBand tone="blue" className="mt-6">
        <div className="text-sm font-bold text-accent mb-1">{t('trend.dataStatus')}</div>
        <div className="text-sm">
          {group.signals.length} 个信号 · {blockCount} 个采集块 · 已缓冲 {references.reduce((sum, ref) => sum + (bufferInfos[pointKey(ref.slaveId, ref.pointId)]?.count ?? 0), 0).toLocaleString()} 个样本
          <br />
          样本按各自采集时间保存。可在信号列表调整共享容量或导出原始数据。
        </div>
        <div className="text-xs text-ink2 mt-1">{t('trend.dataSourceHint', { count: blockCount })}</div>
      </InfoBand>
    </>
  );
}
