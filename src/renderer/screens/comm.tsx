import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp, useHealth, useParseEvents, useTransactions, useWorkspace } from '../store/app';
import { Button, InfoBand, OverflowMenu, PageHeader, TextInput } from '../components/ui';
import { DataTable, type Column } from '../components/table';
import { NumericChart, type LineSeries } from '../components/chart';
import type { BlockHealth, HealthSample, ResultKind, TransactionRecord } from '../../shared/contracts';
import { fmtTimeMs } from '../time';
import { EXCEPTION_NAMES } from '../../domain/protocol';
import { useTranslation } from '../i18n';

/** ResultKind -> dictionary key; the label itself is resolved with t() at render (see resultLabel). */
const RESULT_LABEL = {
  ok: 'comm.resultOk',
  exception: 'comm.resultException',
  unexpected: 'comm.resultUnexpected',
  timeout: 'comm.resultTimeout',
  crc: 'comm.resultCrc',
  malformed: 'comm.resultMalformed',
  transport: 'comm.resultTransport',
} as const;
const RESULT_COLOR: Record<string, string> = {
  ok: 'text-ok',
  exception: 'text-err',
  unexpected: 'text-warn',
  timeout: 'text-warn',
  crc: 'text-err',
  malformed: 'text-err',
  transport: 'text-err',
};

export interface CommunicationMessageRow {
  key: string;
  transaction: TransactionRecord;
  direction: 'TX' | 'RX';
  timeUtc: string;
}

/** Newest first, capped by visible messages rather than by request/response pairs. */
export function transactionMessageRows(transactions: TransactionRecord[], limit = 200): CommunicationMessageRow[] {
  if (limit <= 0) return [];
  const rows: CommunicationMessageRow[] = [];
  for (const transaction of transactions) {
    rows.push({ key: `${transaction.traceId}:TX`, transaction, direction: 'TX', timeUtc: transaction.startUtc });
    if (transaction.responseAduHex) {
      const started = Date.parse(transaction.startUtc);
      const elapsed = transaction.durationMs;
      const timeUtc = Number.isFinite(started) && elapsed !== null && Number.isFinite(elapsed)
        ? new Date(started + Math.max(0, elapsed)).toISOString()
        : transaction.startUtc;
      rows.push({ key: `${transaction.traceId}:RX`, transaction, direction: 'RX', timeUtc });
    }
  }
  return rows.slice(-Math.max(0, limit)).reverse();
}

export function CommScreen() {
  const { t } = useTranslation();
  const resultLabel = useCallback((kind: ResultKind) => t(RESULT_LABEL[kind]), [t]);
  const workspace = useWorkspace();
  const allTransactions = useTransactions();
  const parseEvents = useParseEvents();
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const command = useApp((s) => s.command);
  const toast = useApp((s) => s.toast);
  const [search, setSearch] = useState('');
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);
  const [paused, setPaused] = useState<TransactionRecord[] | null>(null);
  const slaveFilter = useApp(s => s.commSlaveFilter);
  const resultFilter = useApp(s => s.commResultFilter);

  const connectionId = selection.connectionId ?? workspace?.connections[0]?.id ?? null;
  const connection = workspace?.connections.find((c) => c.id === connectionId);

  // Keep filters at transaction scope: a result/slave/search choice applies to both frames.
  const transactions = useMemo(() => {
    const list = (paused ?? allTransactions).filter((t) => t.connectionId === connectionId);
    return list
      .filter(tx => {
        const slave = workspace?.slaves.find(s => s.connectionId === tx.connectionId && s.unitId === tx.unitId);
        return (!slave || slaveFilter[slave.id] !== false) && resultFilter[tx.result === 'ok' ? 'ok' : tx.result === 'timeout' ? 'timeout' : tx.result === 'exception' ? 'exception' : 'other'];
      })
      .filter((t) => !onlyErrors || t.result !== 'ok')
      .filter((t) => !search || t.summary.includes(search) || String(t.functionCode).includes(search) || t.traceId.includes(search));
  }, [allTransactions, paused, connectionId, onlyErrors, search, workspace, slaveFilter, resultFilter]);
  const messageRows = useMemo(() => transactionMessageRows(transactions), [transactions]);

  const connectionName = connection?.name ?? '';
  // Stable identity is required for DataTable's row memo to bail out on unchanged rows.
  const cols = useMemo<Array<Column<CommunicationMessageRow>>>(() => [
    { id: 'time', header: t('comm.colTime'), width: 110, render: (r) => <span className="mono text-xs">{fmtTimeMs(r.timeUtc)}</span> },
    { id: 'conn', header: t('comm.colConnection'), width: 90, render: () => <span className="text-xs">{connectionName}</span> },
    { id: 'slave', header: t('comm.colSlave'), width: 80, render: (r) => <span className="text-xs">{t('comm.slaveUnit', { id: r.transaction.unitId })}</span> },
    { id: 'dir', header: t('comm.colDirection'), width: 60, render: (r) => <span className={`text-xs font-medium ${r.direction === 'RX' ? 'text-ok' : 'text-accent'}`}>{r.direction}</span> },
    { id: 'fc', header: t('comm.colFunctionCode'), width: 80, render: (r) => <span className="text-xs text-accent mono">FC{(r.direction === 'RX' && r.transaction.result === 'exception' ? r.transaction.functionCode | 0x80 : r.transaction.functionCode).toString(16).toUpperCase().padStart(2, '0')}</span> },
    { id: 'range', header: t('comm.colRangeValue'), width: 180, render: (r) => <span className="text-xs">{r.direction === 'RX' ? `${(r.transaction.responseAduHex?.length ?? 0) / 2} bytes` : r.transaction.summary}</span> },
    { id: 'result', header: t('comm.colResult'), width: 90, render: (r) => <span className={`text-xs ${r.direction === 'TX' && r.transaction.responseAduHex ? 'text-ink2' : RESULT_COLOR[r.transaction.result]}`}>{r.direction === 'TX' && r.transaction.responseAduHex ? t('comm.sent') : resultLabel(r.transaction.result)}</span> },
    { id: 'dur', header: t('comm.colDuration'), width: 90, render: (r) => <span className="text-xs text-ink2">{(r.direction === 'RX' || !r.transaction.responseAduHex) && r.transaction.durationMs !== null ? `${r.transaction.durationMs.toFixed(1)} ms` : '—'}</span> },
  ], [connectionName, resultLabel, t]);

  const handleRowClick = useCallback((r: CommunicationMessageRow) => setSelectedRowKey(r.key), []);

  if (!workspace || !connection) {
    return (
      <>
        <PageHeader title={t('comm.title')} subtitle={t('comm.emptySubtitle')} />
        <InfoBand tone="blue">{t('comm.emptyNoConnection')}</InfoBand>
      </>
    );
  }

  const selectedMessage = messageRows.find((row) => row.key === selectedRowKey) ?? messageRows[0];
  const selected = selectedMessage?.transaction;

  if (selection.commView === 'health') return <HealthView connectionId={connection.id} connectionName={connection.name} />;
  if (selection.commView === 'trace') return <TraceView connectionId={connection.id} />;

  const clearDiagnostics = async () => {
    const res = await command({ type: 'diagnostics.clear' });
    if (res.ok && paused) setPaused([]);
  };
  const exportLog = () => {
    const text = messageRows.map((row) => {
      const tx = row.transaction;
      const result = row.direction === 'TX' && tx.responseAduHex ? t('comm.sent') : resultLabel(tx.result);
      const functionCode = row.direction === 'RX' && tx.result === 'exception' ? tx.functionCode | 0x80 : tx.functionCode;
      const range = row.direction === 'RX' ? `${tx.responseAduHex!.length / 2} bytes` : tx.summary;
      const duration = row.direction === 'RX' || !tx.responseAduHex ? (tx.durationMs === null ? '—' : `${tx.durationMs.toFixed(1)} ms`) : '—';
      return `${row.timeUtc} ${row.direction} FC${functionCode.toString(16).toUpperCase().padStart(2, '0')} ${range} ${result} ${duration}`;
    }).join('\n');
    void navigator.clipboard.writeText(text);
    toast({ kind: 'success', title: t('comm.exportedToast') });
  };

  return (
    <>
      <PageHeader
        title={t('comm.title')}
        subtitle={t('comm.subtitle')}
        actions={
          <>
            <div className="hidden items-center gap-3 xl:flex">
              <Button onClick={() => select({ commView: 'health' })}>{t('comm.health')}</Button>
              <Button onClick={() => setPaused(paused ? null : [...allTransactions])}>{paused ? t('comm.resume') : t('comm.pause')}</Button>
              <Button onClick={() => { void clearDiagnostics(); }}>{t('comm.clear')}</Button>
            </div>
            <div className="flex items-center gap-2 xl:hidden">
              <Button onClick={() => setPaused(paused ? null : [...allTransactions])}>{paused ? t('comm.resume') : t('comm.pause')}</Button>
              <OverflowMenu items={[
                { label: t('comm.health'), onSelect: () => select({ commView: 'health' }) },
                { label: t('comm.clear'), onSelect: () => { void clearDiagnostics(); }, danger: true },
              ]} />
            </div>
            <Button variant="primary" onClick={exportLog}>{t('comm.exportLog')}</Button>
          </>
        }
      />
      <div className="mb-3 flex items-center gap-4 rounded-card bg-surface2 px-4 py-2.5">
        <div className="w-72">
          <TextInput className="h-8" placeholder={t('comm.searchPlaceholder')} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="flex-1" />
        <span className="text-xs text-ink2">{t('comm.recent10s')}</span>
        <button className={`focus-ring cursor-pointer text-xs ${onlyErrors ? 'text-accent font-medium' : 'text-ink2'}`} onClick={() => setOnlyErrors(!onlyErrors)}>{t('comm.onlyErrors')}</button>
        <span className="text-xs text-accent">{t('comm.autoScroll')}</span>
      </div>
      <DataTable
        columns={cols}
        rows={messageRows}
        rowKey={(r) => r.key}
        maxHeight={420}
        selectedKey={selectedMessage?.key ?? null}
        onRowClick={handleRowClick}
      />
      {selected ? (
        <>
          <div className="flex items-center justify-between mt-6 mb-3">
            <div className="text-sm font-bold">{t('comm.frameDetail')}</div>
            <button className="focus-ring cursor-pointer text-xs text-accent hover:underline" onClick={() => select({ commView: 'trace' })}>{t('comm.traceSource')}</button>
          </div>
          <div className="rounded-card bg-surface2 p-5">
            <div className={`text-xs mono mb-3 ${RESULT_COLOR[selected.result]}`}>
              {fmtTimeMs(selected.startUtc)} · {connection.name} · {t('comm.slaveUnit', { id: selected.unitId })} · {resultLabel(selected.result)}
              {selected.exceptionCode !== null ? ` · Exception ${selected.exceptionCode.toString(16).padStart(2, '0')} (${EXCEPTION_NAMES[selected.exceptionCode] ?? 'unknown'})` : ''}
            </div>
            <div className="text-xs text-ink2 mb-1">{t('comm.parse')}</div>
            <div className="text-sm mb-4">{t('comm.address')} {selected.summary} {selected.exceptionCode !== null ? t('comm.exceptionCode', { code: selected.exceptionCode.toString(16).padStart(2, '0'), name: EXCEPTION_NAMES[selected.exceptionCode] ?? '' }) : ''}</div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <div className="flex items-center justify-between text-xs text-ink2 mb-1">
                  <span>{t('comm.request')}</span>
                  <button
                    type="button"
                    className="focus-ring cursor-pointer text-accent hover:underline text-[11px]"
                    onClick={() => {
                      void navigator.clipboard.writeText(selected.requestAduHex);
                      toast({ kind: 'success', title: '已复制请求 Hex' });
                    }}
                  >
                    复制 Hex
                  </button>
                </div>
                <div className="rounded-ctl bg-surface px-3 py-2 mono text-xs select-all">{selected.requestAduHex.match(/.{1,2}/g)?.join(' ')}</div>
              </div>
              <div>
                <div className="flex items-center justify-between text-xs text-ink2 mb-1">
                  <span>{t('comm.response')}</span>
                  {selected.responseAduHex ? (
                    <button
                      type="button"
                      className="focus-ring cursor-pointer text-accent hover:underline text-[11px]"
                      onClick={() => {
                        void navigator.clipboard.writeText(selected.responseAduHex!);
                        toast({ kind: 'success', title: '已复制响应 Hex' });
                      }}
                    >
                      复制 Hex
                    </button>
                  ) : null}
                </div>
                <div className="rounded-ctl bg-surface px-3 py-2 mono text-xs select-all">{selected.responseAduHex ? selected.responseAduHex.match(/.{1,2}/g)?.join(' ') : '—'}</div>
              </div>
            </div>
          </div>
        </>
      ) : null}
      {parseEvents.length ? (
        <>
          <div className="text-sm font-bold mt-6 mb-3">{t('comm.frameErrors')}</div>
          <div className="rounded-card border border-line bg-surface px-4 py-2">
            {parseEvents.slice(-6).reverse().map((e) => (
              <div key={e.id} className="flex gap-4 border-b border-[#E7EAEE] py-2 text-xs last:border-0">
                <span className="mono text-ink2">{fmtTimeMs(e.utc)}</span>
                <span className="text-err w-20">{e.kind}</span>
                <span className="flex-1">{e.reason}</span>
                <span className="mono text-ink2">{t('comm.discardedBytes', { bytes: e.discarded })}{e.recoveredCount ? t('comm.recoveredFrames', { frames: e.recoveredCount }) : ''}</span>
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
  const { t } = useTranslation();
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
          { name: t('comm.busLoadSeries'), color: '#0078D4', data: res.value.map((s) => [s.t, s.busLoadPercent] as [number, number]) },
          { name: t('comm.p95Series'), color: '#D97706', data: res.value.map((s) => [s.t, s.p95Ms] as [number, number]) },
        ],
      });
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [command, connectionId, t]);

  const health = healthMap[connectionId];
  // Stable identity so DataTable's row memo can bail out between health refreshes.
  const healthCols = useMemo<Array<Column<BlockHealth>>>(() => [
    { id: 'block', header: t('comm.colSlaveBlock'), width: 240, render: (r) => <span className="text-sm">{t('comm.colSlave')}{r.slaveId.slice(-1)} / {r.blockName}</span> },
    { id: 'cfg', header: t('comm.colConfiguredPeriod'), width: 120, render: (r) => <span className="text-xs">{r.configuredPeriodMs} ms</span> },
    { id: 'act', header: t('comm.colActualPeriod'), width: 120, render: (r) => <span className="text-xs">{r.actualPeriodMs ? `${r.actualPeriodMs.toFixed(1)} ms` : '—'}</span> },
    { id: 'p95', header: t('comm.colP95'), width: 120, render: (r) => <span className="text-xs">{r.p95Ms ? `${r.p95Ms.toFixed(1)} ms` : '—'}</span> },
    { id: 'to', header: t('comm.colTimeoutRate'), width: 100, render: (r) => <span className="text-xs">{(r.timeoutRate * 100).toFixed(1)}%</span> },
    { id: 'op', header: t('comm.colActions'), width: 100, render: () => <button className="focus-ring cursor-pointer text-xs text-accent hover:underline" onClick={() => select({ commView: 'trace' })}>{t('comm.openTemplate')}</button> },
  ], [select, t]);

  if (!health) {
    // Health is published once per second; show a placeholder instead of a blank pane.
    return (
      <>
        <PageHeader
          title={t('comm.healthTitle', { name: props.connectionName })}
          subtitle={t('comm.healthSubtitle')}
          actions={<Button onClick={() => select({ commView: 'messages' })}>{t('comm.openCommLog')}</Button>}
        />
        <InfoBand tone="blue">{t('comm.healthEmpty')}</InfoBand>
      </>
    );
  }
  const cards = [
    { label: t('comm.cardBusLoad'), value: `${health.busLoadPercent.toFixed(0)}%`, sub: health.busLoadPercent > 80 ? <span className="text-warn">{t('comm.busLoadHigh')}</span> : <span className="text-ok">{t('comm.busLoadOk')}</span>, tone: health.busLoadPercent > 80 ? 'text-warn' : 'text-ok' },
    { label: t('comm.cardRequestRate'), value: `${health.requestRatePerSec.toFixed(1)} /s`, sub: <span className="text-ink2">{t('comm.recent1min')}</span>, tone: 'text-ink' },
    { label: t('comm.cardAvgLatency'), value: `${health.p50Ms.toFixed(1)} ms`, sub: <span className="text-ink2">{t('comm.p95Value', { value: health.p95Ms.toFixed(1) })}</span>, tone: 'text-ink' },
    { label: t('comm.cardTimeouts'), value: String(health.timeouts), sub: <span className="text-ink2">{t('comm.recent10min')}</span>, tone: health.timeouts ? 'text-warn' : 'text-ink' },
    { label: t('comm.cardCrcErrors'), value: String(health.crcErrors), sub: <span className="text-ink2">{t('comm.recent10min')}</span>, tone: health.crcErrors ? 'text-err' : 'text-ok' },
  ];

  return (
    <>
      <PageHeader title={t('comm.healthTitle', { name: props.connectionName })} subtitle={t('comm.healthSubtitle')} actions={<Button onClick={() => select({ commView: 'messages' })}>{t('comm.openCommLog')}</Button>} />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        {cards.map((c) => (
          <div key={c.label} className="rounded-card bg-surface2 px-4 py-3">
            <div className="text-xs text-ink2 mb-1">{c.label}</div>
            <div className={`text-xl font-bold ${c.tone}`}>{c.value}</div>
            <div className="text-xs mt-1">{c.sub}</div>
          </div>
        ))}
      </div>
      <div className="text-sm font-bold mt-6 mb-3">{t('comm.recent5min')}</div>
      <div className="rounded-card border border-line bg-surface p-4">
        {chart.samples > 0 ? (
          <NumericChart series={chart.series} height={180} startMs={chart.startMs} endMs={chart.endMs} />
        ) : (
          <div className="py-10 text-center text-sm text-ink2">{t('comm.chartEmpty')}</div>
        )}
        <div className="mt-1 text-right text-xs text-ink2">{t('comm.chartMeta', { samples: chart.samples })}</div>
      </div>
      <div className="text-sm font-bold mt-6 mb-3">{t('comm.blockPerformance')}</div>
      <DataTable
        columns={healthCols}
        rows={health.blocks}
        rowKey={(r) => r.blockId}
      />
    </>
  );
}

function TraceView(props: { connectionId: string }) {
  const { t } = useTranslation();
  const resultLabel = useCallback((kind: ResultKind) => t(RESULT_LABEL[kind]), [t]);
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
  const selectedSlave = workspace?.slaves.find((slave) => slave.connectionId === connectionId && slave.unitId === selected?.unitId);
  const selectedTemplate = workspace?.templates.find((template) => template.id === selectedSlave?.templateId);
  const relatedPoints = selected?.sourceKind === 'poll'
    ? selectedTemplate?.points.filter((point) => point.blockId === selected.sourceId) ?? []
    : selectedTemplate?.points.filter((point) => point.id === selected?.sourceId) ?? [];
  const traceCols = useMemo<Array<Column<TransactionRecord>>>(
    () => [
      { id: 'time', header: t('comm.colTime'), width: 110, render: (r) => <span className="mono text-xs">{fmtTimeMs(r.startUtc)}</span> },
      { id: 'conn', header: t('comm.colConnection'), width: 90, render: () => <span className="text-xs">{workspace?.connections.find(c => c.id === connectionId)?.name ?? connectionId}</span> },
      { id: 'slave', header: t('comm.colSlave'), width: 80, render: (r) => <span className="text-xs">{t('comm.slaveUnit', { id: r.unitId })}</span> },
      { id: 'fc', header: t('comm.colFunctionCode'), width: 80, render: (r) => <span className="text-xs mono">FC{r.functionCode.toString(16).toUpperCase().padStart(2, '0')}</span> },
      { id: 'range', header: t('comm.colRangeValue'), width: 200, render: (r) => <span className="text-xs">{r.summary}</span> },
      { id: 'result', header: t('comm.colResult'), width: 90, render: (r) => <span className={`text-xs ${RESULT_COLOR[r.result]}`}>{resultLabel(r.result)}</span> },
    ],
    [resultLabel, t, workspace, connectionId],
  );
  const handleTraceClick = useCallback((r: TransactionRecord) => setSelectedTrace(r.traceId), []);
  return (
    <>
      <PageHeader title={t('comm.title')} subtitle={t('comm.traceSubtitle')} />
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
            <div className="text-xs text-ink2 mb-1">{t('comm.requestSource')}</div>
            <div className="text-sm font-bold mb-3">{selected.sourceKind === 'poll' ? t('comm.sourcePoll') : selected.sourceKind === 'write' ? t('comm.sourceWrite') : selected.sourceKind === 'readback' ? t('comm.sourceReadback') : selected.sourceKind === 'temporary-read' ? t('comm.sourceTemporaryRead') : selected.sourceKind === 'scanner' ? t('comm.sourceScanner') : 'RMW'}</div>
            <div className="text-xs text-ink2 mb-1">{t('comm.device')}</div>
            <div className="text-sm mb-3">{selectedSlave?.name ?? t('comm.slaveUnit', { id: selected.unitId })} · Unit {selected.unitId}</div>
            <div className="text-xs text-ink2 mb-1">{t('comm.block')}</div>
            <div className="text-sm mb-3">{selectedTemplate?.blocks.find((block) => block.id === selected.sourceId)?.name ?? selected.sourceId ?? '—'}</div>
            <div className="text-xs text-ink2 mb-1">{t('comm.relatedPoints')}</div>
            <div className="mb-3 max-h-20 overflow-y-auto text-sm">{relatedPoints.length ? `${t('comm.pointCount', { points: relatedPoints.length })}：${relatedPoints.map((point) => point.name).join(' / ')}` : '—'}</div>
            <button className="focus-ring cursor-pointer text-xs text-accent hover:underline" onClick={() => { const point = selectedTemplate?.points.find(item => item.id === selected.sourceId); const blockId = point?.blockId ?? selected.sourceId; select({ connectionId, slaveId: selectedSlave?.id ?? null, realtimeScope: blockId ? 'block' : 'device', blockId }); setModule('realtime'); }}>{t('comm.openRealtime')}</button>
          </div>
          <div className="rounded-card border border-line bg-surface p-5">
            <div className="text-sm font-bold mb-3">{t('comm.rawFrame')}</div>
            <div className="text-xs text-ink2 mb-1">{t('comm.request')}</div>
            <div className="rounded-ctl bg-surface2 px-3 py-2 mono text-xs mb-3">{selected.requestAduHex.match(/.{1,2}/g)?.join(' ')}</div>
            <div className="text-xs text-ink2 mb-1">{t('comm.response')}</div>
            <div className="rounded-ctl bg-surface2 px-3 py-2 mono text-xs mb-3">{selected.responseAduHex ? selected.responseAduHex.match(/.{1,2}/g)?.join(' ') : '—'}</div>
            <div className="text-xs text-ink2 mb-2">{t('comm.lastDuration', { value: selected.durationMs?.toFixed(1) ?? '' })}</div>
            <button className="focus-ring cursor-pointer text-xs text-accent hover:underline" onClick={() => select({ commView: 'messages' })}>{t('comm.inspectRaw')}</button>
          </div>
        </div>
      ) : null}
      <InfoBand tone="blue" className="mt-6">
        <div className="text-sm font-bold text-accent mb-1">{t('comm.writeTrace')}</div>
        <div className="text-sm">{t('comm.writeTraceHint')}</div>
      </InfoBand>
    </>
  );
}
