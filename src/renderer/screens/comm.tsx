import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp, useHealth, useParseEvents, useTransactions, useWorkspace } from '../store/app';
import { Button, InfoBand, PageHeader, TextInput } from '../components/ui';
import { DataTable, type Column } from '../components/table';
import { NumericChart, type LineSeries } from '../components/chart';
import type { BlockHealth, HealthSample, TransactionRecord } from '../../main/runtime/diagnostics';
import { EXCEPTION_NAMES } from '../../domain/protocol';

const RESULT_LABEL: Record<string, string> = {
  ok: '成功',
  exception: '异常',
  unexpected: '意外响应',
  timeout: '超时',
  crc: 'CRC 错',
  malformed: '坏帧',
  transport: '传输错误',
};
const RESULT_COLOR: Record<string, string> = {
  ok: 'text-ok',
  exception: 'text-err',
  unexpected: 'text-warn',
  timeout: 'text-warn',
  crc: 'text-err',
  malformed: 'text-err',
  transport: 'text-err',
};

export function CommScreen() {
  const workspace = useWorkspace();
  const allTransactions = useTransactions();
  const parseEvents = useParseEvents();
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const command = useApp((s) => s.command);
  const toast = useApp((s) => s.toast);
  const [search, setSearch] = useState('');
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [selectedTrace, setSelectedTrace] = useState<string | null>(null);

  const connectionId = selection.connectionId ?? workspace?.connections[0]?.id ?? null;
  const connection = workspace?.connections.find((c) => c.id === connectionId);

  // Narrow slice: the transactions array keeps its identity between deltas that only
  // carry point values, so this filter (up to 500 records) does not run ten times a second.
  const transactions = useMemo(() => {
    const list = allTransactions.filter((t) => t.connectionId === connectionId);
    return list
      .filter((t) => !onlyErrors || t.result !== 'ok')
      .filter((t) => !search || t.summary.includes(search) || String(t.functionCode).includes(search) || t.traceId.includes(search))
      .slice(-200)
      .reverse();
  }, [allTransactions, connectionId, onlyErrors, search]);

  const connectionName = connection?.name ?? '';
  // Stable identity is required for DataTable's row memo to bail out on unchanged rows.
  const cols = useMemo<Array<Column<TransactionRecord>>>(() => [
    { id: 'time', header: '时间', width: 110, render: (r) => <span className="mono text-xs">{r.startUtc.slice(11, 23)}</span> },
    { id: 'conn', header: '连接', width: 90, render: () => <span className="text-xs">{connectionName}</span> },
    { id: 'slave', header: '从站', width: 80, render: (r) => <span className="text-xs">从站 {r.unitId}</span> },
    { id: 'dir', header: '方向', width: 60, render: (r) => <span className={`text-xs font-medium ${r.responseAduHex || r.result !== 'ok' ? 'text-ok' : 'text-accent'}`}>{r.result === 'ok' ? 'RX' : 'TX'}</span> },
    { id: 'fc', header: '功能码', width: 80, render: (r) => <span className="text-xs text-accent mono">FC{r.functionCode.toString(16).toUpperCase().padStart(2, '0')}</span> },
    { id: 'range', header: '范围 / 数值', width: 180, render: (r) => <span className="text-xs">{r.summary}</span> },
    { id: 'result', header: '结果', width: 90, render: (r) => <span className={`text-xs ${RESULT_COLOR[r.result]}`}>{RESULT_LABEL[r.result]}</span> },
    { id: 'dur', header: '耗时', width: 90, render: (r) => <span className="text-xs text-ink2">{r.durationMs !== null ? `${r.durationMs.toFixed(1)} ms` : '—'}</span> },
  ], [connectionName]);

  const handleRowClick = useCallback((r: TransactionRecord) => setSelectedTrace(r.traceId), []);

  if (!workspace || !connection) {
    return (
      <>
        <PageHeader title="通信诊断" subtitle="实时捕获 Modbus 请求 / 响应、超时与异常帧" />
        <InfoBand tone="blue">还没有连接。添加连接后这里会显示报文与诊断。</InfoBand>
      </>
    );
  }

  const selected = allTransactions.find((t) => t.traceId === selectedTrace) ?? transactions[0];

  if (selection.commView === 'health') return <HealthView connectionId={connection.id} connectionName={connection.name} />;
  if (selection.commView === 'trace') return <TraceView connectionId={connection.id} />;



  return (
    <>
      <PageHeader
        title="通信诊断"
        subtitle="实时捕获 Modbus 请求 / 响应、超时与异常帧。"
        actions={
          <>
            <Button onClick={() => select({ commView: 'health' })}>连接健康</Button>
            <Button onClick={() => toast({ kind: 'info', title: '已暂停自动滚动' })}>暂停</Button>
            <Button onClick={() => void command({ type: 'diagnostics.clear' })}>清空</Button>
            <Button
              variant="primary"
              onClick={() => {
                const text = transactions.map((t) => `${t.startUtc} FC${t.functionCode} ${t.summary} ${RESULT_LABEL[t.result]} ${t.durationMs ?? ''}ms`).join('\n');
                void navigator.clipboard.writeText(text);
                toast({ kind: 'success', title: '日志已复制到剪贴板' });
              }}
            >
              导出日志
            </Button>
          </>
        }
      />
      <div className="mb-3 flex items-center gap-4 rounded-card bg-surface2 px-4 py-2.5">
        <div className="w-72">
          <TextInput className="h-8" placeholder="搜索地址 / 功能码 / 点位" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="flex-1" />
        <span className="text-xs text-ink2">最近 10 秒 ▾</span>
        <button className={`focus-ring cursor-pointer text-xs ${onlyErrors ? 'text-accent font-medium' : 'text-ink2'}`} onClick={() => setOnlyErrors(!onlyErrors)}>仅异常</button>
        <span className="text-xs text-accent">自动滚动</span>
      </div>
      <DataTable
        columns={cols}
        rows={transactions}
        rowKey={(r) => r.traceId}
        maxHeight={420}
        selectedKey={selected?.traceId ?? null}
        onRowClick={handleRowClick}
      />
      {selected ? (
        <>
          <div className="flex items-center justify-between mt-6 mb-3">
            <div className="text-sm font-bold">帧详情</div>
            <button className="focus-ring cursor-pointer text-xs text-accent hover:underline" onClick={() => select({ commView: 'trace' })}>来源追踪</button>
          </div>
          <div className="rounded-card bg-surface2 p-5">
            <div className={`text-xs mono mb-3 ${RESULT_COLOR[selected.result]}`}>
              {selected.startUtc.slice(11, 23)} · {connection.name} · 从站 {selected.unitId} · {RESULT_LABEL[selected.result]}
              {selected.exceptionCode !== null ? ` · Exception ${selected.exceptionCode.toString(16).padStart(2, '0')} (${EXCEPTION_NAMES[selected.exceptionCode] ?? 'unknown'})` : ''}
            </div>
            <div className="text-xs text-ink2 mb-1">解析</div>
            <div className="text-sm mb-4">地址 {selected.summary} {selected.exceptionCode !== null ? `异常码 0x${selected.exceptionCode.toString(16).padStart(2, '0')} (${EXCEPTION_NAMES[selected.exceptionCode] ?? ''})` : ''}</div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <div className="text-xs text-ink2 mb-1">请求</div>
                <div className="rounded-ctl bg-surface px-3 py-2 mono text-xs">{selected.requestAduHex.match(/.{1,2}/g)?.join(' ')}</div>
              </div>
              <div>
                <div className="text-xs text-ink2 mb-1">响应</div>
                <div className="rounded-ctl bg-surface px-3 py-2 mono text-xs">{selected.responseAduHex ? selected.responseAduHex.match(/.{1,2}/g)?.join(' ') : '—'}</div>
              </div>
            </div>
          </div>
        </>
      ) : null}
      {parseEvents.length ? (
        <>
          <div className="text-sm font-bold mt-6 mb-3">帧错误与 Resync</div>
          <div className="rounded-card border border-line bg-surface px-4 py-2">
            {parseEvents.slice(-6).reverse().map((e) => (
              <div key={e.id} className="flex gap-4 border-b border-[#E7EAEE] py-2 text-xs last:border-0">
                <span className="mono text-ink2">{e.utc.slice(11, 23)}</span>
                <span className="text-err w-20">{e.kind}</span>
                <span className="flex-1">{e.reason}</span>
                <span className="mono text-ink2">丢弃 {e.discarded} B{e.recoveredCount ? ` · 恢复 ${e.recoveredCount} 帧` : ''}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}

interface HealthChart {
  series: LineSeries[];
  startMs: number;
  endMs: number;
  samples: number;
}

const HEALTH_WINDOW_MS = 300000;

function HealthView(props: { connectionId: string; connectionName: string }) {
  const healthMap = useHealth();
  const select = useApp((s) => s.select);
  const command = useApp((s) => s.command);
  const connectionId = props.connectionId;
  const [chart, setChart] = useState<HealthChart>({ series: [], startMs: 0, endMs: 0, samples: 0 });

  // The samples are produced in Main (one per health recomputation, ~1 Hz) and pulled with a
  // command round-trip every 5 s, so the chart shows real measurements and the renderer never
  // drives bus traffic itself.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const res = await command<HealthSample[]>({ type: 'diagnostics.healthSeries', connectionId, windowMs: HEALTH_WINDOW_MS });
      if (cancelled || !res.ok) return;
      const endMs = Date.now();
      setChart({
        startMs: endMs - HEALTH_WINDOW_MS,
        endMs,
        samples: res.value.length,
        series: [
          { name: '总线负载 %', color: '#0078D4', data: res.value.map((s) => [s.t, s.busLoadPercent] as [number, number]) },
          { name: 'P95 延迟 ms', color: '#D97706', data: res.value.map((s) => [s.t, s.p95Ms] as [number, number]) },
        ],
      });
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [command, connectionId]);

  const health = healthMap[connectionId];
  // Stable identity so DataTable's row memo can bail out between health refreshes.
  const healthCols = useMemo<Array<Column<BlockHealth>>>(() => [
    { id: 'block', header: '从站 / 数据块', width: 240, render: (r) => <span className="text-sm">从站{r.slaveId.slice(-1)} / {r.blockName}</span> },
    { id: 'cfg', header: '配置周期', width: 120, render: (r) => <span className="text-xs">{r.configuredPeriodMs} ms</span> },
    { id: 'act', header: '实际周期', width: 120, render: (r) => <span className="text-xs">{r.actualPeriodMs ? `${r.actualPeriodMs.toFixed(1)} ms` : '—'}</span> },
    { id: 'p95', header: 'P95 延迟', width: 120, render: (r) => <span className="text-xs">{r.p95Ms ? `${r.p95Ms.toFixed(1)} ms` : '—'}</span> },
    { id: 'to', header: '超时率', width: 100, render: (r) => <span className="text-xs">{(r.timeoutRate * 100).toFixed(1)}%</span> },
    { id: 'op', header: '操作', width: 100, render: () => <button className="focus-ring cursor-pointer text-xs text-accent hover:underline" onClick={() => select({ commView: 'trace' })}>打开模板</button> },
  ], [select]);

  if (!health) {
    // Health is published once per second; show a placeholder instead of a blank pane.
    return (
      <>
        <PageHeader
          title={`连接健康 · ${props.connectionName}`}
          subtitle="根据实际请求统计总线负载、延迟、超时与异常。"
          actions={<Button onClick={() => select({ commView: 'messages' })}>打开通信日志</Button>}
        />
        <InfoBand tone="blue">正在统计连接健康数据，产生请求后这里会显示总线负载、延迟与错误计数。</InfoBand>
      </>
    );
  }
  const cards = [
    { label: '总线负载', value: `${health.busLoadPercent.toFixed(0)}%`, sub: health.busLoadPercent > 80 ? <span className="text-warn">偏高</span> : <span className="text-ok">健康</span>, tone: health.busLoadPercent > 80 ? 'text-warn' : 'text-ok' },
    { label: '请求速率', value: `${health.requestRatePerSec.toFixed(1)} /s`, sub: <span className="text-ink2">最近 1 min</span>, tone: 'text-ink' },
    { label: '平均延迟', value: `${health.p50Ms.toFixed(1)} ms`, sub: <span className="text-ink2">P95 {health.p95Ms.toFixed(1)} ms</span>, tone: 'text-ink' },
    { label: '超时', value: String(health.timeouts), sub: <span className="text-ink2">最近 10 min</span>, tone: health.timeouts ? 'text-warn' : 'text-ink' },
    { label: 'CRC 错误', value: String(health.crcErrors), sub: <span className="text-ink2">最近 10 min</span>, tone: health.crcErrors ? 'text-err' : 'text-ok' },
  ];

  return (
    <>
      <PageHeader title={`连接健康 · ${props.connectionName}`} subtitle="根据实际请求统计总线负载、延迟、超时与异常。" actions={<Button onClick={() => select({ commView: 'messages' })}>打开通信日志</Button>} />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        {cards.map((c) => (
          <div key={c.label} className="rounded-card bg-surface2 px-4 py-3">
            <div className="text-xs text-ink2 mb-1">{c.label}</div>
            <div className={`text-xl font-bold ${c.tone}`}>{c.value}</div>
            <div className="text-xs mt-1">{c.sub}</div>
          </div>
        ))}
      </div>
      <div className="text-sm font-bold mt-6 mb-3">最近 5 分钟</div>
      <div className="rounded-card border border-line bg-surface p-4">
        {chart.samples > 0 ? (
          <NumericChart series={chart.series} height={180} startMs={chart.startMs} endMs={chart.endMs} />
        ) : (
          <div className="py-10 text-center text-sm text-ink2">还没有健康样本；连接产生请求后这里会显示总线负载与 P95 延迟曲线。</div>
        )}
        <div className="mt-1 text-right text-xs text-ink2">{chart.samples} 个采样点 · 1 Hz · 窗口 5 分钟</div>
      </div>
      <div className="text-sm font-bold mt-6 mb-3">数据块性能</div>
      <DataTable
        columns={healthCols}
        rows={health.blocks}
        rowKey={(r) => r.blockId}
      />
    </>
  );
}

function TraceView(props: { connectionId: string }) {
  const workspace = useWorkspace();
  const allTransactions = useTransactions();
  const select = useApp((s) => s.select);
  const setModule = useApp((s) => s.setModule);
  const [selectedTrace, setSelectedTrace] = useState<string | null>(null);
  const connectionId = props.connectionId;
  const txs = useMemo(
    () => allTransactions.filter((t) => t.connectionId === connectionId).slice(-50).reverse(),
    [allTransactions, connectionId],
  );
  const selected = txs.find((t) => t.traceId === selectedTrace) ?? txs[0];
  const pointIndexName = (id: string | null) => {
    if (!id || !workspace) return null;
    const point = workspace.templates.flatMap((t) => t.points).find((p) => p.id === id);
    return point?.name ?? null;
  };
  const traceCols = useMemo<Array<Column<TransactionRecord>>>(
    () => [
      { id: 'time', header: '时间', width: 110, render: (r) => <span className="mono text-xs">{r.startUtc.slice(11, 23)}</span> },
      { id: 'conn', header: '连接', width: 90, render: () => <span className="text-xs">COM3</span> },
      { id: 'slave', header: '从站', width: 80, render: (r) => <span className="text-xs">从站 {r.unitId}</span> },
      { id: 'fc', header: '功能码', width: 80, render: (r) => <span className="text-xs mono">FC{r.functionCode.toString(16).toUpperCase().padStart(2, '0')}</span> },
      { id: 'range', header: '范围 / 数值', width: 200, render: (r) => <span className="text-xs">{r.summary}</span> },
      { id: 'result', header: '结果', width: 90, render: (r) => <span className={`text-xs ${RESULT_COLOR[r.result]}`}>{RESULT_LABEL[r.result]}</span> },
    ],
    [],
  );
  const handleTraceClick = useCallback((r: TransactionRecord) => setSelectedTrace(r.traceId), []);
  return (
    <>
      <PageHeader title="通信诊断" subtitle="请求 / 响应与设备点位之间可双向追踪。" />
      <DataTable
        columns={traceCols}
        rows={txs}
        rowKey={(r) => r.traceId}
        maxHeight={220}
        selectedKey={selected?.traceId ?? null}
        onRowClick={handleTraceClick}
      />
      {selected ? (
        <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
          <div className="rounded-card bg-surface2 p-5">
            <div className="text-xs text-ink2 mb-1">请求来源</div>
            <div className="text-sm font-bold mb-3">{selected.sourceKind === 'poll' ? '后台轮询' : selected.sourceKind === 'write' ? '写请求' : selected.sourceKind === 'readback' ? '写后回读' : selected.sourceKind === 'temporary-read' ? '临时读取' : selected.sourceKind === 'scanner' ? '从站扫描' : 'RMW'}</div>
            <div className="text-xs text-ink2 mb-1">设备</div>
            <div className="text-sm mb-3">{workspace?.slaves.find((s) => s.unitId === selected.unitId && s.connectionId === props.connectionId)?.name ?? `从站 ${selected.unitId}`} · Unit {selected.unitId}</div>
            <div className="text-xs text-ink2 mb-1">数据块</div>
            <div className="text-sm mb-3">{workspace?.templates.flatMap((t) => t.blocks).find((b) => b.id === selected.sourceId)?.name ?? selected.sourceId ?? '—'}</div>
            <div className="text-xs text-ink2 mb-1">关联点位</div>
            <div className="text-sm mb-3">{pointIndexName(selected.sourceId) ? `${pointIndexName(selected.sourceId)}` : selected.sourceKind === 'poll' ? `${workspace?.templates.flatMap((t) => t.points).filter((p) => p.blockId === selected.sourceId).length ?? 0} 个点位` : '—'}</div>
            <button className="focus-ring cursor-pointer text-xs text-accent hover:underline" onClick={() => { select({ realtimeScope: 'block', blockId: selected.sourceId }); setModule('realtime'); }}>打开实时数据</button>
          </div>
          <div className="rounded-card border border-line bg-surface p-5">
            <div className="text-sm font-bold mb-3">原始帧</div>
            <div className="text-xs text-ink2 mb-1">请求</div>
            <div className="rounded-ctl bg-surface2 px-3 py-2 mono text-xs mb-3">{selected.requestAduHex.match(/.{1,2}/g)?.join(' ')}</div>
            <div className="text-xs text-ink2 mb-1">响应</div>
            <div className="rounded-ctl bg-surface2 px-3 py-2 mono text-xs mb-3">{selected.responseAduHex ? selected.responseAduHex.match(/.{1,2}/g)?.join(' ') : '—'}</div>
            <div className="text-xs text-ink2 mb-2">最近耗时 {selected.durationMs?.toFixed(1)} ms</div>
            <button className="focus-ring cursor-pointer text-xs text-accent hover:underline" onClick={() => select({ commView: 'messages' })}>检查原始数据</button>
          </div>
        </div>
      ) : null}
      <InfoBand tone="blue" className="mt-6">
        <div className="text-sm font-bold text-accent mb-1">写请求追踪</div>
        <div className="text-sm">FC06 / FC16 写请求会记录发起点位；例如地址 6 的 FC06 可直接追踪到「目标转速」并回到实时值。</div>
      </InfoBand>
    </>
  );
}