import { AboutScreen } from './screens/about';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Desktop20Regular,
  Pulse20Regular,
  DataTrending20Regular,
  History20Regular,
  ArrowSync20Regular,
  Document20Regular,
  Settings20Regular,
  Info20Regular,
  Add20Regular,
  ChevronDown20Regular,
  ChevronRight20Regular,
  Search20Regular,
} from '@fluentui/react-icons';
import {
  useApp,
  useConnectionState,
  useConnectionStates,
  useRecording,
  useSessions,
  useSnapshotReady,
  useWorkspace,
  type ModuleId,
} from './store/app';
import { Button, StatusDot, TextInput, Toasts, Checkbox, slaveStatus } from './components/ui';
import { DevicesScreen } from './screens/devices';
import { RealtimeScreen } from './screens/realtime';
import { TrendScreen } from './screens/trend';
import { HistoryScreen } from './screens/history';
import { CommScreen } from './screens/comm';
import { TemplatesScreen } from './screens/templates';
import { SettingsScreen } from './screens/settings';
import { Overlays } from './screens/overlays';
import { useTranslation } from './i18n';
import { dayKey, fmtTime, todayKey } from './time';
import { copyTemplate } from '../domain/template-copy';

type RailLabelKey = `shell.rail.${'devices' | 'realtime' | 'trend' | 'history' | 'comm' | 'templates'}`;

const MODULES: Array<{ id: ModuleId; labelKey: RailLabelKey; icon: React.ReactNode }> = [
  { id: 'devices', labelKey: 'shell.rail.devices', icon: <Desktop20Regular /> },
  { id: 'realtime', labelKey: 'shell.rail.realtime', icon: <Pulse20Regular /> },
  { id: 'trend', labelKey: 'shell.rail.trend', icon: <DataTrending20Regular /> },
  { id: 'history', labelKey: 'shell.rail.history', icon: <History20Regular /> },
  { id: 'comm', labelKey: 'shell.rail.comm', icon: <ArrowSync20Regular /> },
  { id: 'templates', labelKey: 'shell.rail.templates', icon: <Document20Regular /> },
];

function TopBar() {
  const { t } = useTranslation();
  const workspaceName = useApp((s) => s.snapshot?.workspace.name ?? null);
  const online = useApp((s) => (s.snapshot ? Object.values(s.snapshot.connections).filter((c) => c.state === 'online').length : 0));
  const rec = useApp((s) => s.snapshot?.recording ?? null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsed = rec ? Math.floor((now - new Date(rec.startedUtc).getTime()) / 1000) : 0;
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-line bg-surface px-[18px]">
      <div className="flex items-baseline gap-4 min-w-0">
        <span className="text-[15px] font-bold whitespace-nowrap">{t('shell.topbar.appTitle')}</span>
        <span className="text-xs text-ink2 truncate">
          {workspaceName ?? t('shell.topbar.unnamedWorkspace')}
        </span>
      </div>
      <div className="flex items-center gap-6">
        {online > 0 ? <StatusDot tone="ok" label={t('shell.topbar.connectionsOnline', { count: online })} /> : <span className="text-xs text-ink2">{t('shell.topbar.noConnection')}</span>}
        {rec ? (
          <StatusDot tone="ok" label={t('shell.topbar.recording', { signals: rec.signalCount, elapsed: `${p(Math.floor(elapsed / 3600))}:${p(Math.floor(elapsed / 60) % 60)}:${p(elapsed % 60)}` })} />
        ) : (
          <span className="text-xs text-ink2">{t('shell.topbar.notRecording')}</span>
        )}
      </div>
    </header>
  );
}

function AppRail() {
  const { t } = useTranslation();
  const module = useApp((s) => s.module);
  const setModule = useApp((s) => s.setModule);
  return (
    <nav className="flex w-[72px] shrink-0 flex-col items-center bg-app pt-4 pb-4 gap-1">
      {MODULES.map((m) => (
        <button
          key={m.id}
          onClick={() => setModule(m.id)}
          className={`focus-ring flex h-[68px] w-[52px] cursor-pointer flex-col items-center justify-center gap-1 rounded-ctl text-[11px] ${
            module === m.id ? 'bg-accentsoft text-accent' : 'text-ink2 hover:bg-surface2'
          }`}
        >
          {m.icon}
          {t(m.labelKey)}
        </button>
      ))}
      <div className="flex-1" />
      <button
        onClick={() => setModule('settings')}
        className={`focus-ring flex h-[68px] w-[52px] cursor-pointer flex-col items-center justify-center gap-1 rounded-ctl text-[11px] ${
          module === 'settings' ? 'bg-accentsoft text-accent' : 'text-ink2 hover:bg-surface2'
        }`}
      >
        <Settings20Regular />
        {t('shell.rail.settings')}
      </button>
      <button onClick={() => setModule('about')} className={`focus-ring flex h-[68px] w-[52px] shrink-0 cursor-pointer flex-col items-center justify-center gap-1 rounded-ctl text-[11px] ${module === 'about' ? 'bg-accentsoft text-accent' : 'text-ink2 hover:bg-surface2'}`}>
        <Info20Regular />{t('shell.rail.about')}
      </button>
    </nav>
  );
}

function SidebarShell(props: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col bg-surface2">
      <div className="px-5 pt-5 pb-3 text-xl font-bold">{props.title}</div>
      <div className="flex-1 overflow-y-auto px-5 pb-6">{props.children}</div>
    </div>
  );
}

function TreeConnection(props: { connectionId: string; children?: React.ReactNode; actions?: React.ReactNode; onSelectConnection?: () => void }) {
  const { t } = useTranslation();
  const workspace = useWorkspace();
  const conn = workspace?.connections.find((c) => c.id === props.connectionId);
  const state = useConnectionState(props.connectionId);
  const [open, setOpen] = useState(true);
  if (!conn) return null;
  return (
    <div className="mb-2">
      <button className="focus-ring flex w-full cursor-pointer items-center justify-between rounded px-1 py-1.5 text-left" onClick={() => { setOpen(!open); props.onSelectConnection?.(); }}>
        <span className="flex items-center gap-1.5 text-sm font-medium truncate">
          {open ? <ChevronDown20Regular className="shrink-0" /> : <ChevronRight20Regular className="shrink-0" />}
          {conn.name}
        </span>
        <StatusDot tone={state === 'online' ? 'ok' : state === 'error' ? 'err' : 'idle'} label={state === 'online' ? t('shell.conn.online') : state === 'connecting' ? t('shell.conn.connecting') : t('shell.conn.offline')} />
      </button>
      {conn.transport === 'rtu' && conn.rtu ? <div className="ml-6 text-xs text-ink2">{conn.rtu.baudRate} · {conn.rtu.dataBits}{conn.rtu.parity.charAt(0).toUpperCase()}{conn.rtu.stopBits}</div> : null}
      {conn.transport === 'tcp' && conn.tcp ? <div className="ml-6 text-xs text-ink2">{conn.tcp.host}:{conn.tcp.port}</div> : null}
      {props.actions ? <div className="ml-6 mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-accent">{props.actions}</div> : null}
      {open ? <div className="ml-3 mt-1">{props.children}</div> : null}
    </div>
  );
}

function SlaveCard(props: { slaveId: string; showBlocks: boolean; selectedSlave?: boolean; selectedBlock?: string | null; onSelectSlave?: () => void; onSelectBlock?: (blockId: string) => void }) {
  const { t } = useTranslation();
  const workspace = useWorkspace();
  const slave = workspace?.slaves.find((s) => s.id === props.slaveId);
  const template = workspace?.templates.find((t) => t.id === slave?.templateId);
  const connState = useConnectionState(slave?.connectionId);
  const [open, setOpen] = useState(true);
  if (!slave) return null;
  return (
    <div className={`mb-2 rounded-ctl px-3 py-2 ${props.selectedSlave ? 'bg-accentsoft' : 'bg-surface'}`}>
      <button className="focus-ring flex w-full cursor-pointer items-center justify-between text-left" onClick={() => { setOpen(!open); props.onSelectSlave?.(); }}>
        <span className="flex items-center gap-1.5 text-sm font-medium truncate">
          {open ? <ChevronDown20Regular className="shrink-0" /> : <ChevronRight20Regular className="shrink-0" />}
          {slave.name}
        </span>
        <StatusDot {...slaveStatus(slave.enabled, connState)} />
      </button>
      <div className="ml-5 mt-0.5 text-xs text-ink2">{t('shell.slave.meta', { unitId: slave.unitId, name: template?.name ?? t('shell.slave.unboundTemplate') })}</div>
      {open && props.showBlocks && template ? (
        <div className="ml-5 mt-1.5 flex flex-col gap-1">
          {props.selectedSlave ? (
            <button className={`focus-ring cursor-pointer rounded px-2 py-1 text-left text-xs ${!props.selectedBlock ? 'bg-accentsoft text-accent font-medium' : 'text-ink2 hover:text-ink'}`} onClick={() => props.onSelectBlock?.('')}>
              {t('shell.slave.allData', { count: template.blocks.length })}
            </button>
          ) : null}
          {template.blocks.map((b) => (
            <button
              key={b.id}
              className={`focus-ring cursor-pointer rounded px-2 py-1 text-left text-xs ${props.selectedBlock === b.id ? 'bg-accentsoft text-accent font-medium' : 'text-ink2 hover:text-ink'}`}
              onClick={() => props.onSelectBlock?.(b.id)}
            >
              {b.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DevicesSidebar() {
  const { t } = useTranslation();
  const workspace = useWorkspace();
  const select = useApp((s) => s.select);
  const selection = useApp((s) => s.selection);
  const openOverlay = useApp((s) => s.openOverlay);

  return (
    <SidebarShell title={t('shell.sidebar.title.devices')}>
      <Button variant="secondary" onClick={() => openOverlay({ kind: 'dialog', id: 'add-connection' })}>
        <Add20Regular /> {t('shell.devices.addConnection')}
      </Button>
      <div className="mt-5 mb-2 text-xs text-ink2">{t('shell.devices.connectionsSlaves')}</div>
      {workspace?.connections.length === 0 ? <div className="text-xs text-ink2 py-2">{t('shell.devices.noConnections')}</div> : null}
      {workspace?.connections.map((c) => (
        <TreeConnection
          key={c.id}
          connectionId={c.id}
          onSelectConnection={() => select({ connectionId: c.id, slaveId: null, deviceView: 'topology' })}
          actions={
            <>
              <button className="focus-ring cursor-pointer hover:underline" onClick={() => select({ connectionId: c.id, deviceView: 'scan' })}>{t('shell.devices.scan')}</button>
              <button className="focus-ring cursor-pointer hover:underline" onClick={() => select({ connectionId: c.id, deviceView: 'temp' })}>{t('shell.devices.tempRead')}</button>
              <button className="focus-ring cursor-pointer hover:underline" onClick={() => openOverlay({ kind: 'dialog', id: 'add-slave', connectionId: c.id })}>{t('shell.devices.addSlave')}</button>
            </>
          }
        >
          {workspace?.slaves.filter((s) => s.connectionId === c.id).map((s) => (
            <SlaveCard key={s.id} slaveId={s.id} showBlocks selectedSlave={selection.slaveId === s.id} onSelectSlave={() => select({ slaveId: s.id, connectionId: c.id, deviceView: 'topology' })} />
          ))}
        </TreeConnection>
      ))}
    </SidebarShell>
  );
}

function RealtimeSidebar() {
  const { t } = useTranslation();
  const workspace = useWorkspace();
  const select = useApp((s) => s.select);
  const selection = useApp((s) => s.selection);
  const selSlave = workspace?.slaves.find((s) => s.id === selection.slaveId);
  const selTemplate = workspace?.templates.find((tpl) => tpl.id === selSlave?.templateId);
  const blk = selection.blockId ? selTemplate?.blocks.find((b) => b.id === selection.blockId) : undefined;
  return (
    <SidebarShell title={t('shell.sidebar.title.realtime')}>
      <div className="mb-2 text-xs text-ink2">{t('shell.realtime.connectionsDevices')}</div>
      {workspace?.connections.map((c) => (
        <TreeConnection key={c.id} connectionId={c.id}>
          {workspace?.slaves.filter((s) => s.connectionId === c.id).map((s) => (
            <SlaveCard
              key={s.id}
              slaveId={s.id}
              showBlocks
              selectedSlave={selection.slaveId === s.id}
              selectedBlock={selection.slaveId === s.id ? selection.blockId : null}
              onSelectSlave={() => select({ slaveId: s.id, connectionId: c.id, blockId: null, realtimeScope: 'device' })}
              onSelectBlock={(blockId) => select({ slaveId: s.id, connectionId: c.id, blockId: blockId || null, realtimeScope: blockId ? 'block' : 'device' })}
            />
          ))}
        </TreeConnection>
      ))}
      {selSlave && selTemplate ? (
        <>
          <div className="mt-5 mb-2 text-xs text-ink2">{t('shell.realtime.currentBlock')}</div>
          <div className="text-xs text-ink2 leading-5">
            {selection.blockId ? blk?.name ?? '—' : t('shell.realtime.allBlocks')} · {selection.blockId ? `${blk?.periodMs} ms` : `${selTemplate.blocks.map((b) => b.periodMs).join(' / ')} ms`}
            <br />
            {blk ? t('shell.realtime.blockAddress', { area: blk.area, start: blk.start, end: blk.start + blk.length - 1 }) : ''}
          </div>
        </>
      ) : (
        <>
          <div className="mt-5 mb-2 text-xs text-ink2">{t('shell.realtime.backgroundPolling')}</div>
          <div className="text-xs text-ink2 leading-5">{t('shell.realtime.selectSlaveHint')}</div>
        </>
      )}
    </SidebarShell>
  );
}

function TrendSidebar() {
  const { t } = useTranslation();
  const workspace = useWorkspace();
  const recording = useRecording();
  const select = useApp((s) => s.select);
  const selection = useApp((s) => s.selection);
  const openOverlay = useApp((s) => s.openOverlay);
  const command = useApp((s) => s.command);
  const toast = useApp((s) => s.toast);
  const group = workspace?.trendGroups.find((g) => g.id === selection.groupId);
  return (
    <SidebarShell title={t('shell.sidebar.title.trend')}>
      <Button variant="secondary" onClick={() => openOverlay({ kind: 'dialog', id: 'new-trend-group' })}>
        <Add20Regular /> {t('shell.trend.newGroup')}
      </Button>
      <div className="mt-4 flex flex-col gap-2">
        {workspace?.trendGroups.map((g) => (
          <button
            key={g.id}
            onClick={() => select({ groupId: g.id })}
            className={`focus-ring cursor-pointer rounded-ctl px-3 py-2.5 text-left ${selection.groupId === g.id ? 'bg-accentsoft' : 'bg-surface hover:bg-surface2'}`}
          >
            <div className="text-sm font-medium">{g.name}</div>
            <div className="text-xs text-ink2 mt-0.5">{t('shell.trend.signalCount', { count: g.signals.length })}{recording?.groupId === g.id ? t('shell.trend.suffixRecording') : recording ? t('shell.trend.suffixUnselected') : ''}</div>
            {recording?.groupId === g.id ? <StatusDot tone="ok" label={t('shell.trend.current')} className="mt-1" /> : null}
          </button>
        ))}
      </div>
      {group ? (
        <>
          <div className="mt-5 mb-2 text-xs text-ink2">{t('shell.trend.quickActions')}</div>
          <div className="flex flex-col gap-1.5 text-xs">
            <button className="focus-ring cursor-pointer text-left text-accent hover:underline" onClick={() => openOverlay({ kind: 'dialog', id: 'add-signal', groupId: group.id })}>{t('shell.trend.addSignal')}</button>
            <button
              className="focus-ring cursor-pointer text-left text-accent hover:underline"
              onClick={async () => {
                const ws = workspace;
                if (!ws) return;
                const copy = { ...group, id: `g-${Date.now().toString(36)}`, name: `${group.name} ${t('shell.common.copySuffix')}`, signals: group.signals.map((s) => ({ ...s, id: `sig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}` })) };
                await command({ type: 'workspace.apply', workspace: { ...ws, trendGroups: [...ws.trendGroups, copy] } });
                toast({ kind: 'success', title: t('shell.trend.groupCopiedToast') });
              }}
            >
              {t('shell.trend.duplicateGroup')}
            </button>
            <button
              className="focus-ring cursor-pointer text-left text-err hover:underline"
              onClick={async () => {
                const ws = workspace;
                if (!ws) return;
                await command({ type: 'workspace.apply', workspace: { ...ws, trendGroups: ws.trendGroups.filter((g) => g.id !== group.id) } });
                select({ groupId: null });
              }}
            >
              {t('shell.trend.deleteGroup')}
            </button>
          </div>
        </>
      ) : null}
      <div className="mt-5 mb-2 text-xs text-ink2">{t('shell.trend.dataSource')}</div>
      <div className="text-xs text-ink2 leading-5">
        <StatusDot tone="idle" label={t('shell.trend.backgroundOk')} />
        <br />
        {t('shell.trend.dataSourceHint')}
      </div>
    </SidebarShell>
  );
}

export function HistorySidebar() {
  const { t } = useTranslation();
  const allSessions = useSessions();
  const select = useApp((s) => s.select);
  const selection = useApp((s) => s.selection);
  const [query, setQuery] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [slaveFilter, setSlaveFilter] = useState('');
  const groups = useMemo(() => {
    const sessions = allSessions.filter(s => (!query || s.groupName.includes(query)) && (!fromDate || dayKey(s.startUtc) >= fromDate) && (!toDate || dayKey(s.startUtc) <= toDate) && (!groupFilter || s.groupId === groupFilter) && (!slaveFilter || s.slaveNames?.some(name => name.includes(slaveFilter))));
    const map = new Map<string, typeof sessions>();
    for (const s of sessions) {
      const key = dayKey(s.startUtc);
      const label = key === todayKey(0) ? t('shell.history.today') : key === todayKey(1) ? t('shell.history.yesterday') : key;
      map.set(label, [...(map.get(label) ?? []), s]);
    }
    return [...map.entries()];
  }, [allSessions, query, t, fromDate, toDate, groupFilter, slaveFilter]);
  return (
    <SidebarShell title={t('shell.sidebar.title.history')}>
      <div className="relative mb-4">
        <TextInput placeholder={t('shell.history.searchPlaceholder')} value={query} onChange={(e) => setQuery(e.target.value)} className="h-9 pl-8" />
        <Search20Regular className="absolute left-2 top-2 text-ink2" />
      </div>
      {groups.map(([label, list]) => (
        <div key={label} className="mb-4">
          <div className="mb-2 text-xs text-ink2">{label}</div>
          <div className="flex flex-col gap-2">
            {list.map((s) => (
              <button
                key={s.id}
                data-session-id={s.id}
                onClick={() => select({ sessionId: s.id })}
                className={`focus-ring cursor-pointer rounded-ctl px-3 py-2.5 text-left ${selection.sessionId === s.id ? 'bg-accentsoft' : 'bg-surface hover:bg-surface2'}`}
              >
                <div className="text-sm font-medium">{s.groupName}</div>
                <div className="text-xs text-ink2 mt-0.5 mono">{fmtTime(s.startUtc)} – {s.endUtc ? fmtTime(s.endUtc) : '…'}</div>
                <div className="text-xs text-ink2 mt-0.5">{t('shell.sidebar.sessionStats', { signals: s.signalCount, samples: s.sampleCount.toLocaleString() })}</div>
                <StatusDot tone={s.status === 'recording' ? 'ok' : 'ok'} label={s.status === 'recording' ? t('shell.history.recording') : t('shell.history.completed')} className="mt-1" />
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="mt-4 mb-2 text-xs text-ink2">{t('shell.history.filter')}</div>
      <div className="flex flex-col gap-2 text-xs text-ink2">
        <label>{t('shell.history.dateRange')}<TextInput aria-label="历史起始日期" type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} /><TextInput aria-label="历史结束日期" type="date" value={toDate} onChange={e => setToDate(e.target.value)} /></label>
        <label>{t('shell.history.trendGroup')}<select aria-label="历史趋势组" className="focus-ring h-9 w-full rounded-ctl border border-line bg-surface px-2" value={groupFilter} onChange={e => setGroupFilter(e.target.value)}><option value="">全部</option>{[...new Map(allSessions.map(s => [s.groupId, s.groupName])).entries()].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        <label>{t('shell.history.deviceSlave')}<TextInput aria-label="历史从站筛选" value={slaveFilter} onChange={e => setSlaveFilter(e.target.value)} /></label>
        <Button size="sm" onClick={() => { setFromDate(''); setToDate(''); setGroupFilter(''); setSlaveFilter(''); setQuery(''); }}>清除筛选</Button>
      </div>
      <div className="mt-6 text-xs text-ink2">{t('shell.history.dbInfo', { count: allSessions.length })}</div>
    </SidebarShell>
  );
}

function CommSidebar() {
  const { t } = useTranslation();
  const workspace = useWorkspace();
  const connStates = useConnectionStates();
  const select = useApp((s) => s.select);
  const selection = useApp((s) => s.selection);
  const slaveFilter = useApp(s => s.commSlaveFilter);
  const resultFilter = useApp(s => s.commResultFilter);
  const setSlaveFilter = (filter: Record<string, boolean>) => useApp.setState({ commSlaveFilter: filter });
  const setResultFilter = (filter: typeof resultFilter) => useApp.setState({ commResultFilter: filter });
  return (
    <SidebarShell title={t('shell.sidebar.title.comm')}>
      <div className="mb-2 text-xs text-ink2">{t('shell.comm.view')}</div>
      <div className="flex flex-col gap-1.5 mb-4">
        <button className={`focus-ring cursor-pointer rounded-ctl px-3 py-2 text-left text-sm ${selection.commView === 'messages' ? 'bg-accentsoft text-accent font-medium' : 'bg-surface'}`} onClick={() => select({ commView: 'messages' })}>{t('shell.comm.messages')}</button>
        <button className={`focus-ring cursor-pointer rounded-ctl px-3 py-2 text-left text-sm ${selection.commView === 'health' ? 'bg-accentsoft text-accent font-medium' : 'bg-surface'}`} onClick={() => select({ commView: 'health' })}>{t('shell.comm.health')}</button>
        <button className={`focus-ring cursor-pointer rounded-ctl px-3 py-2 text-left text-sm ${selection.commView === 'trace' ? 'bg-accentsoft text-accent font-medium' : 'bg-surface'}`} onClick={() => select({ commView: 'trace' })}>{t('shell.comm.trace')}</button>
      </div>
      <div className="mb-2 text-xs text-ink2">{t('shell.comm.connections')}</div>
      {workspace?.connections.map((c) => (
        <button key={c.id} className="focus-ring mb-2 w-full cursor-pointer rounded-ctl bg-surface px-3 py-2 text-left hover:bg-surface2" onClick={() => select({ connectionId: c.id })}>
          <div className="text-sm font-medium">{c.name}</div>
          <StatusDot tone={connStates[c.id]?.state === 'online' ? 'ok' : 'idle'} label={connStates[c.id]?.state === 'online' ? t('shell.comm.connectedDetail', { detail: c.transport === 'rtu' ? `${c.rtu?.baudRate ?? ''} ${c.rtu?.dataBits ?? ''}${c.rtu?.parity.charAt(0).toUpperCase()}${c.rtu?.stopBits ?? ''}` : String(c.tcp?.host) }) : t('shell.conn.offline')} className="mt-1" />
        </button>
      ))}
      <div className="mt-4 mb-2 text-xs text-ink2">{t('shell.comm.slaveFilter')}</div>
      <div className="flex flex-col gap-1.5">
        {workspace?.slaves.map((s) => (
          <Checkbox key={s.id} checked={slaveFilter[s.id] !== false} onCheckedChange={(v) => setSlaveFilter({ ...slaveFilter, [s.id]: v })} label={t('shell.slave.meta', { unitId: s.unitId, name: s.name })} />
        ))}
      </div>
      <div className="mt-4 mb-2 text-xs text-ink2">{t('shell.comm.resultFilter')}</div>
      <div className="flex flex-col gap-1.5">
        <Checkbox checked={resultFilter.ok} onCheckedChange={(v) => setResultFilter({ ...resultFilter, ok: v })} label={t('shell.comm.resultOk')} />
        <Checkbox checked={resultFilter.timeout} onCheckedChange={(v) => setResultFilter({ ...resultFilter, timeout: v })} label={t('shell.comm.resultTimeout')} />
        <Checkbox checked={resultFilter.exception} onCheckedChange={(v) => setResultFilter({ ...resultFilter, exception: v })} label={t('shell.comm.resultException')} />
        <Checkbox checked={resultFilter.other} onCheckedChange={(v) => setResultFilter({ ...resultFilter, other: v })} label="其他错误" />
      </div>
      <div className="mt-4 mb-2 text-xs text-ink2">{t('shell.comm.capture')}</div>
      <div className="flex flex-col gap-1.5 text-xs text-ink2">
        <span>{t('shell.comm.autoScroll')}</span>
        <span>{t('shell.comm.keepRawFrames')}</span>
        <span>{t('shell.comm.maxEntries')}</span>
      </div>
    </SidebarShell>
  );
}

function TemplatesSidebar() {
  const { t } = useTranslation();
  const workspace = useWorkspace();
  const select = useApp((s) => s.select);
  const selection = useApp((s) => s.selection);
  const openOverlay = useApp((s) => s.openOverlay);
  const command = useApp((s) => s.command);
  const toast = useApp((s) => s.toast);
  return (
    <SidebarShell title={t('shell.sidebar.title.templates')}>
      <Button
        variant="secondary"
        onClick={async () => {
          const ws = workspace;
          if (!ws) return;
          const id = `tpl-${Date.now().toString(36)}`;
          await command({ type: 'workspace.apply', workspace: { ...ws, templates: [...ws.templates, { id, name: t('shell.templates.newTemplateName'), version: '1.0', description: '', blocks: [], points: [] }] } });
          select({ templateId: id });
        }}
      >
        <Add20Regular /> {t('shell.templates.newTemplate')}
      </Button>
      <div className="mt-4 flex flex-col gap-2">
        {workspace?.templates.map((tpl) => {
          const bound = workspace?.slaves.filter((s) => s.templateId === tpl.id).length ?? 0;
          return (
            <button key={tpl.id} onClick={() => select({ templateId: tpl.id })} className={`focus-ring cursor-pointer rounded-ctl px-3 py-2.5 text-left ${selection.templateId === tpl.id ? 'bg-accentsoft' : 'bg-surface hover:bg-surface2'}`}>
              <div className="text-sm font-medium">{tpl.name}</div>
              <div className="text-xs text-ink2 mt-0.5">{t('shell.templates.templateStats', { blocks: tpl.blocks.length, points: tpl.points.length })}</div>
              {bound > 0 ? <div className="text-xs text-accent mt-0.5">{t('shell.templates.boundSlaves', { count: bound })}</div> : null}
            </button>
          );
        })}
      </div>
      <div className="mt-5 mb-2 text-xs text-ink2">{t('shell.templates.operations')}</div>
      <div className="flex flex-col gap-1.5 text-xs text-accent">
        <button className="focus-ring cursor-pointer text-left hover:underline" onClick={() => openOverlay({ kind: 'screen', id: 'import-registers', templateId: selection.templateId ?? workspace?.templates[0]?.id ?? '' })}>{t('shell.templates.importRegisters')}</button>
        <button
          className="focus-ring cursor-pointer text-left hover:underline"
          onClick={async () => {
            const tpl = workspace?.templates.find((x) => x.id === selection.templateId) ?? workspace?.templates[0];
            if (!tpl) return;
            const text = JSON.stringify(tpl, null, 2);
            await navigator.clipboard.writeText(text);
            toast({ kind: 'success', title: t('shell.templates.copiedToast') });
          }}
        >
          {t('shell.templates.exportTemplate')}
        </button>
        <button
          className="focus-ring cursor-pointer text-left hover:underline"
          onClick={async () => {
            const ws = workspace;
            const tpl = ws?.templates.find((x) => x.id === selection.templateId) ?? ws?.templates[0];
            if (!ws || !tpl) return;
            const copy = copyTemplate(tpl, `tpl-${Date.now().toString(36)}`, `${tpl.name} ${t('shell.common.copySuffix')}`);
            const res = await command({ type: 'workspace.apply', workspace: { ...ws, templates: [...ws.templates, copy] } });
            if (res.ok) select({ templateId: copy.id, templateEditing: false });
          }}
        >
          {t('shell.templates.duplicateTemplate')}
        </button>
      </div>
    </SidebarShell>
  );
}

const SETTINGS_SECTIONS = [
  { id: 'workspace', key: 'shell.settings.section.workspace' },
  { id: 'display', key: 'shell.settings.section.display' },
  { id: 'importCompat', key: 'shell.settings.section.importCompat' },
  { id: 'recordingStorage', key: 'shell.settings.section.recordingStorage' },
  { id: 'writeSafety', key: 'shell.settings.section.writeSafety' },
  { id: 'log', key: 'shell.settings.section.log' },
] as const;

function SettingsSidebar() {
  const { t } = useTranslation();
  const select = useApp((s) => s.select);
  const selection = useApp((s) => s.selection);
  const [active, setActive] = useState<string>('workspace');
  void select;
  void selection;
  return (
    <SidebarShell title={t('shell.sidebar.title.settings')}>
      <div className="flex flex-col gap-1">
        {SETTINGS_SECTIONS.map((it) => (
          <button key={it.id} className={`focus-ring cursor-pointer rounded-ctl px-3 py-2 text-left text-sm ${active === it.id ? 'bg-accentsoft text-accent font-medium' : 'hover:bg-surface2'}`} onClick={() => { setActive(it.id); document.getElementById(`settings-${it.id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }}>
            {t(it.key)}
          </button>
        ))}
      </div>
    </SidebarShell>
  );
}

function Sidebar() {
  const { t } = useTranslation();
  const module = useApp((s) => s.module);
  const width = useApp((s) => s.sidebarWidth);
  const setWidth = useApp((s) => s.setSidebarWidth);
  const dragging = useRef(false);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragging.current) return;
      setWidth(e.clientX - 72);
    };
    const up = () => {
      dragging.current = false;
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [setWidth]);
  if (module === 'about') return null;
  const body =
    module === 'devices' ? <DevicesSidebar /> : module === 'realtime' ? <RealtimeSidebar /> : module === 'trend' ? <TrendSidebar /> : module === 'history' ? <HistorySidebar /> : module === 'comm' ? <CommSidebar /> : module === 'templates' ? <TemplatesSidebar /> : <SettingsSidebar />;
  return (
    <div className="relative shrink-0" style={{ width }}>
      {body}
      <div
        className="absolute right-0 top-0 h-full w-[6px] cursor-col-resize hover:bg-accent/30"
        onMouseDown={() => {
          dragging.current = true;
        }}
        onDoubleClick={() => setWidth(244)}
        title={t('shell.sidebar.resizeHint')}
      />
    </div>
  );
}

function Main() {
  const module = useApp((s) => s.module);
  return (
    <main className="min-w-0 flex-1 overflow-y-auto bg-app">
      <div className="px-7 py-6 min-w-0">
        {module === 'devices' ? <DevicesScreen /> : module === 'realtime' ? <RealtimeScreen /> : module === 'trend' ? <TrendScreen /> : module === 'history' ? <HistoryScreen /> : module === 'comm' ? <CommScreen /> : module === 'templates' ? <TemplatesScreen /> : module === 'about' ? <AboutScreen /> : <SettingsScreen />}
      </div>
    </main>
  );
}

export function App() {
  const { t } = useTranslation();
  // Subscribing to the whole snapshot here would re-render the entire tree on every delta
  // (up to 10/s while polling) and defeat every narrow selector below.
  const ready = useSnapshotReady();
  const bootPending = useApp(s => s.snapshot?.update?.bootPending);
  const command = useApp(s => s.command);
  useEffect(() => { if (ready && bootPending) void command({type:'update.confirmBoot'}); }, [ready,bootPending,command]);
  if (!ready) return <div className="flex h-full items-center justify-center text-ink2">{t('shell.loading')}</div>;
  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <AppRail />
        <Sidebar />
        <Main />
      </div>
      <Overlays />
      <Toasts />
    </div>
  );
}
