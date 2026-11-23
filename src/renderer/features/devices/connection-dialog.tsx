import { useEffect, useRef, useState } from 'react';
import { useApp, useWorkspace } from '../../store/app';
import { Button, ComboInput, Dialog, Field, InfoBand, Select, TextInput } from '../../components/ui';
import { BAUD_PRESETS } from './baud-presets';
import { useTranslation } from '../../i18n';
import { uid } from '../../uid';
import { connectionSchema, DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_RECONNECT_INTERVAL_MS } from '../../../domain/model';

export function AddConnectionDialog(props: { connectionId?: string }) {
  const { t } = useTranslation();
  const workspace = useWorkspace();
  const [existingConn] = useState(() => workspace?.connections.find((c) => c.id === props.connectionId));
  const command = useApp((s) => s.command);
  const close = useApp((s) => s.closeOverlay);
  const toast = useApp((s) => s.toast);
  const [name, setName] = useState(existingConn?.name ?? t('overlays.defaultConnName'));
  const [protocol, setProtocol] = useState<'rtu' | 'tcp'>(existingConn?.transport ?? 'rtu');
  const [role, setRole] = useState<'master' | 'slave'>(existingConn?.role ?? 'master');
  const [port, setPort] = useState(existingConn?.rtu?.port ?? '');
  const [portOptions, setPortOptions] = useState<Array<{ value: string; label: string }>>([]);
  const portTouched = useRef(false);
  const [baud, setBaud] = useState(String(existingConn?.rtu?.baudRate ?? 115200));
  const [rts, setRts] = useState<'none' | 'toggle'>(existingConn?.rtsControl ?? 'none');
  const [logLevel, setLogLevel] = useState<'info' | 'debug'>(existingConn?.logLevel ?? 'info');
  const [interFrame, setInterFrame] = useState(String(existingConn?.interFrameMs ?? 0));
  const applyPorts = (ports: Array<{ path: string; manufacturer: string | null }>) => {
    setPortOptions(ports.map((p) => ({ value: p.path, label: p.manufacturer ? `${p.path} · ${p.manufacturer}` : p.path })));
    // A brand-new connection defaults to the first port the machine actually has.
    if (!portTouched.current && !existingConn && ports.length > 0) setPort(ports[0]!.path);
  };
  const refreshPorts = () => {
    void command<{ path: string; manufacturer: string | null }[]>({ type: 'serial.list' }).then((res) => {
      if (res.ok) applyPorts(res.value);
    });
  };
  // enumerate once on open so the field shows a real port before the dropdown is touched
  useEffect(() => {
    void command<{ path: string; manufacturer: string | null }[]>({ type: 'serial.list' }).then((res) => {
      if (res.ok) applyPorts(res.value);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Editing an existing connection must seed every field from it, otherwise saving
  // would silently reset the frame format back to the dialog defaults.
  const [dataBits, setDataBits] = useState(String(existingConn?.rtu?.dataBits ?? 8));
  const [parity, setParity] = useState<'none' | 'even' | 'odd'>(existingConn?.rtu?.parity ?? 'none');
  const [stopBits, setStopBits] = useState(String(existingConn?.rtu?.stopBits ?? 1));
  const [host, setHost] = useState(existingConn?.tcp?.host ?? '192.168.1.50');
  const [tcpPort, setTcpPort] = useState(String(existingConn?.tcp?.port ?? 502));
  const [timeout, setTimeoutMs] = useState(String(existingConn?.timeoutMs ?? 500));
  const [retries, setRetries] = useState(String(existingConn?.retries ?? 1));
  const [retryDelay, setRetryDelay] = useState(String(existingConn?.retryDelayMs ?? 50));
  const validRetryDelay = retryDelay.trim() !== '' && Number.isInteger(Number(retryDelay)) && Number(retryDelay) >= 0 && Number(retryDelay) <= 60000;
  const [reconnect, setReconnect] = useState<'auto' | 'manual'>(existingConn?.reconnect ?? 'auto');
  const [connectTimeout, setConnectTimeout] = useState(String(existingConn?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS));
  const [reconnectInterval, setReconnectInterval] = useState(String(existingConn?.reconnectIntervalMs ?? DEFAULT_RECONNECT_INTERVAL_MS));
  const validConnectTimeout = connectTimeout.trim() !== '' && connectionSchema.shape.connectTimeoutMs.safeParse(Number(connectTimeout)).success;
  const validReconnectInterval = reconnectInterval.trim() !== '' && connectionSchema.shape.reconnectIntervalMs.safeParse(Number(reconnectInterval)).success;
  const validTiming = validConnectTimeout && (reconnect === 'manual' || validReconnectInterval);

  const create = async () => {
    if (!workspace || !validTiming || (role === 'master' && !validRetryDelay)) return;
    const id = existingConn?.id ?? uid('conn');
    const conn = {
      id,
      name,
      transport: protocol,
      role: role === 'master' && !existingConn?.role ? undefined : role,
      rtu: protocol === 'rtu' ? { port, baudRate: Number(baud), dataBits: Number(dataBits) as 7 | 8, parity, stopBits: Number(stopBits) as 1 | 2 } : undefined,
      tcp: protocol === 'tcp' ? { host, port: Number(tcpPort) } : undefined,
      timeoutMs: Number(timeout),
      retries: Number(retries),
      retryDelayMs: validRetryDelay ? Number(retryDelay) : existingConn?.retryDelayMs ?? 50,
      reconnect,
      connectTimeoutMs: Number(connectTimeout),
      reconnectIntervalMs: validReconnectInterval ? Number(reconnectInterval) : existingConn?.reconnectIntervalMs ?? DEFAULT_RECONNECT_INTERVAL_MS,
      interFrameMs: Number(interFrame) || 0,
      rtsControl: rts,
      logLevel,
    };
    if (!(await command({ type: 'connection.upsert', connection: conn, expected: existingConn ?? null })).ok) return;
    toast({ kind: 'success', title: existingConn ? t('overlays.toastConnUpdated') : t('overlays.toastConnCreated'), message: existingConn ? t('overlays.toastConnUpdatedMsg') : t('overlays.toastConnCreatedMsg') });
    close();
  };

  return (
    <Dialog title={existingConn ? t('overlays.editConnTitle') : t('overlays.addConnTitle')} subtitle={t('overlays.connSubtitle')} width={660} onClose={close} footer={<><Button onClick={close}>{t('overlays.cancel')}</Button><Button variant="primary" disabled={!validTiming || (role === 'master' && !validRetryDelay)} onClick={() => void create()}>{existingConn ? t('overlays.saveChanges') : t('overlays.createConn')}</Button></>}>
      <Field label={t('overlays.fieldName')}><TextInput value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="mt-4"><Field label={t('slave.role')}><Select value={role} onChange={value => { const next = value as typeof role; setRole(next); if (!existingConn && (host === '192.168.1.50' || host === '127.0.0.1')) setHost(next === 'slave' ? '127.0.0.1' : '192.168.1.50'); }} options={[{ value: 'master', label: t('slave.master') }, { value: 'slave', label: t('slave.slave') }]} /></Field></div>
      <div className="mt-4">
        <div className="text-xs text-ink2 mb-1.5">{t('overlays.protocol')}</div>
        <div className="grid grid-cols-2 rounded-ctl bg-accentsoft p-1 text-sm">
          {(['rtu', 'tcp'] as const).map((p) => (
            <button key={p} className={`focus-ring cursor-pointer rounded py-2 font-medium ${protocol === p ? 'bg-surface text-accent shadow-sm' : 'text-ink2'}`} onClick={() => setProtocol(p)}>
              {p.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      {protocol === 'rtu' ? (
        <>
          <div className="mt-4 grid grid-cols-2 gap-4">
            <Field label={t('overlays.fieldPort')} hint={t('overlays.portHint')}>
              <ComboInput
                testId="port-combo"
                value={port}
                onChange={(v) => {
                  portTouched.current = true;
                  setPort(v);
                }}
                options={portOptions}
                onOpen={refreshPorts}
                placeholder="COM1"
              />
            </Field>
            <Field label={t('overlays.fieldBaud')} hint={t('overlays.baudHint')}>
              <ComboInput testId="baud-combo" value={baud} onChange={(v) => setBaud(v)} options={BAUD_PRESETS} />
            </Field>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-4">
            <Field label={t('overlays.fieldDataBits')}><Select value={dataBits} onChange={setDataBits} options={[{ value: '8', label: '8' }, { value: '7', label: '7' }]} /></Field>
            <Field label={t('overlays.fieldParity')}><Select value={parity} onChange={(v) => setParity(v as typeof parity)} options={[{ value: 'none', label: 'None' }, { value: 'even', label: 'Even' }, { value: 'odd', label: 'Odd' }]} /></Field>
            <Field label={t('overlays.fieldStopBits')}><Select value={stopBits} onChange={setStopBits} options={[{ value: '1', label: '1' }, { value: '2', label: '2' }]} /></Field>
          </div>
        </>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-4">
          <Field label={role === 'slave' ? t('slave.listenHost') : t('overlays.fieldHost')} hint={role === 'slave' ? t('slave.listenHint') : undefined}><TextInput value={host} onChange={(e) => setHost(e.target.value)} /></Field>
          <Field label={t('overlays.fieldTcpPort')}><TextInput value={tcpPort} onChange={(e) => setTcpPort(e.target.value)} /></Field>
        </div>
      )}
      <div className="mt-4 grid grid-cols-2 gap-4">
        <Field label={t(role === 'slave' ? 'devices.startTimeout' : 'devices.connectTimeout')} hint={t(role === 'slave' ? 'devices.startTimeoutHint' : 'devices.connectTimeoutHint')}><TextInput aria-label={t(role === 'slave' ? 'devices.startTimeout' : 'devices.connectTimeout')} type="number" min={1} max={60000} step={1} value={connectTimeout} aria-invalid={!validConnectTimeout} onChange={e => setConnectTimeout(e.target.value)} /></Field>
        {role === 'master' ? <>
        <Field label={t('overlays.fieldTimeout')}><TextInput data-testid="timeout-input" value={timeout} onChange={(e) => setTimeoutMs(e.target.value)} /></Field>
        <Field label={t('overlays.retries')}><TextInput value={retries} onChange={(e) => setRetries(e.target.value)} /></Field>
        <Field label={t('devices.retryDelay')} hint={t('devices.retryDelayHint')}><TextInput aria-label={t('devices.retryDelay')} type="number" min={0} max={60000} step={1} value={retryDelay} aria-invalid={!validRetryDelay} onChange={e => setRetryDelay(e.target.value)} /></Field>
        </> : null}
        <Field label={t('overlays.fieldReconnect')}><Select value={reconnect} onChange={(v) => setReconnect(v as typeof reconnect)} options={[{ value: 'auto', label: t('overlays.reconnectAuto') }, { value: 'manual', label: t('overlays.reconnectManual') }]} /></Field>
        <Field label={t('devices.reconnectInterval')} hint={t('devices.reconnectIntervalHint')}><TextInput aria-label={t('devices.reconnectInterval')} type="number" min={0} max={60000} step={1} disabled={reconnect === 'manual'} value={reconnectInterval} aria-invalid={reconnect === 'auto' && !validReconnectInterval} onChange={e => setReconnectInterval(e.target.value)} /></Field>
      </div>
      {role === 'master' && !validRetryDelay ? <div role="alert" className="mt-2 text-xs text-err">{t('devices.retryDelayError')}</div> : null}
      {!validConnectTimeout ? <div role="alert" className="mt-2 text-xs text-err">{t('devices.connectTimeoutError')}</div> : null}
      {reconnect === 'auto' && !validReconnectInterval ? <div role="alert" className="mt-2 text-xs text-err">{t('devices.reconnectIntervalError')}</div> : null}
      <InfoBand tone="blue" className="mt-5">
        <div className="text-sm font-bold text-accent mb-1">{t('overlays.afterCreate')}</div>
        <div className="text-sm">{role === 'slave' ? t('slave.setupHint') : t('overlays.afterCreateBody')}</div>
      </InfoBand>
      <details className="mt-5">
        <summary className="cursor-pointer text-sm text-ink2">{t('devices.advancedConnection')}</summary>
        <div className="mt-3 grid grid-cols-2 gap-4">
          {role === 'master' ? <Field label={t('overlays.fieldInterFrame')} hint={t('devices.requestGapHint')}><TextInput type="number" min={0} max={100} value={interFrame} onChange={(e) => setInterFrame(e.target.value)} /></Field> : null}
          {protocol === 'rtu' ? <Field label={t('overlays.fieldRts')}><Select value={rts} onChange={(v) => setRts(v as 'none' | 'toggle')} options={[{ value: 'none', label: 'None' }, { value: 'toggle', label: 'Toggle' }]} /></Field> : null}
          <Field label={t('overlays.fieldLogLevel')}><Select value={logLevel} onChange={(v) => setLogLevel(v as 'info' | 'debug')} options={[{ value: 'info', label: 'Info' }, { value: 'debug', label: 'Debug' }]} /></Field>
        </div>
      </details>
    </Dialog>
  );
}
