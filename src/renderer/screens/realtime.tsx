import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useApp, useBlocks, usePoints, useWorkspace } from '../store/app';
import { Button, Checkbox, InfoBand, PageHeader, StatusDot, TextInput, formatClock, useCompact } from '../components/ui';
import { ValueCell } from '../components/value-cell';
import { AREAS } from '../../domain/address';
import type { BlockDef, PointDef, SlaveDef } from '../../domain/model';
import type { BlockViewState, PointViewState } from '../../shared/snapshot';
import { useTranslation } from '../i18n';
import { pointKey } from '../../shared/point-key';

interface Row {
  type: 'group' | 'point';
  block?: BlockDef;
  point?: PointDef;
  slave?: SlaveDef;
}

const EMPTY_BLOCKS_LIST: BlockDef[] = [];
const ROW_H = 38;
const COL = { sel: 40, offset: 76, point: 180, type: 110, value: 170, unit: 70, access: 80 } as const;
const TOTAL_WIDTH = Object.values(COL).reduce((a, b) => a + b, 0);

const statusTone = (st?: string) => (st === 'ok' ? 'ok' : st === 'timeout' ? 'warn' : st === 'exception' ? 'err' : 'idle');
type StatusLabels = Readonly<Record<'ok' | 'timeout' | 'exception' | 'disabled' | 'idle', string>>;

/**
 * Status captions live in the dictionary, but this helper stays at module scope: it takes the
 * already-resolved labels instead of calling a hook, so the memoised rows keep their props.
 */
const statusLabel = (labels: StatusLabels, st?: string): string =>
  st === 'ok' ? labels.ok : st === 'timeout' ? labels.timeout : st === 'exception' ? labels.exception : st === 'disabled' ? labels.disabled : labels.idle;

/** Resolves the block-status captions once per render for the module-scope helper above. */
function useStatusLabels(): StatusLabels {
  const { t } = useTranslation();
  return useMemo(
    () => ({
      ok: t('realtime.statusOk'),
      timeout: t('realtime.statusTimeout'),
      exception: t('realtime.statusException'),
      disabled: t('realtime.statusDisabled'),
      idle: t('realtime.statusIdle'),
    }),
    [t],
  );
}

/**
 * One point row. Memoised on the values it actually paints: a poll cycle produces a new
 * PointViewState object for every point in the block, but most engineering texts are
 * unchanged, and re-rendering hundreds of rows ten times a second is what made the UI
 * feel stuck. Positioning lives in the (cheap) virtualizer wrapper, so scrolling does not
 * invalidate the memo either.
 */
const PointRow = React.memo(
  function PointRow(props: {
    point: PointDef;
    view: PointViewState | undefined;
    checked: boolean;
    onToggle: (pointId: string) => void;
  }) {
    const { point, view, checked, onToggle } = props;
    const { t } = useTranslation();
    const m = point.mapping;
    return (
      <div className={`flex h-full w-full items-center border-t border-[#E7EAEE] ${checked ? 'bg-accentsoft/40' : ''}`}>
        <div style={{ width: COL.sel }} className="px-3">
          <Checkbox checked={checked} onCheckedChange={() => onToggle(point.id)} />
        </div>
        <div style={{ width: COL.offset }} className="px-3 text-xs text-ink2 mono">
          {m.rawType === 'Bool' || m.rawType === 'BitField'
            ? `+${m.offset}${m.bitOffset ? `.${m.bitOffset}:${m.bitOffset + m.bitWidth - 1}` : ''}`
            : `+${m.offset}`}
        </div>
        <div style={{ width: COL.point }} className="px-3 sticky left-0 bg-inherit z-10 text-sm font-medium truncate">{point.name}</div>
        <div style={{ width: COL.type }} className="px-3 text-xs text-ink2">
          {m.rawType}
          {m.rawType === 'BitField' ? m.bitWidth : ''}
          {m.rawType === 'String' ? `[${m.stringLength}]` : ''}
        </div>
        <div style={{ width: COL.value }} className="px-3"><ValueCell point={point} view={view} /></div>
        <div style={{ width: COL.unit }} className="px-3 text-xs text-ink2">{point.unit || '—'}</div>
        <div style={{ width: COL.access }} className={`px-3 text-xs ${point.access === 'rw' ? 'text-accent font-medium' : 'text-ink2'}`}>
          {point.access === 'rw' ? t('realtime.accessRw') : t('realtime.accessRo')}
        </div>
      </div>
    );
  },
  (a, b) =>
    a.point === b.point &&
    a.checked === b.checked &&
    a.onToggle === b.onToggle &&
    a.view?.hasValue === b.view?.hasValue &&
    a.view?.engText === b.view?.engText &&
    a.view?.rawText === b.view?.rawText &&
    a.view?.enumLabel === b.view?.enumLabel &&
    a.view?.boolValue === b.view?.boolValue &&
    a.view?.stringValue === b.view?.stringValue,
);

const GroupRow = React.memo(function GroupRow(props: { block: BlockDef; state: BlockViewState | undefined }) {
  const st = props.state;
  const statusLabels = useStatusLabels();
  return (
    <div className="flex h-full w-full items-center justify-between bg-accentsoft/70 px-3">
      <span className="text-sm font-bold">{props.block.name}</span>
      <span className="flex items-center gap-6">
        <span className="text-xs text-ink2 mono">
          {AREAS[props.block.area]} · {props.block.start}–{props.block.start + props.block.length - 1} · {props.block.periodMs} ms
        </span>
        <StatusDot tone={statusTone(st?.status)} label={statusLabel(statusLabels, st?.status)} />
      </span>
    </div>
  );
});

export function RealtimeScreen() {
  const { t } = useTranslation();
  const statusLabels = useStatusLabels();
  const workspace = useWorkspace();
  const blockStates = useBlocks();
  const points = usePoints();
  const selection = useApp((s) => s.selection);
  const selectedPoints = useApp((s) => s.selectedPoints);
  const togglePoint = useApp((s) => s.togglePointSelected);
  const clearSelection = useApp((s) => s.clearPointSelection);
  const command = useApp((s) => s.command);
  const toast = useApp((s) => s.toast);
  const select = useApp((s) => s.select);

  React.useEffect(() => {
    if (!selection.slaveId && workspace?.slaves && workspace.slaves.length > 0) {
      const first = workspace.slaves[0];
      if (first) {
        select({ slaveId: first.id, connectionId: first.connectionId, blockId: null, realtimeScope: 'device' });
      }
    }
  }, [selection.slaveId, workspace?.slaves, select]);
  const compact = useCompact();
  const [search, setSearch] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const slave = workspace?.slaves.find((s) => s.id === selection.slaveId);
  const template = workspace?.templates.find((t) => t.id === slave?.templateId);
  const blocks = template?.blocks ?? EMPTY_BLOCKS_LIST;
  const scopeBlock = selection.realtimeScope === 'block' ? blocks.find((b) => b.id === selection.blockId) : undefined;

  // Row list depends only on the workspace/search, never on polled values: rebuilding it
  // (plus a per-block points filter) on every delta was the second hot spot on this screen.
  const rows = useMemo<Row[]>(() => {
    if (!slave || !template) return [];
    const list: Row[] = [];
    for (const block of scopeBlock ? [scopeBlock] : blocks) {
      list.push({ type: 'group', block });
      for (const point of template.points.filter((p) => p.blockId === block.id)) {
        if (search && !point.name.toLowerCase().includes(search.toLowerCase())) continue;
        list.push({ type: 'point', point, slave, block });
      }
    }
    return list;
  }, [slave, template, blocks, scopeBlock, search]);

  const pointCount = useMemo(() => rows.reduce((n, r) => (r.type === 'point' ? n + 1 : n), 0), [rows]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });

  const selectedCount = Object.keys(selectedPoints).length;
  const focusKey = slave && scopeBlock ? `${slave.id}::${scopeBlock.id}` : null;
  const focusState = focusKey ? blockStates[focusKey] : undefined;

  const selectAll = useCallback(() => {
    useApp.setState((s) => {
      const next = { ...s.selectedPoints };
      for (const r of rows) if (r.type === 'point' && r.point) next[r.point.id] = true;
      return { selectedPoints: next };
    });
  }, [rows]);

  if (!workspace) return null;
  if (!slave || !template) {
    return (
      <>
        <PageHeader title={t('realtime.title')} subtitle={t('realtime.emptySubtitle')} />
        <InfoBand tone="blue">{t('realtime.emptyHint')}</InfoBand>
      </>
    );
  }

  const joinTrend = async () => {
    const ws = workspace;
    const group = ws.trendGroups.find((g) => g.id === selection.groupId) ?? ws.trendGroups[0];
    if (!group) {
      toast({ kind: 'warning', title: t('realtime.noTrendGroup'), message: t('realtime.noTrendGroupMsg') });
      return;
    }
    const ids = Object.keys(selectedPoints);
    if (!ids.length) {
      toast({ kind: 'warning', title: t('realtime.noPointsSelected') });
      return;
    }
    const existing = new Set(group.signals.map((s) => pointKey(s.pointRef.slaveId, s.pointRef.pointId)));
    const added = ids.filter((id) => !existing.has(pointKey(slave.id, id)));
    const next = {
      ...ws,
      trendGroups: ws.trendGroups.map((g) =>
        g.id === group.id
          ? { ...g, signals: [...g.signals, ...added.map((pointId) => ({ id: `sig-${Date.now().toString(36)}-${pointId.slice(-4)}`, pointRef: { connectionId: slave.connectionId, slaveId: slave.id, pointId }, visible: true }))] }
          : g,
      ),
    };
    await command({ type: 'workspace.apply', workspace: next });
    clearSelection();
    toast({ kind: 'success', title: t('realtime.joinedTrend', { name: group.name }), message: t('realtime.joinedTrendMsg', { count: added.length }) });
  };

  return (
    <>
      <PageHeader
        title={scopeBlock ? t('realtime.title') : t('realtime.titleAllData', { name: slave.name })}
        subtitle={scopeBlock ? t('realtime.subtitleBlock', { slave: slave.name, block: scopeBlock.name }) : t('realtime.subtitleAll', { unitId: slave.unitId, template: template.name, blocks: blocks.length, points: template.points.length })}
        actions={
          <>
            {scopeBlock ? (
              <span className="inline-flex h-10 items-center rounded-ctl bg-accentsoft px-4 text-sm text-accent font-medium">● {scopeBlock.periodMs} ms</span>
            ) : null}
            <Button onClick={async () => { const res = await command({ type: 'device.refresh', slaveId: slave.id, blockId: scopeBlock?.id }); if (res.ok) toast({ kind: 'info', title: t('realtime.refreshTriggered') }); }}>{scopeBlock ? t('realtime.refreshOnce') : t('realtime.refreshAll')}</Button>
            {!scopeBlock ? <Button variant="primary" onClick={() => void joinTrend()}>{t('realtime.joinTrend')}</Button> : null}
          </>
        }
      />
      {scopeBlock ? (
        <div className="text-xs text-ink2 -mt-3 mb-4 mono">{t('realtime.scopeMeta', { area: AREAS[scopeBlock.area], start: scopeBlock.start, end: scopeBlock.start + scopeBlock.length - 1, count: scopeBlock.length })}</div>
      ) : null}

      <div className="mb-3 flex items-center gap-4 rounded-card bg-surface2 px-4 py-2.5">
        <Checkbox checked={selectedCount > 0} onCheckedChange={(v) => { if (!v) clearSelection(); else selectAll(); }} />
        <span className="text-sm text-accent font-medium">{t('realtime.selectedCount', { count: selectedCount })}</span>
        {scopeBlock ? <Button variant="primary" size="sm" onClick={() => void joinTrend()}>{t('realtime.joinTrend')}</Button> : null}
        <div className="flex-1" />
        {!scopeBlock ? (
          <div className="w-56">
            <TextInput className="h-8" placeholder={t('realtime.searchPlaceholder')} value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        ) : (
          <span className="text-xs text-ink2">{t('realtime.lastUpdate', { time: formatClock(focusState?.lastUpdateUtc) })}</span>
        )}
        <StatusDot tone={statusTone(focusState?.status ?? 'ok')} label={scopeBlock ? statusLabel(statusLabels, focusState?.status) : t('realtime.bgContinuous')} />
      </div>

      <div ref={scrollRef} className="overflow-auto rounded-card border border-line bg-surface" style={{ maxHeight: 'calc(100vh - 320px)', minHeight: 260 }}>
        <div style={{ minWidth: TOTAL_WIDTH, position: 'relative' }}>
          <div className="sticky top-0 z-20 flex bg-surface border-b border-line text-xs text-ink2">
            <div style={{ width: COL.sel }} className="px-3 py-2">{t('realtime.colSelect')}</div>
            <div style={{ width: COL.offset }} className="px-3 py-2">{t('realtime.colOffset')}</div>
            <div style={{ width: COL.point }} className="px-3 py-2 sticky left-0 bg-surface z-10">{t('realtime.colPoint')}</div>
            <div style={{ width: COL.type }} className="px-3 py-2">{t('realtime.colType')}</div>
            <div style={{ width: COL.value }} className="px-3 py-2">{t('realtime.colValue')}</div>
            <div style={{ width: COL.unit }} className="px-3 py-2">{t('realtime.colUnit')}</div>
            <div style={{ width: COL.access }} className="px-3 py-2">{t('realtime.colAccess')}</div>
          </div>
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const row = rows[vi.index];
              if (!row) return null;
              if (row.type === 'group' && row.block) {
                return (
                  <div key={vi.key} className="absolute left-0 w-full" style={{ top: vi.start, height: vi.size }}>
                    <GroupRow block={row.block} state={blockStates[`${slave.id}::${row.block.id}`]} />
                  </div>
                );
              }
              const point = row.point as PointDef;
              return (
                <div key={vi.key} className="absolute left-0 w-full" style={{ top: vi.start, height: vi.size }}>
                  <PointRow point={point} view={points[pointKey(slave.id, point.id)]} checked={!!selectedPoints[point.id]} onToggle={togglePoint} />
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="mt-2 text-right text-xs text-ink2">{t('realtime.footerFirstScreen', { shown: Math.min(pointCount, 10), total: pointCount })}{compact ? t('realtime.footerCompactSuffix') : ''}</div>

      <InfoBand tone="blue" className="mt-6">
        <div className="text-sm font-bold text-accent mb-1.5">{scopeBlock ? t('realtime.runStatus') : t('realtime.pollStatus')}</div>
        <div className="text-sm">
          {scopeBlock
            ? t('realtime.blockPollStatus', { period: scopeBlock.periodMs, updated: formatClock(focusState?.lastUpdateUtc), timeouts: focusState?.status === 'timeout' ? t('realtime.hasTimeout') : t('realtime.noTimeout') })
            : t('realtime.allPollStatus', { count: blocks.length, periods: blocks.map((b) => b.periodMs).join(' / '), updated: formatClock(slaveLastUpdate(blockStates, slave.id)) })}
        </div>
        <div className="text-xs text-ink2 mt-1">
          {t('realtime.focusPrefix')}{scopeBlock ? t('realtime.focusBlock', { name: scopeBlock.name, points: template.points.filter((p) => p.blockId === scopeBlock.id).length, writable: template.points.filter((p) => p.blockId === scopeBlock.id && p.access === 'rw').length }) : t('realtime.focusAllBlocks', { name: slave.name })}
          {' · '}{t('realtime.bgPollingPrefix')}{blocks.map((b) => `${b.name} ${b.periodMs} ms`).join(' · ')}
        </div>
      </InfoBand>
    </>
  );
}


function slaveLastUpdate(blockStates: Record<string, BlockViewState>, slaveId: string): string | null {
  let latest: string | null = null;
  for (const b of Object.values(blockStates)) {
    if (b.slaveId !== slaveId || !b.lastUpdateUtc) continue;
    if (!latest || b.lastUpdateUtc > latest) latest = b.lastUpdateUtc;
  }
  return latest;
}
