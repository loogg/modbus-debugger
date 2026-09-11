import React, { useMemo, useState } from 'react';
import { useApp, usePoints, useRecording, useWorkspace } from '../store/app';
import { Button, InfoBand, PageHeader, StatusDot, Tabs } from '../components/ui';
import { NumericChart, type LineSeries } from '../components/chart';
import { StateTrack } from '../components/state-track';
import { DataTable, type Column } from '../components/table';

const SERIES_COLORS = ['#0078D4', '#D97706', '#178A4D', '#7A5AF8', '#C42B1C', '#0E7C86'];

interface SignalRow {
  signalId: string;
  pointId: string;
  name: string;
  source: string;
  type: string;
  visible: boolean;
}

export function TrendScreen() {
  const workspace = useWorkspace();
  const points = usePoints();
  const live = useApp((s) => s.live);
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const openOverlay = useApp((s) => s.openOverlay);
  const command = useApp((s) => s.command);
  const toast = useApp((s) => s.toast);
  const [windowSec, setWindowSec] = useState(60);
  const [follow, setFollow] = useState(true);
  const [paused, setPaused] = useState(false);

  const group = workspace?.trendGroups.find((g) => g.id === selection.groupId) ?? workspace?.trendGroups[0];
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
        name: point?.name ?? sig.pointRef.pointId,
        source: `${conn?.name ?? ''} / ${slave ? `从站${slave.unitId}` : ''} / ${block?.name ?? ''}`,
        type: point?.mapping.rawType ?? '—',
        visible: sig.visible,
      };
    });
  }, [workspace, group]);

  if (!workspace) return null;
  if (!group) {
    return (
      <>
        <PageHeader title="趋势" subtitle="用趋势组组织人为挑选的信号" actions={<Button variant="primary" onClick={() => openOverlay({ kind: 'dialog', id: 'new-trend-group' })}>＋ 新建趋势组</Button>} />
        <InfoBand tone="blue">还没有趋势组。趋势组直接消费后台 Block Cache，不创建独立轮询。</InfoBand>
      </>
    );
  }

  const now = Date.now();
  const end = follow && !paused ? now : now;
  const start = end - windowSec * 1000;

  const series: LineSeries[] = rows
    .filter((r) => r.visible && live[r.pointId]?.samples.length)
    .map((r, i) => ({
      name: r.name,
      color: SERIES_COLORS[i % SERIES_COLORS.length] ?? '#0078D4',
      data: (live[r.pointId]?.samples ?? []).filter(([t]) => t >= start) as Array<[number, number]>,
    }));

  const discrete = rows.filter((r) => {
    const buf = live[r.pointId];
    const point = workspace.templates.flatMap((t) => t.points).find((p) => p.id === r.pointId);
    return buf && point && (point.mapping.rawType === 'Bool' || point.mapping.rawType === 'String' || Object.keys(point.enumMap).length > 0);
  });

  const toggleRecord = async () => {
    if (recording) {
      await command({ type: 'trend.stopRecording' });
      toast({ kind: 'success', title: '记录已停止', message: '可在历史模块回放会话。' });
    } else {
      const res = await command({ type: 'trend.startRecording', groupId: group.id });
      if (res.ok) toast({ kind: 'success', title: '开始记录', message: `记录趋势组全部 ${group.signals.length} 个信号` });
    }
  };

  const cols: Array<Column<SignalRow>> = [
    {
      id: 'visible',
      header: '显示',
      width: 56,
      render: (r) => (
        <button
          className="focus-ring cursor-pointer"
          title={r.visible ? '隐藏图表' : '显示图表'}
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
    { id: 'name', header: '信号', width: 180, render: (r) => <span className="font-medium">{r.name}</span> },
    { id: 'source', header: '来源', width: 260, render: (r) => <span className="text-xs text-ink2">{r.source}</span> },
    {
      id: 'value',
      header: '当前值',
      width: 150,
      render: (r) => {
        const v = points[r.pointId];
        return <span className={v?.enumLabel || v?.boolValue !== null && v?.boolValue !== undefined ? 'text-accent font-medium' : ''}>{v?.hasValue ? v.engText : '—'}</span>;
      },
    },
    { id: 'type', header: '类型', width: 110, render: (r) => <span className="text-xs text-ink2">{r.type}</span> },
    { id: 'status', header: '状态', width: 90, render: () => <StatusDot tone="ok" label="正常" /> },
    {
      id: 'op',
      header: '操作',
      width: 80,
      render: (r) => (
        <button
          className="focus-ring cursor-pointer text-xs text-accent hover:underline"
          onClick={() => {
            const ws = workspace;
            void command({ type: 'workspace.apply', workspace: { ...ws, trendGroups: ws.trendGroups.map((g) => (g.id === group.id ? { ...g, signals: g.signals.filter((s) => s.id !== r.signalId) } : g)) } });
          }}
        >
          移除
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
        subtitle={`${group.signals.length} 个信号 · ${slaveCount} 个从站 · ${blockCount} 个数据块`}
        actions={
          <>
            <Button onClick={() => openOverlay({ kind: 'dialog', id: 'add-signal', groupId: group.id })}>＋ 添加信号</Button>
            <Button variant="primary" onClick={() => void toggleRecord()}>
              {isRecordingThis ? '■ 停止记录' : '● 开始记录'}
            </Button>
          </>
        }
      />
      <div className="-mt-3 mb-4 text-right text-xs text-ink2">记录范围：趋势组全部 {group.signals.length} 个信号</div>
      <div className="flex items-center justify-between">
        <Tabs tabs={[{ id: 'signals', label: '信号' }, { id: 'chart', label: '图表' }]} active={selection.trendTab} onChange={(id) => select({ trendTab: id as 'signals' | 'chart' })} />
        <div className="flex items-center gap-4 pb-2">
          {selection.trendTab === 'chart' ? (
            <>
              <select className="focus-ring h-8 rounded-ctl border border-line bg-surface px-2 text-xs" value={windowSec} onChange={(e) => setWindowSec(Number(e.target.value))}>
                <option value={30}>最近 30 秒</option>
                <option value={60}>最近 60 秒</option>
                <option value={300}>最近 5 分钟</option>
              </select>
              <button className="focus-ring cursor-pointer text-xs text-ink2 hover:text-ink" onClick={() => setFollow(!follow)}>自动跟随</button>
              <button className="focus-ring cursor-pointer text-xs text-accent hover:underline" onClick={() => setPaused(!paused)}>{paused ? '继续' : '暂停'}</button>
            </>
          ) : (
            <>
              <span className="text-xs text-ink2">数据源</span>
              <StatusDot tone="ok" label="按数据块周期刷新" />
            </>
          )}
        </div>
      </div>

      {selection.trendTab === 'signals' ? (
        <DataTable columns={cols} rows={rows} rowKey={(r) => r.signalId} empty="还没有趋势信号" />
      ) : (
        <>
          <div className="rounded-card border border-line bg-surface p-4">
            <div className="flex flex-wrap gap-4 px-2 pb-2">
              {series.map((s) => (
                <span key={s.name} className="inline-flex items-center gap-1.5 text-xs" style={{ color: s.color }}>
                  <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                  {s.name}
                </span>
              ))}
              <span className="text-[10px] text-ink2 self-center">纵轴按单位独立</span>
            </div>
            <NumericChart series={series} height={300} startMs={start} endMs={end} />
          </div>
          {discrete.length ? (
            <>
              <div className="text-sm font-bold mt-6 mb-3">状态与文本</div>
              <div className="rounded-card border border-line bg-surface2 px-4 py-3 flex flex-col gap-3">
                {discrete.map((r) => {
                  const point = workspace.templates.flatMap((t) => t.points).find((p) => p.id === r.pointId);
                  const buf = live[r.pointId];
                  if (!point || !buf) return null;
                  const kind = point.mapping.rawType === 'Bool' ? 'bool' : point.mapping.rawType === 'String' ? 'string' : 'enum';
                  const initial = buf.events[0]?.value ?? points[r.pointId]?.engText ?? null;
                  return (
                    <StateTrack
                      key={r.signalId}
                      kind={kind}
                      label={r.name}
                      sublabel={kind === 'bool' ? '使能 · Bool' : kind === 'string' ? `${r.name} · String` : undefined}
                      initialValue={initial}
                      events={buf.events.filter((e) => e.t >= start).map((e) => ({ tMs: e.t, value: e.value }))}
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
        <div className="text-sm font-bold text-accent mb-1">数据状态</div>
        <div className="text-sm">
          {group.signals.length} 个信号 · {blockCount} 个数据块 · {recording ? `${recording.sampleCount} 次采样` : '0 次采样'}
          <br />
          图表显示 {series.length} / {group.signals.length} · {isRecordingThis ? `记录中 ${recording ? fmtElapsed(recording.elapsedMs) : ''}` : '记录未开始'}
        </div>
        <div className="text-xs text-ink2 mt-1">数据源：{blockCount} 个数据块 · 显示/隐藏只影响图表，不影响记录范围</div>
      </InfoBand>
    </>
  );
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}