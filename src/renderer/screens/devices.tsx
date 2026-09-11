import React, { useCallback, useState } from 'react';
import { useApp, useConnectionStates, useHealth, useWorkspace } from '../store/app';
import { Button, ComboInput, EmptyState, Field, InfoBand, InfoColumns, PageHeader, SectionTitle, Select, StatusDot, TextInput, formatClock, slaveStatus } from '../components/ui';
import { DataTable } from '../components/table';
import { AREAS } from '../../domain/address';

/** Shared baud-rate presets for the add-connection dialog and the connection settings page. */
export const BAUD_PRESETS = ['1200', '2400', '4800', '9600', '19200', '38400', '57600', '115200', '230400', '460800', '921600', '1000000'].map((b) => ({ value: b, label: b }));

export function DevicesScreen() {
  const workspace = useWorkspace();
  const health = useHealth();
  const connStates = useConnectionStates();
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const openOverlay = useApp((s) => s.openOverlay);
  const setModule = useApp((s) => s.setModule);
  // A connection selected without a slave owns the main area (settings + slave list);
  // only fall back to the first slave when nothing at all is selected yet.
  const slave = selection.slaveId
    ? workspace?.slaves.find((s) => s.id === selection.slaveId)
    : selection.connectionId
      ? undefined
      : workspace?.slaves[0];
  const connection = workspace?.connections.find((c) => c.id === slave?.connectionId);
  const activeConnection =
    workspace?.connections.find((c) => c.id === selection.connectionId) ?? connection ?? workspace?.connections[0];

  if (selection.deviceView === 'scan' && activeConnection) return <ScanView connectionId={activeConnection.id} />;
  if (selection.deviceView === 'temp' && activeConnection) return <TempReadView connectionId={activeConnection.id} />;
  const template = workspace?.templates.find((t) => t.id === slave?.templateId);
  const connState = slave ? connStates[slave.connectionId] : undefined;

  if (!workspace || workspace.connections.length === 0) {
    return (
      <EmptyState
        title="开始配置 Modbus 调试环境"
        message="先建立连接和从站，或导入已有工作区 / 设备模板。随后在“实时”中查看数据，并按需加入趋势。"
        actions={
          <>
            <Button variant="primary" onClick={() => openOverlay({ kind: 'dialog', id: 'add-connection' })}>＋ 添加第一个连接</Button>
            <Button onClick={() => openOverlay({ kind: 'dialog', id: 'add-connection' })}>导入工作区</Button>
            <Button onClick={() => setModule('templates')}>导入设备模板</Button>
          </>
        }
      />
    );
  }

  if (!slave && activeConnection) return <ConnectionSettingsView key={activeConnection.id} connectionId={activeConnection.id} />;
  if (!slave) {
    return (
      <EmptyState
        title="还没有从站"
        message="在左侧连接上添加从站并绑定设备模板。"
        actions={
          <Button
            variant="primary"
            disabled={!activeConnection}
            onClick={() => {
              if (!activeConnection) return;
              select({ connectionId: activeConnection.id, deviceView: 'topology' });
              openOverlay({ kind: 'dialog', id: 'add-slave', connectionId: activeConnection.id });
            }}
          >
            ＋ 添加从站
          </Button>
        }
      />
    );
  }

  return (
    <>
      <PageHeader
        title={slave.name}
        subtitle={`从站 ${slave.unitId} · ${connection?.name ?? ''} · ${template?.name ?? '未绑定模板'}`}
        actions={<Button onClick={() => openOverlay({ kind: 'dialog', id: 'add-slave', connectionId: slave.connectionId, slaveId: slave.id })}>编辑从站</Button>}
      />
      <InfoColumns
        items={[
          { label: '连接', value: connection?.name ?? '—', sub: connection?.transport === 'rtu' ? <span className="text-ok text-xs">总线负载 {Math.round(health[connection.id]?.busLoadPercent ?? 0)}%</span> : undefined },
          { label: '从站地址', value: String(slave.unitId) },
          { label: '设备模板', value: template ? <button className="focus-ring cursor-pointer text-accent hover:underline" onClick={() => { select({ templateId: template.id }); setModule('templates'); }}>{template.name} · v{template.version}</button> : '未绑定' },
          {
            label: '设备状态',
            value: <StatusDot tone={connState?.state === 'online' ? 'ok' : connState?.state === 'error' ? 'err' : 'idle'} label={connState?.state === 'online' ? `在线 · 最后响应 ${formatClock(connState.lastResponseUtc)}` : connState?.state === 'connecting' ? '连接中' : '离线'} />,
          },
        ]}
      />
      <SectionTitle>模板数据块</SectionTitle>
      <div className="text-xs text-ink2 -mt-1 mb-4">设备模板：{template?.name ?? '—'} · v{template?.version ?? '—'}</div>
      {!template || template.blocks.length === 0 ? (
        <EmptyState title="模板还没有数据块" message="在模板编辑中添加数据块与点位。" />
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3" style={{ gridAutoRows: 'min-content' }}>
          {template.blocks.map((b) => (
            <div key={b.id} className="rounded-card border border-line bg-surface p-5 min-w-[280px]">
              <div className="text-sm font-bold">{b.name}</div>
              <div className="text-xs text-accent mt-1">{AREAS[b.area]}</div>
              <div className="mt-4 flex flex-col gap-2 text-xs">
                <div className="flex"><span className="w-20 text-ink2">范围</span><span className="mono">地址 {b.start}–{b.start + b.length - 1}</span></div>
                <div className="flex"><span className="w-20 text-ink2">长度</span><span>{b.length} 个寄存器</span></div>
                <div className="flex"><span className="w-20 text-ink2">模板周期</span><span>默认周期 {b.periodMs} ms</span></div>
              </div>
              <Button
                variant="quiet"
                size="sm"
                className="mt-4"
                onClick={() => {
                  select({ slaveId: slave.id, connectionId: slave.connectionId, blockId: b.id, realtimeScope: 'block' });
                  setModule('realtime');
                }}
              >
                查看数据
              </Button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
/* ------------------------------- 17 — 扫描 / 从站 ------------------------------- */

interface ScanRow {
  unitId: number;
  responseMs: number;
}

export function ScanView(props: { connectionId: string }) {
  const workspace = useWorkspace();
  const command = useApp((s) => s.command);
  const openOverlay = useApp((s) => s.openOverlay);
  const [from, setFrom] = useState('1');
  const [to, setTo] = useState('247');
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<ScanRow[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const conn = workspace?.connections.find((c) => c.id === props.connectionId);

  const run = async () => {
    setRunning(true);
    setRows([]);
    const started = Date.now();
    const res = await command<ScanRow[]>({ type: 'device.scan', connectionId: props.connectionId, from: Number(from), to: Number(to) });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    setRunning(false);
    if (res.ok) {
      setRows(res.value);
      setSummary(`${Number(to) - Number(from) + 1} 个地址 · ${res.value.length} 个响应 · 用时 ${secs} s`);
    }
  };

  return (
    <>
      <PageHeader title="从站扫描" subtitle="发现当前连接上的 Modbus 从站地址。" actions={<Button variant="primary" disabled={running} onClick={() => void run()}>{running ? '扫描中…' : '开始扫描'}</Button>} />
      <InfoColumns
        items={[
          { label: '扫描范围', value: <span className="mono">{from} – {to}</span> },
          { label: '单地址超时', value: '150 ms' },
          { label: '重试', value: '1 次' },
          { label: '当前连接', value: conn ? `${conn.name} · ${conn.transport === 'tcp' ? conn.tcp?.host : conn.rtu?.port}` : '—' },
        ]}
      />
      <InfoBand tone="blue" className="mt-4">扫描期间当前连接的周期轮询会暂时挂起；扫描完成或取消后自动恢复。</InfoBand>
      <div className="mt-4 flex gap-4">
        <div className="w-32"><div className="text-xs text-ink2 mb-1.5">起始 Unit</div><TextInput data-testid="scan-from" type="number" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="w-32"><div className="text-xs text-ink2 mb-1.5">结束 Unit</div><TextInput data-testid="scan-to" type="number" value={to} onChange={(e) => setTo(e.target.value)} /></div>
      </div>
      <SectionTitle>扫描结果</SectionTitle>
      <div className="text-xs text-ink2 -mt-1 mb-3">已发现 {rows.length} 个从站</div>
      <DataTable<ScanRow>
        columns={[
          { id: 'unit', header: 'Unit ID', width: 120, render: (r: ScanRow) => <span className="font-medium">{r.unitId}</span> },
          { id: 'st', header: '状态', width: 120, render: () => <StatusDot tone="ok" label="在线" /> },
          { id: 'ms', header: '响应时间', width: 140, render: (r: ScanRow) => <span className="text-xs">{r.responseMs.toFixed(1)} ms</span> },
          { id: 'resp', header: '最近响应', width: 160, render: () => <span className="text-xs">正常响应</span> },
          {
            id: 'op',
            header: '操作',
            width: 140,
            render: (r: ScanRow) =>
              workspace?.slaves.some((s) => s.connectionId === props.connectionId && s.unitId === r.unitId) ? (
                <span className="text-xs text-ink2">已添加</span>
              ) : (
                <button className="focus-ring cursor-pointer text-xs text-accent hover:underline" onClick={() => openOverlay({ kind: 'dialog', id: 'add-slave', connectionId: props.connectionId })}>
                  添加从站
                </button>
              ),
          },
        ]}
        rows={rows}
        rowKey={(r) => String(r.unitId)}
        empty={running ? '扫描中…' : '还没有扫描结果'}
      />
      {summary ? (
        <InfoBand className="mt-6">
          <div className="text-sm font-bold mb-1">扫描摘要</div>
          <div className="text-sm">{summary}</div>
          <div className="text-xs text-ink2 mt-1">下一步：发现从站后可绑定设备模板，或使用“临时读取”验证寄存器范围。</div>
        </InfoBand>
      ) : null}
    </>
  );
}

/* ------------------------------- 18 — 设备 / 临时读取 ------------------------------- */

export function TempReadView(props: { connectionId: string }) {
  const workspace = useWorkspace();
  const command = useApp((s) => s.command);
  const openOverlay = useApp((s) => s.openOverlay);
  const [unit, setUnit] = useState('1');
  const [area, setArea] = useState('3');
  const [start, setStart] = useState('0');
  const [qty, setQty] = useState('16');
  const [result, setResult] = useState<{ registers: number[]; bits?: boolean[]; ms: number; at: string } | null>(null);
  const conn = workspace?.connections.find((c) => c.id === props.connectionId);
  const slave = workspace?.slaves.find((s) => s.connectionId === props.connectionId && s.unitId === Number(unit));

  const read = async () => {
    const res = await command<{ result: string; response: { kind: string; registers?: number[]; bits?: boolean[] } | null; durationMs: number }>({
      type: 'device.temporaryRead',
      connectionId: props.connectionId,
      unitId: Number(unit),
      area: Number(area) as 1 | 2 | 3 | 4,
      start: Number(start),
      quantity: Number(qty),
    });
    const payload = res.ok ? res.value.response : null;
    if (res.ok && res.value.result === 'ok' && payload && (payload.kind === 'registers' || payload.kind === 'bits')) {
      setResult({ registers: payload.registers ?? payload.bits?.map((b) => (b ? 1 : 0)) ?? [], ms: res.value.durationMs, at: new Date().toTimeString().slice(0, 8) });
    }
  };

  const rows = (result?.registers ?? []).map((v, i) => ({ addr: Number(start) + i, value: v }));

  return (
    <>
      <PageHeader title="临时读取" subtitle={`${slave?.name ?? `从站 ${unit}`} · Unit ${unit} · 单次请求`} />
      <InfoBand className="flex flex-wrap items-end gap-4">
        <div className="w-44"><div className="text-xs text-ink2 mb-1.5">地址区</div><Select value={area} onChange={setArea} options={[1, 2, 3, 4].map((a) => ({ value: String(a), label: AREAS[a as 1 | 2 | 3 | 4] }))} /></div>
        <div className="w-28"><div className="text-xs text-ink2 mb-1.5">起始地址</div><TextInput type="number" value={start} onChange={(e) => setStart(e.target.value)} /></div>
        <div className="w-28"><div className="text-xs text-ink2 mb-1.5">数量（寄存器）</div><TextInput type="number" value={qty} onChange={(e) => setQty(e.target.value)} /></div>
        <div className="w-40"><div className="text-xs text-ink2 mb-1.5">从站</div><TextInput type="number" value={unit} onChange={(e) => setUnit(e.target.value)} /></div>
        <div className="text-xs text-ink2 pb-2">请求预览 <span className="mono text-ink">FC0{area} · Start {start} · Qty {qty}</span></div>
        <div className="flex-1" />
        <Button variant="primary" onClick={() => void read()}>读取</Button>
      </InfoBand>
      {result ? (
        <>
          <SectionTitle>读取结果</SectionTitle>
          <div className="text-xs text-ink2 -mt-1 mb-3">最近读取 {result.at} · {result.ms.toFixed(1)} ms</div>
          <DataTable<{ addr: number; value: number }>
            columns={[
              { id: 'addr', header: '地址', width: 90, render: (r: { addr: number; value: number }) => <span className="mono text-xs">{r.addr}</span> },
              { id: 'hex', header: 'Hex', width: 120, render: (r: { addr: number; value: number }) => <span className="mono text-xs">0x{r.value.toString(16).toUpperCase().padStart(4, '0')}</span> },
              { id: 'u16', header: 'UInt16', width: 110, render: (r: { addr: number; value: number }) => <span className="mono text-xs">{r.value}</span> },
              { id: 'i16', header: 'Int16', width: 110, render: (r: { addr: number; value: number }) => <span className="mono text-xs">{r.value > 32767 ? r.value - 65536 : r.value}</span> },
              { id: 'ascii', header: 'ASCII', width: 110, render: (r: { addr: number; value: number }) => <span className="mono text-xs">{String.fromCharCode((r.value >> 8) & 0xff, r.value & 0xff).replace(/[^\x20-\x7e]/g, '.')}</span> },
            ]}
            rows={rows}
            rowKey={(r) => String(r.addr)}
            maxHeight={360}
          />
          <InfoBand tone="blue" className="mt-5 flex items-center justify-between">
            <div>
              <div className="text-sm font-bold text-accent mb-1">读取成功</div>
              <div className="text-sm">{rows.length} 个寄存器 · 地址 {start}–{Number(start) + rows.length - 1} · FC0{area} · {result.ms.toFixed(1)} ms</div>
            </div>
            <div className="flex gap-3">
              <Button
                size="sm"
                onClick={() => {
                  const firstSlave = workspace?.slaves.find((s2) => s2.connectionId === props.connectionId);
                  const tpl = workspace?.templates.find((t2) => t2.id === firstSlave?.templateId);
                  const firstPoint = tpl?.points.find((p2) => p2.blockId === tpl.blocks[0]?.id);
                  if (firstPoint) openOverlay({ kind: 'drawer', id: 'inspector', pointId: firstPoint.id });
                }}
              >
                原始数据
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() =>
                  openOverlay({
                    kind: 'dialog',
                    id: 'save-as-block',
                    connectionId: props.connectionId,
                    unitId: Number(unit),
                    area: Number(area) as 1 | 2 | 3 | 4,
                    start: Number(start),
                    quantity: Number(qty),
                    registers: result.registers,
                  })
                }
              >
                保存为数据块
              </Button>
            </div>
          </InfoBand>
        </>
      ) : (
        <InfoBand className="mt-6">临时读取只发送单次请求，不会加入后台轮询；成功后可保存为数据块。</InfoBand>
      )}
      <div className="mt-4 text-xs text-ink2">连接：{conn?.name ?? '—'}</div>
    </>
  );
}

function ConnectionSettingsView(props: { connectionId: string }) {
  const workspace = useWorkspace();
  const connStates = useConnectionStates();
  const command = useApp((s) => s.command);
  const toast = useApp((s) => s.toast);
  const select = useApp((s) => s.select);
  const openOverlay = useApp((s) => s.openOverlay);
  const conn = workspace?.connections.find((c) => c.id === props.connectionId);
  const state = connStates[props.connectionId]?.state ?? 'offline';
  const [name, setName] = useState(conn?.name ?? '');
  const [port, setPort] = useState(conn?.rtu?.port ?? 'COM3');
  const [portOptions, setPortOptions] = useState<Array<{ value: string; label: string }>>([]);
  const [baud, setBaud] = useState(String(conn?.rtu?.baudRate ?? 115200));
  const [host, setHost] = useState(conn?.tcp?.host ?? '');
  const [tcpPort, setTcpPort] = useState(String(conn?.tcp?.port ?? 502));
  const [timeout, setTimeoutMs] = useState(String(conn?.timeoutMs ?? 500));
  const [retries, setRetries] = useState(String(conn?.retries ?? 1));
  const [reconnect, setReconnect] = useState<'auto' | 'manual'>(conn?.reconnect ?? 'auto');
  const [rts, setRts] = useState<'none' | 'toggle'>(conn?.rtsControl ?? 'none');
  const [logLevel, setLogLevel] = useState<'info' | 'debug'>(conn?.logLevel ?? 'info');
  const [interFrame, setInterFrame] = useState(String(conn?.interFrameMs ?? 0));
  const [busy, setBusy] = useState(false);

  const refreshPorts = useCallback(() => {
    void command<{ path: string; manufacturer: string | null }[]>({ type: 'serial.list' }).then((res) => {
      if (res.ok) setPortOptions(res.value.map((p) => ({ value: p.path, label: p.manufacturer ? `${p.path} · ${p.manufacturer}` : p.path })));
    });
  }, [command]);

  if (!workspace || !conn) return null;
  // While the link is up the parameters are locked: editing a live serial/TCP session would
  // tear the transport down mid-flight. Disconnect first, edit, save, then connect again.
  const live = state === 'online' || state === 'connecting';
  const stateLabel = state === 'online' ? '已连接' : state === 'connecting' ? '连接中' : state === 'error' ? '连接异常' : '未连接';
  const slaves = workspace.slaves.filter((sl) => sl.connectionId === conn.id);

  const save = async () => {
    if (live) return;
    const updated = {
      ...conn,
      name,
      rtu: conn.transport === 'rtu' ? { port, baudRate: Number(baud), dataBits: conn.rtu?.dataBits ?? (8 as 7 | 8), parity: conn.rtu?.parity ?? ('none' as 'none' | 'even' | 'odd'), stopBits: conn.rtu?.stopBits ?? (1 as 1 | 2) } : undefined,
      tcp: conn.transport === 'tcp' ? { host, port: Number(tcpPort) } : undefined,
      timeoutMs: Number(timeout),
      retries: Number(retries),
      reconnect,
      rtsControl: rts,
      logLevel,
      interFrameMs: Number(interFrame) || 0,
    };
    await command({ type: 'workspace.apply', workspace: { ...workspace, connections: workspace.connections.map((c) => (c.id === conn.id ? updated : c)) } });
    toast({ kind: 'success', title: '连接已更新', message: '参数已保存，点击「连接」建立链路。' });
  };

  const toggleLink = async () => {
    setBusy(true);
    const res = live
      ? await command({ type: 'connection.disconnect', connectionId: conn.id })
      : await command({ type: 'connection.connect', connectionId: conn.id });
    setBusy(false);
    if (!res.ok) toast({ kind: 'error', title: live ? '断开失败' : '连接失败', message: res.error });
  };

  return (
    <>
      <PageHeader
        title={conn.name}
        subtitle={conn.transport === 'rtu' ? `RS485 · ${conn.rtu?.port} · ${conn.rtu?.baudRate} ${conn.rtu?.dataBits}${(conn.rtu?.parity ?? 'none').charAt(0).toUpperCase()}${conn.rtu?.stopBits}` : `TCP · ${conn.tcp?.host}:${conn.tcp?.port}`}
        actions={
          <>
            <span className="inline-flex h-10 items-center rounded-ctl bg-surface2 px-4 text-sm">
              <StatusDot tone={state === 'online' ? 'ok' : state === 'error' ? 'err' : state === 'connecting' ? 'warn' : 'idle'} label={stateLabel} />
            </span>
            <Button disabled={!live} title={live ? undefined : '连接后才能扫描'} onClick={() => select({ connectionId: conn.id, deviceView: 'scan' })}>扫描</Button>
            <Button disabled={!live} title={live ? undefined : '连接后才能临时读取'} onClick={() => select({ connectionId: conn.id, deviceView: 'temp' })}>临时读取</Button>
            <Button disabled={busy} onClick={() => void toggleLink()}>{live ? '断开连接' : '连接'}</Button>
            <Button variant="primary" disabled={live || busy} title={live ? '断开连接后才能修改并保存' : undefined} onClick={() => void save()}>保存</Button>
          </>
        }
      />
      <InfoBand tone="blue">
        {live
          ? '已连接：参数已锁定，避免运行中修改导致链路异常。点击「断开连接」后可编辑并保存。'
          : '未连接：可编辑参数；保存后点击「连接」建立链路。扫描与临时读取需要连接状态。'}
      </InfoBand>
      <InfoBand>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
          <Field label="连接名称"><TextInput disabled={live} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          {conn.transport === 'rtu' ? (
            <>
              <Field label="串口" hint={live ? undefined : '打开下拉时重新枚举当前可用串口，也可直接输入'}>
                <ComboInput testId="conn-port" value={port} onChange={setPort} options={portOptions} onOpen={refreshPorts} placeholder="COM1" disabled={live} />
              </Field>
              <Field label="波特率" hint={live ? undefined : '支持自定义波特率输入'}>
                <ComboInput testId="conn-baud" value={baud} onChange={setBaud} options={BAUD_PRESETS} disabled={live} />
              </Field>
            </>
          ) : (
            <>
              <Field label="主机"><TextInput disabled={live} value={host} onChange={(e) => setHost(e.target.value)} /></Field>
              <Field label="端口"><TextInput disabled={live} value={tcpPort} onChange={(e) => setTcpPort(e.target.value)} /></Field>
            </>
          )}
          <Field label="超时 (ms)"><TextInput data-testid="timeout-input" disabled={live} value={timeout} onChange={(e) => setTimeoutMs(e.target.value)} /></Field>
          <Field label="重试"><TextInput disabled={live} value={retries} onChange={(e) => setRetries(e.target.value)} /></Field>
          <Field label="重连策略"><Select disabled={live} value={reconnect} onChange={(v) => setReconnect(v as 'auto' | 'manual')} options={[{ value: 'auto', label: '自动重连' }, { value: 'manual', label: '手动' }]} /></Field>
          <Field label="RTS 控制"><Select disabled={live} value={rts} onChange={(v) => setRts(v as 'none' | 'toggle')} options={[{ value: 'none', label: 'None' }, { value: 'toggle', label: 'Toggle' }]} /></Field>
          <Field label="日志级别"><Select disabled={live} value={logLevel} onChange={(v) => setLogLevel(v as 'info' | 'debug')} options={[{ value: 'info', label: 'Info' }, { value: 'debug', label: 'Debug' }]} /></Field>
          <Field label="帧间隔 (ms)"><TextInput disabled={live} value={interFrame} onChange={(e) => setInterFrame(e.target.value)} /></Field>
        </div>
      </InfoBand>
      <SectionTitle right={<Button variant="primary" onClick={() => openOverlay({ kind: 'dialog', id: 'add-slave', connectionId: conn.id })}>＋ 添加从站</Button>}>从站</SectionTitle>
      {slaves.length === 0 ? (
        <InfoBand tone="blue">该连接下还没有从站；添加从站后可绑定设备模板并开始轮询。</InfoBand>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {slaves.map((sl) => {
            const tpl = workspace.templates.find((t) => t.id === sl.templateId);
            return (
              <button key={sl.id} className="focus-ring cursor-pointer rounded-card border border-line bg-surface p-4 text-left hover:border-accent" onClick={() => select({ connectionId: conn.id, slaveId: sl.id, deviceView: 'topology' })}>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold">{sl.name}</span>
                  <StatusDot {...slaveStatus(sl.enabled, state)} />
                </div>
                <div className="text-xs text-ink2 mt-1">从站 {sl.unitId} · {tpl ? tpl.name : '未绑定模板'}</div>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
