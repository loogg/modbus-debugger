import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Desktop20Regular,
  Pulse20Regular,
  DataTrending20Regular,
  History20Regular,
  ArrowSync20Regular,
  Document20Regular,
  Settings20Regular,
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
import { Button, StatusDot, TextInput, Toasts, Checkbox } from './components/ui';
import { DevicesScreen } from './screens/devices';
import { RealtimeScreen } from './screens/realtime';
import { TrendScreen } from './screens/trend';
import { HistoryScreen } from './screens/history';
import { CommScreen } from './screens/comm';
import { TemplatesScreen } from './screens/templates';
import { SettingsScreen } from './screens/settings';
import { Overlays } from './screens/overlays';

const MODULES: Array<{ id: ModuleId; label: string; icon: React.ReactNode }> = [
  { id: 'devices', label: '设备', icon: <Desktop20Regular /> },
  { id: 'realtime', label: '实时', icon: <Pulse20Regular /> },
  { id: 'trend', label: '趋势', icon: <DataTrending20Regular /> },
  { id: 'history', label: '历史', icon: <History20Regular /> },
  { id: 'comm', label: '通信', icon: <ArrowSync20Regular /> },
  { id: 'templates', label: '模板', icon: <Document20Regular /> },
];

function TopBar() {
  const workspaceName = useApp((s) => s.snapshot?.workspace.name ?? '未命名工作区');
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
        <span className="text-[15px] font-bold whitespace-nowrap">Modbus 调试工具</span>
        <span className="text-xs text-ink2 truncate">
          {workspaceName}
        </span>
      </div>
      <div className="flex items-center gap-6">
        {online > 0 ? <StatusDot tone="ok" label={`${online} 个连接在线`} /> : <span className="text-xs text-ink2">无连接</span>}
        {rec ? (
          <StatusDot tone="ok" label={`记录中 · ${rec.signalCount} 个信号 · ${p(Math.floor(elapsed / 3600))}:${p(Math.floor(elapsed / 60) % 60)}:${p(elapsed % 60)}`} />
        ) : (
          <span className="text-xs text-ink2">未记录</span>
        )}
      </div>
    </header>
  );
}

function AppRail() {
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
          {m.label}
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
        设置
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
        <StatusDot tone={state === 'online' ? 'ok' : state === 'error' ? 'err' : 'idle'} label={state === 'online' ? '已连接' : state === 'connecting' ? '连接中' : '离线'} />
      </button>
      {conn.transport === 'rtu' && conn.rtu ? <div className="ml-6 text-xs text-ink2">{conn.rtu.baudRate} · {conn.rtu.dataBits}{conn.rtu.parity.charAt(0).toUpperCase()}{conn.rtu.stopBits}</div> : null}
      {conn.transport === 'tcp' && conn.tcp ? <div className="ml-6 text-xs text-ink2">{conn.tcp.host}:{conn.tcp.port}</div> : null}
      {props.actions ? <div className="ml-6 mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-accent">{props.actions}</div> : null}
      {open ? <div className="ml-3 mt-1">{props.children}</div> : null}
    </div>
  );
}

function SlaveCard(props: { slaveId: string; showBlocks: boolean; selectedSlave?: boolean; selectedBlock?: string | null; onSelectSlave?: () => void; onSelectBlock?: (blockId: string) => void }) {
  const workspace = useWorkspace();
  const slave = workspace?.slaves.find((s) => s.id === props.slaveId);
  const template = workspace?.templates.find((t) => t.id === slave?.templateId);
  const [open, setOpen] = useState(true);
  if (!slave) return null;
  return (
    <div className={`mb-2 rounded-ctl px-3 py-2 ${props.selectedSlave ? 'bg-accentsoft' : 'bg-surface'}`}>
      <button className="focus-ring flex w-full cursor-pointer items-center justify-between text-left" onClick={() => { setOpen(!open); props.onSelectSlave?.(); }}>
        <span className="flex items-center gap-1.5 text-sm font-medium truncate">
          {open ? <ChevronDown20Regular className="shrink-0" /> : <ChevronRight20Regular className="shrink-0" />}
          {slave.name}
        </span>
        <StatusDot tone={slave.enabled ? 'ok' : 'idle'} label={slave.enabled ? '在线' : '停用'} />
      </button>
      <div className="ml-5 mt-0.5 text-xs text-ink2">从站 {slave.unitId} · {template?.name ?? '未绑定模板'}</div>
      {open && props.showBlocks && template ? (
        <div className="ml-5 mt-1.5 flex flex-col gap-1">
          {props.selectedSlave ? (
            <button className={`focus-ring cursor-pointer rounded px-2 py-1 text-left text-xs ${!props.selectedBlock ? 'bg-accentsoft text-accent font-medium' : 'text-ink2 hover:text-ink'}`} onClick={() => props.onSelectBlock?.('')}>
              全部数据 · {template.blocks.length} 个数据块
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
  const workspace = useWorkspace();
  const select = useApp((s) => s.select);
  const selection = useApp((s) => s.selection);
  const openOverlay = useApp((s) => s.openOverlay);

  return (
    <SidebarShell title="设备">
      <Button variant="secondary" onClick={() => openOverlay({ kind: 'dialog', id: 'add-connection' })}>
        <Add20Regular /> 添加连接
      </Button>
      <div className="mt-5 mb-2 text-xs text-ink2">连接与从站</div>
      {workspace?.connections.length === 0 ? <div className="text-xs text-ink2 py-2">还没有连接</div> : null}
      {workspace?.connections.map((c) => (
        <TreeConnection
          key={c.id}
          connectionId={c.id}
          onSelectConnection={() => select({ connectionId: c.id, slaveId: null, deviceView: 'topology' })}
          actions={
            <>
              <button className="focus-ring cursor-pointer hover:underline" onClick={() => select({ connectionId: c.id, deviceView: 'scan' })}>扫描</button>
              <button className="focus-ring cursor-pointer hover:underline" onClick={() => select({ connectionId: c.id, deviceView: 'temp' })}>临时读取</button>
              <button className="focus-ring cursor-pointer hover:underline" onClick={() => openOverlay({ kind: 'dialog', id: 'add-slave', connectionId: c.id })}>＋ 添加从站</button>
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
  const workspace = useWorkspace();
  const select = useApp((s) => s.select);
  const selection = useApp((s) => s.selection);
  const selSlave = workspace?.slaves.find((s) => s.id === selection.slaveId);
  const selTemplate = workspace?.templates.find((t) => t.id === selSlave?.templateId);
  return (
    <SidebarShell title="实时数据">
      <div className="mb-2 text-xs text-ink2">连接与设备</div>
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
          <div className="mt-5 mb-2 text-xs text-ink2">当前数据块</div>
          <div className="text-xs text-ink2 leading-5">
            {selection.blockId ? selTemplate.blocks.find((b) => b.id === selection.blockId)?.name ?? '—' : '全部数据块'} · {selection.blockId ? `${selTemplate.blocks.find((b) => b.id === selection.blockId)?.periodMs} ms` : `${selTemplate.blocks.map((b) => b.periodMs).join(' / ')} ms`}
            <br />
            {selection.blockId ? `FC0${selTemplate.blocks.find((b) => b.id === selection.blockId)?.area} · 地址 ${selTemplate.blocks.find((b) => b.id === selection.blockId)?.start}–${(selTemplate.blocks.find((b) => b.id === selection.blockId)?.start ?? 0) + (selTemplate.blocks.find((b) => b.id === selection.blockId)?.length ?? 0) - 1}` : ''}
          </div>
        </>
      ) : (
        <>
          <div className="mt-5 mb-2 text-xs text-ink2">后台轮询</div>
          <div className="text-xs text-ink2 leading-5">选择从站后查看轮询状态</div>
        </>
      )}
    </SidebarShell>
  );
}

function TrendSidebar() {
  const workspace = useWorkspace();
  const recording = useRecording();
  const select = useApp((s) => s.select);
  const selection = useApp((s) => s.selection);
  const openOverlay = useApp((s) => s.openOverlay);
  const command = useApp((s) => s.command);
  const toast = useApp((s) => s.toast);
  const group = workspace?.trendGroups.find((g) => g.id === selection.groupId);
  return (
    <SidebarShell title="趋势组">
      <Button variant="secondary" onClick={() => openOverlay({ kind: 'dialog', id: 'new-trend-group' })}>
        <Add20Regular /> 新建趋势组
      </Button>
      <div className="mt-4 flex flex-col gap-2">
        {workspace?.trendGroups.map((g) => (
          <button
            key={g.id}
            onClick={() => select({ groupId: g.id })}
            className={`focus-ring cursor-pointer rounded-ctl px-3 py-2.5 text-left ${selection.groupId === g.id ? 'bg-accentsoft' : 'bg-surface hover:bg-surface2'}`}
          >
            <div className="text-sm font-medium">{g.name}</div>
            <div className="text-xs text-ink2 mt-0.5">{g.signals.length} 个信号{recording?.groupId === g.id ? ' · 记录中' : recording ? ' · 未选中' : ''}</div>
            {recording?.groupId === g.id ? <StatusDot tone="ok" label="当前" className="mt-1" /> : null}
          </button>
        ))}
      </div>
      {group ? (
        <>
          <div className="mt-5 mb-2 text-xs text-ink2">快捷操作</div>
          <div className="flex flex-col gap-1.5 text-xs">
            <button className="focus-ring cursor-pointer text-left text-accent hover:underline" onClick={() => openOverlay({ kind: 'dialog', id: 'add-signal', groupId: group.id })}>添加信号</button>
            <button
              className="focus-ring cursor-pointer text-left text-accent hover:underline"
              onClick={async () => {
                const ws = workspace;
                if (!ws) return;
                const copy = { ...group, id: `g-${Date.now().toString(36)}`, name: `${group.name} 副本`, signals: group.signals.map((s) => ({ ...s, id: `sig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}` })) };
                await command({ type: 'workspace.apply', workspace: { ...ws, trendGroups: [...ws.trendGroups, copy] } });
                toast({ kind: 'success', title: '已复制趋势组' });
              }}
            >
              复制组
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
              删除组
            </button>
          </div>
        </>
      ) : null}
      <div className="mt-5 mb-2 text-xs text-ink2">数据源</div>
      <div className="text-xs text-ink2 leading-5">
        <StatusDot tone="idle" label="后台数据正常" />
        <br />
        趋势组直接消费 Block Cache，不创建独立轮询。
      </div>
    </SidebarShell>
  );
}

function HistorySidebar() {
  const allSessions = useSessions();
  const select = useApp((s) => s.select);
  const selection = useApp((s) => s.selection);
  const [query, setQuery] = useState('');
  const groups = useMemo(() => {
    const sessions = allSessions.filter((s) => !query || s.groupName.includes(query));
    const map = new Map<string, typeof sessions>();
    for (const s of sessions) {
      const day = new Date(s.startUtc).toDateString();
      const label = day === new Date().toDateString() ? '今天' : day === new Date(Date.now() - 86400000).toDateString() ? '昨天' : new Date(s.startUtc).toLocaleDateString('zh-CN');
      map.set(label, [...(map.get(label) ?? []), s]);
    }
    return [...map.entries()];
  }, [allSessions, query]);
  return (
    <SidebarShell title="记录会话">
      <div className="relative mb-4">
        <TextInput placeholder="搜索会话" value={query} onChange={(e) => setQuery(e.target.value)} className="h-9 pl-8" />
        <Search20Regular className="absolute left-2 top-2 text-ink2" />
      </div>
      {groups.map(([label, list]) => (
        <div key={label} className="mb-4">
          <div className="mb-2 text-xs text-ink2">{label}</div>
          <div className="flex flex-col gap-2">
            {list.map((s) => (
              <button
                key={s.id}
                onClick={() => select({ sessionId: s.id })}
                className={`focus-ring cursor-pointer rounded-ctl px-3 py-2.5 text-left ${selection.sessionId === s.id ? 'bg-accentsoft' : 'bg-surface hover:bg-surface2'}`}
              >
                <div className="text-sm font-medium">{s.groupName}</div>
                <div className="text-xs text-ink2 mt-0.5 mono">{new Date(s.startUtc).toTimeString().slice(0, 8)} – {s.endUtc ? new Date(s.endUtc).toTimeString().slice(0, 8) : '…'}</div>
                <div className="text-xs text-ink2 mt-0.5">{s.signalCount} 点位 · {s.sampleCount.toLocaleString()} 数值样本</div>
                <StatusDot tone={s.status === 'recording' ? 'ok' : 'ok'} label={s.status === 'recording' ? '记录中' : '已完成'} className="mt-1" />
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="mt-4 mb-2 text-xs text-ink2">筛选</div>
      <div className="flex flex-col gap-1.5 text-xs text-accent">
        <span>日期范围</span>
        <span>趋势组</span>
        <span>设备 / 从站</span>
      </div>
      <div className="mt-6 text-xs text-ink2">数据库：history.db · {allSessions.length} 个会话</div>
    </SidebarShell>
  );
}

function CommSidebar() {
  const workspace = useWorkspace();
  const connStates = useConnectionStates();
  const select = useApp((s) => s.select);
  const selection = useApp((s) => s.selection);
  const [slaveFilter, setSlaveFilter] = useState<Record<string, boolean>>({});
  const [resultFilter, setResultFilter] = useState({ ok: true, timeout: true, exception: true });
  return (
    <SidebarShell title="通信来源">
      <div className="mb-2 text-xs text-ink2">视图</div>
      <div className="flex flex-col gap-1.5 mb-4">
        <button className={`focus-ring cursor-pointer rounded-ctl px-3 py-2 text-left text-sm ${selection.commView === 'messages' ? 'bg-accentsoft text-accent font-medium' : 'bg-surface'}`} onClick={() => select({ commView: 'messages' })}>报文</button>
        <button className={`focus-ring cursor-pointer rounded-ctl px-3 py-2 text-left text-sm ${selection.commView === 'health' ? 'bg-accentsoft text-accent font-medium' : 'bg-surface'}`} onClick={() => select({ commView: 'health' })}>连接健康</button>
        <button className={`focus-ring cursor-pointer rounded-ctl px-3 py-2 text-left text-sm ${selection.commView === 'trace' ? 'bg-accentsoft text-accent font-medium' : 'bg-surface'}`} onClick={() => select({ commView: 'trace' })}>点位追踪</button>
      </div>
      <div className="mb-2 text-xs text-ink2">连接</div>
      {workspace?.connections.map((c) => (
        <button key={c.id} className="focus-ring mb-2 w-full cursor-pointer rounded-ctl bg-surface px-3 py-2 text-left hover:bg-surface2" onClick={() => select({ connectionId: c.id })}>
          <div className="text-sm font-medium">{c.name}</div>
          <StatusDot tone={connStates[c.id]?.state === 'online' ? 'ok' : 'idle'} label={connStates[c.id]?.state === 'online' ? `已连接 · ${c.transport === 'rtu' ? `${c.rtu?.baudRate ?? ''} ${c.rtu?.dataBits ?? ''}${c.rtu?.parity.charAt(0).toUpperCase()}${c.rtu?.stopBits ?? ''}` : c.tcp?.host}` : '离线'} className="mt-1" />
        </button>
      ))}
      <div className="mt-4 mb-2 text-xs text-ink2">从站筛选</div>
      <div className="flex flex-col gap-1.5">
        {workspace?.slaves.map((s) => (
          <Checkbox key={s.id} checked={slaveFilter[s.id] !== false} onCheckedChange={(v) => setSlaveFilter({ ...slaveFilter, [s.id]: v })} label={`从站 ${s.unitId} · ${s.name}`} />
        ))}
      </div>
      <div className="mt-4 mb-2 text-xs text-ink2">结果筛选</div>
      <div className="flex flex-col gap-1.5">
        <Checkbox checked={resultFilter.ok} onCheckedChange={(v) => setResultFilter({ ...resultFilter, ok: v })} label="成功" />
        <Checkbox checked={resultFilter.timeout} onCheckedChange={(v) => setResultFilter({ ...resultFilter, timeout: v })} label="超时" />
        <Checkbox checked={resultFilter.exception} onCheckedChange={(v) => setResultFilter({ ...resultFilter, exception: v })} label="Modbus 异常" />
      </div>
      <div className="mt-4 mb-2 text-xs text-ink2">捕获设置</div>
      <div className="flex flex-col gap-1.5 text-xs text-ink2">
        <span>自动滚动：开启</span>
        <span>保留原始帧：开启</span>
        <span>最大 50,000 条</span>
      </div>
    </SidebarShell>
  );
}

function TemplatesSidebar() {
  const workspace = useWorkspace();
  const select = useApp((s) => s.select);
  const selection = useApp((s) => s.selection);
  const openOverlay = useApp((s) => s.openOverlay);
  const command = useApp((s) => s.command);
  const toast = useApp((s) => s.toast);
  return (
    <SidebarShell title="设备模板">
      <Button
        variant="secondary"
        onClick={async () => {
          const ws = workspace;
          if (!ws) return;
          const id = `tpl-${Date.now().toString(36)}`;
          await command({ type: 'workspace.apply', workspace: { ...ws, templates: [...ws.templates, { id, name: '新设备模板', version: '1.0', description: '', blocks: [], points: [] }] } });
          select({ templateId: id });
        }}
      >
        <Add20Regular /> 新建设备模板
      </Button>
      <div className="mt-4 flex flex-col gap-2">
        {workspace?.templates.map((t) => {
          const bound = workspace?.slaves.filter((s) => s.templateId === t.id).length ?? 0;
          return (
            <button key={t.id} onClick={() => select({ templateId: t.id })} className={`focus-ring cursor-pointer rounded-ctl px-3 py-2.5 text-left ${selection.templateId === t.id ? 'bg-accentsoft' : 'bg-surface hover:bg-surface2'}`}>
              <div className="text-sm font-medium">{t.name}</div>
              <div className="text-xs text-ink2 mt-0.5">{t.blocks.length} 个数据块 · {t.points.length} 个点位</div>
              {bound > 0 ? <div className="text-xs text-accent mt-0.5">已绑定 {bound} 个从站</div> : null}
            </button>
          );
        })}
      </div>
      <div className="mt-5 mb-2 text-xs text-ink2">模板操作</div>
      <div className="flex flex-col gap-1.5 text-xs text-accent">
        <button className="focus-ring cursor-pointer text-left hover:underline" onClick={() => openOverlay({ kind: 'screen', id: 'import-registers', templateId: selection.templateId ?? workspace?.templates[0]?.id ?? '' })}>导入寄存器表</button>
        <button
          className="focus-ring cursor-pointer text-left hover:underline"
          onClick={async () => {
            const t = workspace?.templates.find((x) => x.id === selection.templateId);
            if (!t) return;
            const text = JSON.stringify(t, null, 2);
            await navigator.clipboard.writeText(text);
            toast({ kind: 'success', title: '模板已复制到剪贴板' });
          }}
        >
          导出模板
        </button>
        <button
          className="focus-ring cursor-pointer text-left hover:underline"
          onClick={async () => {
            const ws = workspace;
            const t = ws?.templates.find((x) => x.id === selection.templateId);
            if (!ws || !t) return;
            const copy = { ...t, id: `tpl-${Date.now().toString(36)}`, name: `${t.name} 副本` };
            await command({ type: 'workspace.apply', workspace: { ...ws, templates: [...ws.templates, copy] } });
          }}
        >
          复制模板
        </button>
      </div>
    </SidebarShell>
  );
}

function SettingsSidebar() {
  const select = useApp((s) => s.select);
  const selection = useApp((s) => s.selection);
  const items = ['工作区', '显示', '导入兼容', '记录与存储', '写入安全', '日志'];
  const [active, setActive] = useState('工作区');
  void select;
  void selection;
  return (
    <SidebarShell title="设置">
      <div className="flex flex-col gap-1">
        {items.map((it) => (
          <button key={it} className={`focus-ring cursor-pointer rounded-ctl px-3 py-2 text-left text-sm ${active === it ? 'bg-accentsoft text-accent font-medium' : 'hover:bg-surface2'}`} onClick={() => setActive(it)}>
            {it}
          </button>
        ))}
      </div>
    </SidebarShell>
  );
}

function Sidebar() {
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
        title="拖拽调整宽度，双击恢复 244 px"
      />
    </div>
  );
}

function Main() {
  const module = useApp((s) => s.module);
  return (
    <main className="min-w-0 flex-1 overflow-y-auto bg-app">
      <div className="px-7 py-6 min-w-[700px]">
        {module === 'devices' ? <DevicesScreen /> : module === 'realtime' ? <RealtimeScreen /> : module === 'trend' ? <TrendScreen /> : module === 'history' ? <HistoryScreen /> : module === 'comm' ? <CommScreen /> : module === 'templates' ? <TemplatesScreen /> : <SettingsScreen />}
      </div>
    </main>
  );
}

export function App() {
  // Subscribing to the whole snapshot here would re-render the entire tree on every delta
  // (up to 10/s while polling) and defeat every narrow selector below.
  const ready = useSnapshotReady();
  if (!ready) return <div className="flex h-full items-center justify-center text-ink2">正在加载工作区…</div>;
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