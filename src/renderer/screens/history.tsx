import React, { useEffect, useMemo, useState } from 'react';
import { useApp, useSessions, useSnapshotReady } from '../store/app';
import { Button, InfoBand, PageHeader, StatusDot, Tabs } from '../components/ui';
import { NumericChart, type LineSeries } from '../components/chart';
import { StateTrack } from '../components/state-track';
import { DataTable, type Column } from '../components/table';

interface SessionSchemaEntry {
  signalId: string;
  pointName: string;
  rawType: string;
  unit: string;
  recordMode: string;
  enumMap: Record<string, string>;
  connectionName: string;
  slaveName: string;
  blockName: string;
}

interface SessionData {
  detail: {
    id: string;
    groupName: string;
    startUtc: string;
    endUtc: string | null;
    schema: SessionSchemaEntry[];
    sampleCount: number;
    eventCount: number;
    sizeBytes: number;
  };
  samples: Array<{ signalId: string; tMs: number; value: number }>;
  events: Array<{ signalId: string; tMs: number; kind: string; value: string }>;
  rawComm: Array<{ tMs: number; direction: string; hex: string }>;
}

const COLORS = ['#0078D4', '#D97706', '#178A4D', '#7A5AF8', '#C42B1C', '#0E7C86'];

export function HistoryScreen() {
  const sessions = useSessions();
  const ready = useSnapshotReady();
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const command = useApp((s) => s.command);
  const toast = useApp((s) => s.toast);
  const [data, setData] = useState<SessionData | null>(null);
  const [replay, setReplay] = useState(false);
  const [cursorMs, setCursorMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  const session = sessions.find((s) => s.id === selection.sessionId) ?? sessions[0];

  const sessionId = session?.id ?? null;
  useEffect(() => {
    let cancelled = false;
    if (!sessionId) {
      setData(null);
      return;
    }
    void command<{ detail: SessionData['detail']; samples: SessionData['samples']; events: SessionData['events']; rawComm: SessionData['rawComm'] }>({ type: 'history.sessionData', sessionId }).then((res) => {
      if (!cancelled && res.ok) setData(res.value as SessionData);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, command]);

  useEffect(() => {
    if (!playing || !data) return;
    const t = setInterval(() => {
      setCursorMs((c) => {
        const total = totalMs(data);
        const next = c + 500 * speed;
        if (next >= total) {
          setPlaying(false);
          return total;
        }
        return next;
      });
    }, 500);
    return () => clearInterval(t);
  }, [playing, speed, data]);

  const total = data ? totalMs(data) : 0;

  const series = useMemo<LineSeries[]>(() => {
    if (!data) return [];
    return data.detail.schema
      .filter((s) => s.recordMode === 'samples')
      .map((s, i) => ({
        name: s.pointName,
        color: COLORS[i % COLORS.length] ?? '#0078D4',
        data: data.samples.filter((x) => x.signalId === s.signalId).map((x) => [x.tMs, x.value] as [number, number]),
      }));
  }, [data]);

  if (!ready) return null;
  if (!session || !data) {
    return (
      <>
        <PageHeader title="历史" subtitle="回放主动记录的会话" />
        <InfoBand tone="blue">还没有记录会话。在趋势模块选择趋势组后点击“开始记录”。</InfoBand>
      </>
    );
  }

  const schema = data.detail.schema;
  const startMs = new Date(data.detail.startUtc).getTime();

  const exportCsv = () => {
    const lines: string[] = ['signal,t_ms,value'];
    for (const s of data.samples) lines.push(`${s.signalId},${s.tMs},${s.value}`);
    for (const e of data.events) lines.push(`${e.signalId},${e.tMs},"${e.value}"`);
    void navigator.clipboard.writeText(lines.join('\n'));
    toast({ kind: 'success', title: 'CSV 已复制到剪贴板' });
  };

  if (replay) {
    const cursorEvents = data.events.filter((e) => e.tMs <= cursorMs);
    return (
      <>
        <PageHeader
          title={`${data.detail.groupName} · 空载测试`}
          subtitle={`离线回放 · ${data.detail.startUtc.replace('T', ' ').slice(0, 19)}`}
          actions={<Button onClick={() => setReplay(false)}>返回历史</Button>}
        />
        <div className="mb-4 flex items-center gap-4 rounded-card bg-surface2 px-4 py-3">
          <Button variant="primary" size="sm" onClick={() => setPlaying(!playing)}>{playing ? '暂停' : '▶ 播放'}</Button>
          <span className="text-xs text-ink2">速度</span>
          <select className="focus-ring h-8 rounded-ctl border border-line bg-surface px-2 text-xs" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            <option value={1}>1 ×</option>
            <option value={2}>2 ×</option>
            <option value={4}>4 ×</option>
          </select>
          <span className="text-xs mono">{fmt(cursorMs)} / {fmt(total)}</span>
          <input type="range" min={0} max={total} value={cursorMs} onChange={(e) => setCursorMs(Number(e.target.value))} className="flex-1 accent-[#0078D4]" />
          <button className="focus-ring cursor-pointer text-xs text-accent" onClick={() => jumpEvent(data, cursorMs, -1, setCursorMs)}>上一事件</button>
          <button className="focus-ring cursor-pointer text-xs text-accent" onClick={() => jumpEvent(data, cursorMs, 1, setCursorMs)}>下一事件</button>
        </div>
        <div className="rounded-card border border-line bg-surface p-4 relative">
          <NumericChart series={series.map((s) => ({ ...s, data: s.data.filter(([t]) => t <= cursorMs) }))} height={280} startMs={0} endMs={total} />
          <div className="text-center text-xs text-[#7A5AF8] mono">{fmt(cursorMs)}</div>
        </div>
        <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
          <div>
            <div className="text-sm font-bold mb-3">游标时刻数据</div>
            <div className="rounded-card border border-line bg-surface">
              {schema.map((s) => {
                const samples = data.samples.filter((x) => x.signalId === s.signalId && x.tMs <= cursorMs);
                const last = samples[samples.length - 1];
                const ev = cursorEvents.filter((e) => e.signalId === s.signalId).slice(-1)[0];
                return (
                  <div key={s.signalId} className="flex justify-between border-b border-[#E7EAEE] px-4 py-2.5 text-sm last:border-0">
                    <span>{s.pointName}</span>
                    <span className={s.recordMode === 'samples' ? '' : 'text-[#7A5AF8]'}>{s.recordMode === 'samples' ? (last ? `${last.value} ${s.unit}` : '—') : ev?.value ?? '—'}</span>
                  </div>
                );
              })}
            </div>
          </div>
          <div>
            <div className="text-sm font-bold mb-3">事件与通信</div>
            <div className="rounded-card border border-line bg-surface px-4 py-2">
              {cursorEvents.slice(-8).map((e, i) => (
                <div key={i} className="flex gap-4 border-b border-[#E7EAEE] py-2 text-xs last:border-0">
                  <span className="mono text-ink2">{fmt(e.tMs)}</span>
                  <span className={kindColor(e.kind)}>{kindLabel(e.kind)}</span>
                  <span className="flex-1">{e.value}</span>
                </div>
              ))}
              {data.rawComm.length ? <div className="py-2 text-xs text-ink2">原始通信 {data.rawComm.length} 条已记录</div> : null}
            </div>
          </div>
        </div>
        <InfoBand tone="blue" className="mt-6">
          <div className="text-sm font-bold text-accent">回放</div>
          <div className="text-xs mt-1"><StatusDot tone="accent" label="离线 · 不需要设备连接" /></div>
          <div className="text-xs text-ink2 mt-1"><StatusDot tone="ok" label={data.rawComm.length ? '此会话已记录原始通信' : '此会话未记录原始通信'} /></div>
        </InfoBand>
      </>
    );
  }

  const signalCols: Array<Column<(typeof schema)[number]>> = [
    { id: 'name', header: '信号', width: 180, render: (r) => <span className="font-medium">{r.pointName}</span> },
    { id: 'type', header: '类型', width: 100, render: (r) => <span className="text-xs text-ink2">{r.rawType}</span> },
    { id: 'source', header: '来源', width: 260, render: (r) => <span className="text-xs text-ink2">{r.slaveName} / {r.blockName}</span> },
    { id: 'mode', header: '记录方式', width: 160, render: (r) => <span className="text-xs">{r.recordMode === 'samples' ? '连续样本' : '初始值 + 变化'}</span> },
  ];

  const eventCols: Array<Column<(typeof data.events)[number]>> = [
    { id: 't', header: '时间', width: 100, render: (r) => <span className="mono text-xs text-ink2">{fmt(r.tMs)}</span> },
    { id: 'kind', header: '类型', width: 80, render: (r) => <span className={`text-xs ${kindColor(r.kind)}`}>{kindLabel(r.kind)}</span> },
    { id: 'value', header: '内容', width: 420, render: (r) => <span className="text-sm">{r.value}</span> },
    { id: 'result', header: '结果', width: 100, render: (r) => (r.kind === 'write' ? <span className="text-xs text-ok">成功</span> : null) },
  ];

  const sampleRows = data.samples.slice(0, 500);
  const sampleCols: Array<Column<(typeof sampleRows)[number]>> = [
    { id: 't', header: '时间', width: 110, render: (r) => <span className="mono text-xs">{fmt(r.tMs)}</span> },
    { id: 'signal', header: '信号', width: 180, render: (r) => schema.find((s) => s.signalId === r.signalId)?.pointName ?? r.signalId },
    { id: 'value', header: '值', width: 160, render: (r) => <span className="mono">{r.value}</span> },
    { id: 'unit', header: '单位', width: 80, render: (r) => schema.find((s) => s.signalId === r.signalId)?.unit ?? '' },
  ];

  return (
    <>
      <PageHeader
        title={`${data.detail.groupName}`}
        subtitle={`${data.detail.startUtc.replace('T', ' ').slice(0, 19)} – ${data.detail.endUtc ? data.detail.endUtc.replace('T', ' ').slice(0, 19) : '…'} · ${schema.length} 个信号`}
        actions={
          <>
            <Button variant="quiet" onClick={() => { setReplay(true); setCursorMs(0); }}>回放</Button>
            <Button onClick={() => toast({ kind: 'info', title: '备注功能：会话备注保存在 history.db' })}>添加备注</Button>
            <Button variant="primary" onClick={exportCsv}>导出 CSV</Button>
          </>
        }
      />
      <Tabs
        tabs={[{ id: 'trend', label: '趋势' }, { id: 'events', label: '状态与事件' }, { id: 'data', label: '数据' }, { id: 'signals', label: '信号' }]}
        active={selection.historyTab}
        onChange={(id) => select({ historyTab: id as typeof selection.historyTab })}
      />
      {selection.historyTab === 'trend' && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-4 rounded-card bg-surface2 px-4 py-2.5">
            {series.map((s) => (
              <span key={s.name} className="inline-flex items-center gap-1.5 text-xs" style={{ color: s.color }}>
                <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                {s.name}
              </span>
            ))}
            <div className="flex-1" />
            <span className="text-xs text-ink2">纵轴：按单位独立</span>
            <span className="text-xs text-ink2">时间范围：全部</span>
          </div>
          <div className="rounded-card border border-line bg-surface p-4">
            <NumericChart series={series} height={300} startMs={0} endMs={total} />
          </div>
          <div className="mt-6 rounded-card bg-surface2 p-5">
            <div className="text-sm font-bold mb-3">会话信息与事件</div>
            <div className="grid grid-cols-2 gap-6 md:grid-cols-4 text-sm mb-4">
              <div><div className="text-xs text-ink2 mb-1">记录点位</div>{schema.length}</div>
              <div><div className="text-xs text-ink2 mb-1">采样数</div>{data.detail.sampleCount.toLocaleString()}</div>
              <div><div className="text-xs text-ink2 mb-1">存储</div>SQLite · {(data.detail.sizeBytes / 1e6).toFixed(1)} MB</div>
              <div><div className="text-xs text-ink2 mb-1">事件数</div>{data.detail.eventCount}</div>
            </div>
            <DataTable columns={eventCols} rows={data.events.slice(0, 50)} rowKey={(r, i) => `${r.tMs}-${i}`} maxHeight={260} />
          </div>
        </>
      )}
      {selection.historyTab === 'events' && (
        <div className="rounded-card border border-line bg-surface2 p-4 flex flex-col gap-3">
          {schema
            .filter((s) => s.recordMode !== 'samples')
            .map((s) => {
              const events = data.events.filter((e) => e.signalId === s.signalId);
              const kind = s.rawType === 'Bool' ? 'bool' : s.rawType === 'String' ? 'string' : 'enum';
              return (
                <StateTrack
                  key={s.signalId}
                  kind={kind}
                  label={s.pointName}
                  sublabel={kind === 'bool' ? 'Bool' : kind}
                  initialValue={events[0]?.value ?? null}
                  events={events}
                  startMs={0}
                  endMs={total}
                />
              );
            })}
          {data.events.filter((e) => e.kind === 'write' || e.kind === 'connection').map((e, i) => (
            <div key={i} className="flex gap-4 text-xs">
              <span className="mono text-ink2">{fmt(e.tMs)}</span>
              <span className={kindColor(e.kind)}>{kindLabel(e.kind)}</span>
              <span>{e.value}</span>
            </div>
          ))}
        </div>
      )}
      {selection.historyTab === 'data' && <DataTable columns={sampleCols} rows={sampleRows} rowKey={(r, i) => `${r.tMs}-${r.signalId}-${i}`} maxHeight={520} />}
      {selection.historyTab === 'signals' && (
        <>
          <div className="text-sm font-bold mb-1">记录信号</div>
          <div className="text-xs text-ink2 mb-3">开始记录时冻结的信号与编码配置（Schema Snapshot，模板后续修改不影响本会话）</div>
          <DataTable columns={signalCols} rows={schema} rowKey={(r) => r.signalId} />
        </>
      )}
      <div className="mt-4 text-xs text-ink2">会话开始于 {new Date(startMs).toLocaleString('zh-CN')}</div>
    </>
  );
}

function totalMs(data: SessionData): number {
  const a = data.samples[data.samples.length - 1]?.tMs ?? 0;
  const b = data.events[data.events.length - 1]?.tMs ?? 0;
  return Math.max(a, b, 1000);
}
function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}
function kindLabel(kind: string): string {
  return kind === 'write' ? '写入' : kind === 'bool' ? 'Bool' : kind === 'enum' ? 'Enum' : kind === 'string' ? 'String' : kind === 'connection' ? '连接' : kind;
}
function kindColor(kind: string): string {
  return kind === 'write' ? 'text-accent' : kind === 'bool' ? 'text-warn' : kind === 'enum' ? 'text-warn' : kind === 'string' ? 'text-[#7A5AF8]' : kind === 'connection' ? 'text-err' : 'text-ink2';
}
function jumpEvent(data: SessionData, cursor: number, dir: 1 | -1, set: (n: number) => void): void {
  const times = data.events.map((e) => e.tMs).sort((a, b) => a - b);
  if (dir === 1) {
    const next = times.find((t) => t > cursor);
    if (next !== undefined) set(next);
  } else {
    const prev = [...times].reverse().find((t) => t < cursor);
    if (prev !== undefined) set(prev);
  }
}