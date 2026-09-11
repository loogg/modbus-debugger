import React, { useState } from 'react';
import { useApp } from '../store/app';
import { Button, EmptyState, InfoBand, InfoColumns, PageHeader, SectionTitle, Select, StatusDot, TextInput, formatClock } from '../components/ui';
import { DataTable } from '../components/table';
import { AREAS } from '../../domain/address';

export function DevicesScreen() {
  const snapshot = useApp((s) => s.snapshot);
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const openOverlay = useApp((s) => s.openOverlay);
  const setModule = useApp((s) => s.setModule);
  const slave = snapshot?.workspace.slaves.find((s) => s.id === selection.slaveId) ?? snapshot?.workspace.slaves[0];
  const connection = snapshot?.workspace.connections.find((c) => c.id === slave?.connectionId);
  const activeConnection =
    snapshot?.workspace.connections.find((c) => c.id === selection.connectionId) ?? connection ?? snapshot?.workspace.connections[0];

  if (selection.deviceView === 'scan' && activeConnection) return <ScanView connectionId={activeConnection.id} />;
  if (selection.deviceView === 'temp' && activeConnection) return <TempReadView connectionId={activeConnection.id} />;
  const template = snapshot?.workspace.templates.find((t) => t.id === slave?.templateId);
  const connState = slave ? snapshot?.connections[slave.connectionId] : undefined;

  if (!snapshot || snapshot.workspace.connections.length === 0) {
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
          { label: '连接', value: connection?.name ?? '—', sub: connection?.transport === 'rtu' ? <span className="text-ok text-xs">总线负载 {Math.round(snapshot.health[connection.id]?.busLoadPercent ?? 0)}%</span> : undefined },
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
  const snapshot = useApp((s) => s.snapshot);
  const command = useApp((s) => s.command);
  const openOverlay = useApp((s) => s.openOverlay);
  const [from, setFrom] = useState('1');
  const [to, setTo] = useState('247');
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<ScanRow[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const conn = snapshot?.workspace.connections.find((c) => c.id === props.connectionId);

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
        <div className="w-32"><div className="text-xs text-ink2 mb-1.5">起始 Unit</div><TextInput type="number" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="w-32"><div className="text-xs text-ink2 mb-1.5">结束 Unit</div><TextInput type="number" value={to} onChange={(e) => setTo(e.target.value)} /></div>
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
              snapshot?.workspace.slaves.some((s) => s.connectionId === props.connectionId && s.unitId === r.unitId) ? (
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
  const snapshot = useApp((s) => s.snapshot);
  const command = useApp((s) => s.command);
  const openOverlay = useApp((s) => s.openOverlay);
  const [unit, setUnit] = useState('1');
  const [area, setArea] = useState('3');
  const [start, setStart] = useState('0');
  const [qty, setQty] = useState('16');
  const [result, setResult] = useState<{ registers: number[]; bits?: boolean[]; ms: number; at: string } | null>(null);
  const conn = snapshot?.workspace.connections.find((c) => c.id === props.connectionId);
  const slave = snapshot?.workspace.slaves.find((s) => s.connectionId === props.connectionId && s.unitId === Number(unit));

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
                  const firstSlave = snapshot?.workspace.slaves.find((s2) => s2.connectionId === props.connectionId);
                  const tpl = snapshot?.workspace.templates.find((t2) => t2.id === firstSlave?.templateId);
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