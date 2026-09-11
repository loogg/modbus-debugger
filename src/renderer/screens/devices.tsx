import React, { useCallback, useState } from 'react';
import { useApp, useConnectionStates, useHealth, useWorkspace } from '../store/app';
import { Button, ComboInput, EmptyState, Field, InfoBand, InfoColumns, PageHeader, SectionTitle, Select, StatusDot, TextInput, formatClock, slaveStatus } from '../components/ui';
import { DataTable } from '../components/table';
import { AREAS } from '../../domain/address';
import { useTranslation } from '../i18n';
import { fmtTime } from '../time';

/** Shared baud-rate presets for the add-connection dialog and the connection settings page. */
export const BAUD_PRESETS = ['1200', '2400', '4800', '9600', '19200', '38400', '57600', '115200', '230400', '460800', '921600', '1000000'].map((b) => ({ value: b, label: b }));

export function DevicesScreen() {
  const { t } = useTranslation();
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
        title={t('devices.emptyNoConnTitle')}
        message={t('devices.emptyNoConnMessage')}
        actions={
          <>
            <Button variant="primary" onClick={() => openOverlay({ kind: 'dialog', id: 'add-connection' })}>{t('devices.addFirstConnection')}</Button>
            <Button onClick={() => openOverlay({ kind: 'dialog', id: 'add-connection' })}>{t('devices.importWorkspace')}</Button>
            <Button onClick={() => setModule('templates')}>{t('devices.importTemplate')}</Button>
          </>
        }
      />
    );
  }

  if (!slave && activeConnection) return <ConnectionSettingsView key={activeConnection.id} connectionId={activeConnection.id} />;
  if (!slave) {
    return (
      <EmptyState
        title={t('devices.emptyNoSlaveTitle')}
        message={t('devices.emptyNoSlaveMessage')}
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
            {t('devices.addSlavePlus')}
          </Button>
        }
      />
    );
  }

  return (
    <>
      <PageHeader
        title={slave.name}
        subtitle={t('devices.headerSubtitle', { unit: String(slave.unitId), conn: connection?.name ?? '', template: template?.name ?? t('devices.unboundTemplate') })}
        actions={<Button onClick={() => openOverlay({ kind: 'dialog', id: 'add-slave', connectionId: slave.connectionId, slaveId: slave.id })}>{t('devices.editSlave')}</Button>}
      />
      <InfoColumns
        items={[
          { label: t('devices.colConnection'), value: connection?.name ?? '—', sub: connection?.transport === 'rtu' ? <span className="text-ok text-xs">{t('devices.busLoad', { pct: String(Math.round(health[connection.id]?.busLoadPercent ?? 0)) })}</span> : undefined },
          { label: t('devices.colSlaveAddress'), value: String(slave.unitId) },
          { label: t('devices.colDeviceTemplate'), value: template ? <button className="focus-ring cursor-pointer text-accent hover:underline" onClick={() => { select({ templateId: template.id }); setModule('templates'); }}>{template.name} · v{template.version}</button> : t('devices.unbound') },
          {
            label: t('devices.colDeviceState'),
            value: <StatusDot tone={connState?.state === 'online' ? 'ok' : connState?.state === 'error' ? 'err' : 'idle'} label={connState?.state === 'online' ? t('devices.stateOnlineLast', { time: formatClock(connState.lastResponseUtc) }) : connState?.state === 'connecting' ? t('devices.stateConnecting') : t('devices.stateOffline')} />,
          },
        ]}
      />
      <SectionTitle>{t('devices.sectionBlocks')}</SectionTitle>
      <div className="text-xs text-ink2 -mt-1 mb-4">{t('devices.templateMeta', { name: template?.name ?? '—', version: template?.version ?? '—' })}</div>
      {!template || template.blocks.length === 0 ? (
        <EmptyState title={t('devices.emptyNoBlocksTitle')} message={t('devices.emptyNoBlocksMessage')} />
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3" style={{ gridAutoRows: 'min-content' }}>
          {template.blocks.map((b) => (
            <div key={b.id} className="rounded-card border border-line bg-surface p-5 min-w-[280px]">
              <div className="text-sm font-bold">{b.name}</div>
              <div className="text-xs text-accent mt-1">{AREAS[b.area]}</div>
              <div className="mt-4 flex flex-col gap-2 text-xs">
                <div className="flex"><span className="w-20 text-ink2">{t('devices.blockRangeLabel')}</span><span className="mono">{t('devices.blockRangeValue', { start: String(b.start), end: String(b.start + b.length - 1) })}</span></div>
                <div className="flex"><span className="w-20 text-ink2">{t('devices.blockLengthLabel')}</span><span>{t('devices.registerCount', { n: String(b.length) })}</span></div>
                <div className="flex"><span className="w-20 text-ink2">{t('devices.blockPeriodLabel')}</span><span>{t('devices.blockPeriodValue', { ms: String(b.periodMs) })}</span></div>
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
                {t('devices.viewData')}
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
  const { t } = useTranslation();
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
      setSummary(t('devices.scanSummary', { addresses: String(Number(to) - Number(from) + 1), responded: String(res.value.length), secs }));
    }
  };

  return (
    <>
      <PageHeader title={t('devices.scanTitle')} subtitle={t('devices.scanSubtitle')} actions={<Button variant="primary" disabled={running} onClick={() => void run()}>{running ? t('devices.scanRunning') : t('devices.scanStart')}</Button>} />
      <InfoColumns
        items={[
          { label: t('devices.scanRangeLabel'), value: <span className="mono">{from} – {to}</span> },
          { label: t('devices.scanTimeoutLabel'), value: '150 ms' },
          { label: t('devices.retries'), value: t('devices.retryOnce') },
          { label: t('devices.scanConnLabel'), value: conn ? `${conn.name} · ${conn.transport === 'tcp' ? conn.tcp?.host : conn.rtu?.port}` : '—' },
        ]}
      />
      <InfoBand tone="blue" className="mt-4">{t('devices.scanPauseHint')}</InfoBand>
      <div className="mt-4 flex gap-4">
        <div className="w-32"><div className="text-xs text-ink2 mb-1.5">{t('devices.scanFromLabel')}</div><TextInput data-testid="scan-from" type="number" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="w-32"><div className="text-xs text-ink2 mb-1.5">{t('devices.scanToLabel')}</div><TextInput data-testid="scan-to" type="number" value={to} onChange={(e) => setTo(e.target.value)} /></div>
      </div>
      <SectionTitle>{t('devices.scanResults')}</SectionTitle>
      <div className="text-xs text-ink2 -mt-1 mb-3">{t('devices.scanFound', { n: String(rows.length) })}</div>
      <DataTable<ScanRow>
        columns={[
          { id: 'unit', header: 'Unit ID', width: 120, render: (r: ScanRow) => <span className="font-medium">{r.unitId}</span> },
          { id: 'st', header: t('devices.colStatus'), width: 120, render: () => <StatusDot tone="ok" label={t('devices.online')} /> },
          { id: 'ms', header: t('devices.colResponseTime'), width: 140, render: (r: ScanRow) => <span className="text-xs">{r.responseMs.toFixed(1)} ms</span> },
          { id: 'resp', header: t('devices.colLastResponse'), width: 160, render: () => <span className="text-xs">{t('devices.normalResponse')}</span> },
          {
            id: 'op',
            header: t('devices.colActions'),
            width: 140,
            render: (r: ScanRow) =>
              workspace?.slaves.some((s) => s.connectionId === props.connectionId && s.unitId === r.unitId) ? (
                <span className="text-xs text-ink2">{t('devices.alreadyAdded')}</span>
              ) : (
                <button className="focus-ring cursor-pointer text-xs text-accent hover:underline" onClick={() => openOverlay({ kind: 'dialog', id: 'add-slave', connectionId: props.connectionId })}>
                  {t('devices.addSlave')}
                </button>
              ),
          },
        ]}
        rows={rows}
        rowKey={(r) => String(r.unitId)}
        empty={running ? t('devices.scanRunning') : t('devices.scanEmptyNone')}
      />
      {summary ? (
        <InfoBand className="mt-6">
          <div className="text-sm font-bold mb-1">{t('devices.scanSummaryTitle')}</div>
          <div className="text-sm">{summary}</div>
          <div className="text-xs text-ink2 mt-1">{t('devices.scanNextStep')}</div>
        </InfoBand>
      ) : null}
    </>
  );
}

/* ------------------------------- 18 — 设备 / 临时读取 ------------------------------- */

export function TempReadView(props: { connectionId: string }) {
  const { t } = useTranslation();
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
      setResult({ registers: payload.registers ?? payload.bits?.map((b) => (b ? 1 : 0)) ?? [], ms: res.value.durationMs, at: new Date().toISOString() });
    }
  };

  const rows = (result?.registers ?? []).map((v, i) => ({ addr: Number(start) + i, value: v }));

  return (
    <>
      <PageHeader title={t('devices.tempRead')} subtitle={t('devices.tempSubtitle', { slave: slave?.name ?? t('devices.slaveFallbackName', { unit }), unit })} />
      <InfoBand className="flex flex-wrap items-end gap-4">
        <div className="w-44"><div className="text-xs text-ink2 mb-1.5">{t('devices.tempAreaLabel')}</div><Select value={area} onChange={setArea} options={[1, 2, 3, 4].map((a) => ({ value: String(a), label: AREAS[a as 1 | 2 | 3 | 4] }))} /></div>
        <div className="w-28"><div className="text-xs text-ink2 mb-1.5">{t('devices.tempStartLabel')}</div><TextInput type="number" value={start} onChange={(e) => setStart(e.target.value)} /></div>
        <div className="w-28"><div className="text-xs text-ink2 mb-1.5">{t('devices.tempQtyLabel')}</div><TextInput type="number" value={qty} onChange={(e) => setQty(e.target.value)} /></div>
        <div className="w-40"><div className="text-xs text-ink2 mb-1.5">{t('devices.slaveLabel')}</div><TextInput type="number" value={unit} onChange={(e) => setUnit(e.target.value)} /></div>
        <div className="text-xs text-ink2 pb-2">{t('devices.requestPreview')} <span className="mono text-ink">FC0{area} · Start {start} · Qty {qty}</span></div>
        <div className="flex-1" />
        <Button variant="primary" onClick={() => void read()}>{t('devices.readButton')}</Button>
      </InfoBand>
      {result ? (
        <>
          <SectionTitle>{t('devices.readResults')}</SectionTitle>
          <div className="text-xs text-ink2 -mt-1 mb-3">{t('devices.lastRead', { at: fmtTime(result.at), ms: result.ms.toFixed(1) })}</div>
          <DataTable<{ addr: number; value: number }>
            columns={[
              { id: 'addr', header: t('devices.colAddress'), width: 90, render: (r: { addr: number; value: number }) => <span className="mono text-xs">{r.addr}</span> },
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
              <div className="text-sm font-bold text-accent mb-1">{t('devices.readSuccess')}</div>
              <div className="text-sm">{t('devices.readSuccessDetail', { n: String(rows.length), start, end: String(Number(start) + rows.length - 1), area, ms: result.ms.toFixed(1) })}</div>
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
                {t('devices.rawData')}
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
                {t('devices.saveAsBlock')}
              </Button>
            </div>
          </InfoBand>
        </>
      ) : (
        <InfoBand className="mt-6">{t('devices.tempHint')}</InfoBand>
      )}
      <div className="mt-4 text-xs text-ink2">{t('devices.connectionLine', { name: conn?.name ?? '—' })}</div>
    </>
  );
}

function ConnectionSettingsView(props: { connectionId: string }) {
  const { t } = useTranslation();
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
  const stateLabel = state === 'online' ? t('devices.stateConnected') : state === 'connecting' ? t('devices.stateConnecting') : state === 'error' ? t('devices.stateError') : t('devices.stateDisconnected');
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
    toast({ kind: 'success', title: t('devices.toastConnUpdated'), message: t('devices.toastConnUpdatedMsg') });
  };

  const toggleLink = async () => {
    setBusy(true);
    const res = live
      ? await command({ type: 'connection.disconnect', connectionId: conn.id })
      : await command({ type: 'connection.connect', connectionId: conn.id });
    setBusy(false);
    if (!res.ok) toast({ kind: 'error', title: live ? t('devices.toastDisconnectFailed') : t('devices.toastConnectFailed'), message: res.error });
  };

  return (
    <>
      <PageHeader
        title={conn.name}
        subtitle={conn.transport === 'rtu' ? t('devices.connSubtitleRtu', { port: String(conn.rtu?.port), baud: String(conn.rtu?.baudRate), frame: `${conn.rtu?.dataBits}${(conn.rtu?.parity ?? 'none').charAt(0).toUpperCase()}${conn.rtu?.stopBits}` }) : t('devices.connSubtitleTcp', { host: String(conn.tcp?.host), port: String(conn.tcp?.port) })}
        actions={
          <>
            <span className="inline-flex h-10 items-center rounded-ctl bg-surface2 px-4 text-sm">
              <StatusDot tone={state === 'online' ? 'ok' : state === 'error' ? 'err' : state === 'connecting' ? 'warn' : 'idle'} label={stateLabel} />
            </span>
            <Button disabled={!live} title={live ? undefined : t('devices.scanRequiresLink')} onClick={() => select({ connectionId: conn.id, deviceView: 'scan' })}>{t('devices.scan')}</Button>
            <Button disabled={!live} title={live ? undefined : t('devices.tempRequiresLink')} onClick={() => select({ connectionId: conn.id, deviceView: 'temp' })}>{t('devices.tempRead')}</Button>
            <Button disabled={busy} onClick={() => void toggleLink()}>{live ? t('devices.disconnect') : t('devices.connect')}</Button>
            <Button variant="primary" disabled={live || busy} title={live ? t('devices.saveRequiresDisconnect') : undefined} onClick={() => void save()}>{t('devices.save')}</Button>
          </>
        }
      />
      <InfoBand tone="blue">
        {live
          ? t('devices.liveLockHint')
          : t('devices.offlineEditHint')}
      </InfoBand>
      <InfoBand>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
          <Field label={t('devices.fieldName')}><TextInput disabled={live} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          {conn.transport === 'rtu' ? (
            <>
              <Field label={t('devices.fieldPort')} hint={live ? undefined : t('devices.portHint')}>
                <ComboInput testId="conn-port" value={port} onChange={setPort} options={portOptions} onOpen={refreshPorts} placeholder="COM1" disabled={live} />
              </Field>
              <Field label={t('devices.fieldBaud')} hint={live ? undefined : t('devices.baudHint')}>
                <ComboInput testId="conn-baud" value={baud} onChange={setBaud} options={BAUD_PRESETS} disabled={live} />
              </Field>
            </>
          ) : (
            <>
              <Field label={t('devices.fieldHost')}><TextInput disabled={live} value={host} onChange={(e) => setHost(e.target.value)} /></Field>
              <Field label={t('devices.fieldTcpPort')}><TextInput disabled={live} value={tcpPort} onChange={(e) => setTcpPort(e.target.value)} /></Field>
            </>
          )}
          <Field label={t('devices.fieldTimeoutMs')}><TextInput data-testid="timeout-input" disabled={live} value={timeout} onChange={(e) => setTimeoutMs(e.target.value)} /></Field>
          <Field label={t('devices.retries')}><TextInput disabled={live} value={retries} onChange={(e) => setRetries(e.target.value)} /></Field>
          <Field label={t('devices.fieldReconnect')}><Select disabled={live} value={reconnect} onChange={(v) => setReconnect(v as 'auto' | 'manual')} options={[{ value: 'auto', label: t('devices.reconnectAuto') }, { value: 'manual', label: t('devices.reconnectManual') }]} /></Field>
          <Field label={t('devices.fieldRts')}><Select disabled={live} value={rts} onChange={(v) => setRts(v as 'none' | 'toggle')} options={[{ value: 'none', label: 'None' }, { value: 'toggle', label: 'Toggle' }]} /></Field>
          <Field label={t('devices.fieldLogLevel')}><Select disabled={live} value={logLevel} onChange={(v) => setLogLevel(v as 'info' | 'debug')} options={[{ value: 'info', label: 'Info' }, { value: 'debug', label: 'Debug' }]} /></Field>
          <Field label={t('devices.fieldInterFrame')}><TextInput disabled={live} value={interFrame} onChange={(e) => setInterFrame(e.target.value)} /></Field>
        </div>
      </InfoBand>
      <SectionTitle right={<Button variant="primary" onClick={() => openOverlay({ kind: 'dialog', id: 'add-slave', connectionId: conn.id })}>{t('devices.addSlavePlus')}</Button>}>{t('devices.slaveLabel')}</SectionTitle>
      {slaves.length === 0 ? (
        <InfoBand tone="blue">{t('devices.noSlavesHint')}</InfoBand>
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
                <div className="text-xs text-ink2 mt-1">{t('devices.slaveCardMeta', { unit: String(sl.unitId), template: tpl ? tpl.name : t('devices.unboundTemplate') })}</div>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
