import { useEffect, useRef, useState } from 'react';
import { useApp, useWorkspace } from '../../store/app';
import { Button, ComboInput, Dialog, Field, InfoBand, Select, TextInput } from '../../components/ui';
import { BAUD_PRESETS } from './baud-presets';
import { useTranslation } from '../../i18n';
import { uid } from '../../uid';

export function AddConnectionDialog(props: { connectionId?: string }) {
  const { t } = useTranslation();
  const workspace = useWorkspace();
  const existingConn = workspace?.connections.find((c) => c.id === props.connectionId);
  const command = useApp((s) => s.command);
  const close = useApp((s) => s.closeOverlay);
  const toast = useApp((s) => s.toast);
  const [name, setName] = useState(existingConn?.name ?? t('overlays.defaultConnName'));
  const [protocol, setProtocol] = useState<'rtu' | 'tcp'>(existingConn?.transport ?? 'rtu');
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
  const [reconnect, setReconnect] = useState<'auto' | 'manual'>(existingConn?.reconnect ?? 'auto');

  const create = async () => {
    if (!workspace) return;
    const id = existingConn?.id ?? uid('conn');
    const conn = {
      id,
      name,
      transport: protocol,
      rtu: protocol === 'rtu' ? { port, baudRate: Number(baud), dataBits: Number(dataBits) as 7 | 8, parity, stopBits: Number(stopBits) as 1 | 2 } : undefined,
      tcp: protocol === 'tcp' ? { host, port: Number(tcpPort) } : undefined,
      timeoutMs: Number(timeout),
      retries: Number(retries),
      reconnect,
      interFrameMs: Number(interFrame) || 0,
      rtsControl: rts,
      logLevel,
    };
    if (!(await command({ type: 'connection.upsert', connection: conn })).ok) return;
    toast({ kind: 'success', title: existingConn ? t('overlays.toastConnUpdated') : t('overlays.toastConnCreated'), message: existingConn ? t('overlays.toastConnUpdatedMsg') : t('overlays.toastConnCreatedMsg') });
    close();
  };

  return (
    <Dialog title={existingConn ? t('overlays.editConnTitle') : t('overlays.addConnTitle')} subtitle={t('overlays.connSubtitle')} width={660} onClose={close} footer={<><Button onClick={close}>{t('overlays.cancel')}</Button><Button variant="primary" onClick={() => void create()}>{existingConn ? t('overlays.saveChanges') : t('overlays.createConn')}</Button></>}>
      <Field label={t('overlays.fieldName')}><TextInput value={name} onChange={(e) => setName(e.target.value)} /></Field>
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
          <Field label={t('overlays.fieldHost')}><TextInput value={host} onChange={(e) => setHost(e.target.value)} /></Field>
          <Field label={t('overlays.fieldTcpPort')}><TextInput value={tcpPort} onChange={(e) => setTcpPort(e.target.value)} /></Field>
        </div>
      )}
      <div className="mt-4 grid grid-cols-3 gap-4">
        <Field label={t('overlays.fieldTimeout')}><TextInput data-testid="timeout-input" value={timeout} onChange={(e) => setTimeoutMs(e.target.value)} /></Field>
        <Field label={t('overlays.retries')}><TextInput value={retries} onChange={(e) => setRetries(e.target.value)} /></Field>
        <Field label={t('overlays.fieldReconnect')}><Select value={reconnect} onChange={(v) => setReconnect(v as typeof reconnect)} options={[{ value: 'auto', label: t('overlays.reconnectAuto') }, { value: 'manual', label: t('overlays.reconnectManual') }]} /></Field>
      </div>
      <InfoBand tone="blue" className="mt-5">
        <div className="text-sm font-bold text-accent mb-1">{t('overlays.afterCreate')}</div>
        <div className="text-sm">{t('overlays.afterCreateBody')}</div>
      </InfoBand>
      <div className="mt-5 grid grid-cols-3 gap-4">
        <Field label={t('overlays.fieldInterFrame')}><TextInput type="number" value={interFrame} onChange={(e) => setInterFrame(e.target.value)} /></Field>
        <Field label={t('overlays.fieldRts')}><Select value={rts} onChange={(v) => setRts(v as 'none' | 'toggle')} options={[{ value: 'none', label: 'None' }, { value: 'toggle', label: 'Toggle' }]} /></Field>
        <Field label={t('overlays.fieldLogLevel')}><Select value={logLevel} onChange={(v) => setLogLevel(v as 'info' | 'debug')} options={[{ value: 'info', label: 'Info' }, { value: 'debug', label: 'Debug' }]} /></Field>
      </div>
    </Dialog>
  );
}
