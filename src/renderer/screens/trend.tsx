import React, { useMemo, useState } from 'react';
import { useApp, usePoints, useRecording, useWorkspace } from '../store/app';
import { Button, InfoBand, PageHeader, StatusDot, Tabs } from '../components/ui';
import { NumericChart, type LineSeries } from '../components/chart';
import { StateTrack } from '../components/state-track';
import { DataTable, type Column } from '../components/table';
import { useTranslation } from '../i18n';
import { pointKey } from '../../shared/point-key';

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
  const toast = useApp((s) => s.toast);
  const [follow, setFollow] = useState(true);
  const [paused, setPaused] = useState(false);
  const [frozenEnd, setFrozenEnd] = useState<number | null>(null);

  const group = workspace?.trendGroups.find((g) => g.id === selection.groupId) ?? workspace?.trendGroups[0];
  const windowSec = group?.windowSec ?? 60;
  const recording = useRecording();
  const isRecordingThis = recording?.groupId === group?.id;

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

  const series: LineSeries[] = rows
    .filter((r) => r.visible && live[r.instanceKey]?.samples.length)
    .map((r, i) => ({
      name: rows.filter(other => other.name === r.name).length > 1 ? `${r.name} · ${r.source}` : r.name,
      unit: workspace.templates.flatMap(t => t.points).find(p => p.id === r.pointId)?.unit ?? '',
      color: SERIES_COLORS[i % SERIES_COLORS.length] ?? '#0078D4',
      data: (live[r.instanceKey]?.samples ?? []).filter(([t]) => t >= start && t <= end) as Array<[number, number]>,
    }));

  const discrete = rows.filter((r) => {
    const buf = live[r.instanceKey];
    const point = workspace.templates.flatMap((t) => t.points).find((p) => p.id === r.pointId);
    return buf && point && (point.mapping.rawType === 'Bool' || point.mapping.rawType === 'String' || Object.keys(point.enumMap).length > 0);
  });

  const toggleRecord = async () => {
    if (isRecordingThis) {
      if (!(await command({ type: 'trend.stopRecording' })).ok) return;
      toast({ kind: 'success', title: t('trend.recordStopped'), message: t('trend.recordStoppedMsg') });
    } else {
      const res = await command({ type: 'trend.startRecording', groupId: group.id });
      if (res.ok) toast({ kind: 'success', title: t('trend.recordStarted'), message: t('trend.recordStartedMsg', { count: group.signals.length }) });
    }
  };

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
            const ws = workspace;
            void command({
              type: 'workspace.apply',
              workspace: { ...ws, trendGroups: ws.trendGroups.map((g) => (g.id === group.id ? { ...g, signals: g.signals.map((s) => (s.id === r.signalId ? { ...s, visible: !s.visible } : s)) } : g)) },
            });
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
    { id: 'status', header: t('trend.colStatus'), width: 90, render: () => <StatusDot tone="ok" label={t('trend.statusOk')} /> },
    {
      id: 'op',
      header: t('trend.colOp'),
      width: 80,
      render: (r) => (
        <button
          className="focus-ring cursor-pointer text-xs text-accent hover:underline"
          onClick={() => {
            const ws = workspace;
            void command({ type: 'workspace.apply', workspace: { ...ws, trendGroups: ws.trendGroups.map((g) => (g.id === group.id ? { ...g, signals: g.signals.filter((s) => s.id !== r.signalId) } : g)) } });
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
            <Button variant="primary" disabled={Boolean(recording && !isRecordingThis)} onClick={() => void toggleRecord()}>
              {isRecordingThis ? t('trend.stopRecording') : t('trend.startRecording')}
            </Button>
          </>
        }
      />
      <div className="-mt-3 mb-4 text-right text-xs text-ink2">{t('trend.recordScope', { count: group.signals.length })}</div>
      <div className="flex items-center justify-between">
        <Tabs tabs={[{ id: 'signals', label: t('trend.tabSignals') }, { id: 'chart', label: t('trend.tabChart') }]} active={selection.trendTab} onChange={(id) => select({ trendTab: id as 'signals' | 'chart' })} />
        <div className="flex items-center gap-4 pb-2">
          {selection.trendTab === 'chart' ? (
            <>
              <select className="focus-ring h-8 rounded-ctl border border-line bg-surface px-2 text-xs" value={windowSec} onChange={(e) => void command({ type: 'workspace.apply', workspace: { ...workspace, trendGroups: workspace.trendGroups.map(g => g.id === group.id ? { ...g, windowSec: Number(e.target.value) } : g) } })}>
                <option value={30}>{t('trend.window30')}</option>
                <option value={60}>{t('trend.window60')}</option>
                <option value={300}>{t('trend.window300')}</option>
              </select>
              <button aria-pressed={follow} className="focus-ring cursor-pointer text-xs text-ink2 hover:text-ink" onClick={() => { setFrozenEnd(end); setFollow(!follow); }}>{t('trend.autoFollow')}</button>
              <button aria-pressed={paused} className="focus-ring cursor-pointer text-xs text-accent hover:underline" onClick={() => { setFrozenEnd(end); setPaused(!paused); }}>{paused ? t('trend.resume') : t('trend.pause')}</button>
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
            <div className="flex flex-wrap gap-4 px-2 pb-2">
              {series.map((s) => (
                <span key={s.name} className="inline-flex items-center gap-1.5 text-xs" style={{ color: s.color }}>
                  <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                  {s.name}
                </span>
              ))}
              <span className="text-[10px] text-ink2 self-center">{t('trend.axisPerUnit')}</span>
            </div>
            <NumericChart series={series} height={300} startMs={start} endMs={end} />
          </div>
          {discrete.length ? (
            <>
              <div className="text-sm font-bold mt-6 mb-3">{t('trend.stateAndText')}</div>
              <div className="rounded-card border border-line bg-surface2 px-4 py-3 flex flex-col gap-3">
                {discrete.map((r) => {
                  const point = workspace.templates.flatMap((t) => t.points).find((p) => p.id === r.pointId);
                  const buf = live[r.instanceKey];
                  if (!point || !buf) return null;
                  const kind = point.mapping.rawType === 'Bool' ? 'bool' : point.mapping.rawType === 'String' ? 'string' : 'enum';
                  const initial = buf.events.filter(e => e.t <= start).at(-1)?.value ?? buf.events[0]?.value ?? null;
                  return (
                    <StateTrack
                      key={r.signalId}
                      kind={kind}
                      label={r.name}
                      sublabel={kind === 'bool' ? t('trend.boolSublabel') : kind === 'string' ? t('trend.stringSublabel', { name: r.name }) : undefined}
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
          {t('trend.dataStatusLine1', { signals: group.signals.length, blocks: blockCount, samples: recording ? recording.sampleCount : 0 })}
          <br />
          {t('trend.chartShown', { shown: series.length, total: group.signals.length, record: isRecordingThis ? t('trend.recording', { elapsed: recording ? fmtElapsed(recording.elapsedMs) : '' }) : t('trend.recordNotStarted') })}
        </div>
        <div className="text-xs text-ink2 mt-1">{t('trend.dataSourceHint', { count: blockCount })}</div>
      </InfoBand>
    </>
  );
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}
