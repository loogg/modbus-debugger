import React, { useEffect, useRef, useState } from 'react';
import { useApp, useBlocks, usePoints, useWorkspace } from '../store/app';
import { Button, Checkbox, ComboInput, Dialog, Drawer, Field, InfoBand, Select, TextInput } from '../components/ui';
import { AREAS } from '../../domain/address';
import { BAUD_PRESETS } from './devices';
import { findBlockOverlaps } from '../../domain/overlap';
import { registersForType, type RawType } from '../../domain/mapping';
import { engineeringToRaw } from '../../domain/scale';
import type { BlockDef, PointDef } from '../../domain/model';
import { useTranslation } from '../i18n';

const uid = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export function Overlays() {
  const overlay = useApp((s) => s.overlay);
  if (!overlay) return null;
  switch (overlay.kind) {
    case 'dialog':
      if (overlay.id === 'add-connection') return <AddConnectionDialog connectionId={overlay.connectionId} />;
      if (overlay.id === 'add-slave') return <AddSlaveDialog connectionId={overlay.connectionId} slaveId={overlay.slaveId} />;
      if (overlay.id === 'edit-block') return <EditBlockDialog templateId={overlay.templateId} blockId={overlay.blockId} />;
      if (overlay.id === 'new-trend-group') return <NewTrendGroupDialog />;
      if (overlay.id === 'add-signal') return <AddSignalDialog groupId={overlay.groupId} />;
      if (overlay.id === 'save-as-block') return <SaveAsBlockDialog {...overlay} />;
      if (overlay.id === 'confirm') return <ConfirmDialog title={overlay.title} message={overlay.message} confirmLabel={overlay.confirmLabel} danger={overlay.danger} onConfirm={overlay.onConfirm} />;
      return null;
    case 'drawer':
      if (overlay.id === 'edit-point') return <EditPointDrawer templateId={overlay.templateId} blockId={overlay.blockId} pointId={overlay.pointId} />;
      if (overlay.id === 'inspector') return <InspectorDrawer pointId={overlay.pointId} />;
      return null;
    default:
      return null;
  }
}

function AddConnectionDialog(props: { connectionId?: string }) {
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
    const connections = existingConn
      ? workspace.connections.map((c) => (c.id === existingConn.id ? conn : c))
      : [...workspace.connections, conn];
    await command({ type: 'workspace.apply', workspace: { ...workspace, connections } });
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
function AddSlaveDialog(props: { connectionId: string; slaveId?: string }) {
  const { t } = useTranslation();
  const workspace = useWorkspace();
  const command = useApp((s) => s.command);
  const close = useApp((s) => s.closeOverlay);
  const select = useApp((s) => s.select);
  const setModule = useApp((s) => s.setModule);
  const existing = workspace?.slaves.find((s) => s.id === props.slaveId);
  // Default to the first free Unit ID on this connection so a new slave never starts in conflict.
  const nextUnit = (() => {
    const used = new Set((workspace?.slaves ?? []).filter((s) => s.connectionId === props.connectionId).map((s) => s.unitId));
    let n = 1;
    while (used.has(n) && n < 247) n += 1;
    return n;
  })();
  const [name, setName] = useState(existing?.name ?? t('overlays.slaveDefaultName', { unit: String(nextUnit) }));
  const [unit, setUnit] = useState(String(existing?.unitId ?? nextUnit));
  const [templateId, setTemplateId] = useState(existing?.templateId ?? workspace?.templates[0]?.id ?? '');
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const conn = workspace?.connections.find((c) => c.id === props.connectionId);
  const template = workspace?.templates.find((t) => t.id === templateId);
  const conflict = workspace?.slaves.some((s) => s.connectionId === props.connectionId && s.unitId === Number(unit) && s.id !== props.slaveId);

  const save = async () => {
    if (!workspace) return;
    const ws = workspace;
    if (existing) {
      await command({ type: 'workspace.apply', workspace: { ...ws, slaves: ws.slaves.map((s) => (s.id === existing.id ? { ...s, name, unitId: Number(unit), templateId, enabled } : s)) } });
    } else {
      await command({ type: 'workspace.apply', workspace: { ...ws, slaves: [...ws.slaves, { id: uid('slave'), connectionId: props.connectionId, unitId: Number(unit), name, templateId, enabled }] } });
    }
    close();
  };

  return (
    <Dialog title={existing ? t('overlays.editSlaveTitle') : t('overlays.addSlaveTitle')} subtitle={conn?.name ?? ''} width={660} onClose={close} footer={<><Button onClick={close}>{t('overlays.cancel')}</Button><Button variant="primary" disabled={conflict} onClick={() => void save()}>{existing ? t('overlays.saveSlave') : t('overlays.addSlaveTitle')}</Button></>}>
      <Field label={t('overlays.fieldOwnerConn')}><TextInput readOnly value={`${conn?.name ?? ''} · ${conn?.transport === 'rtu' ? `${conn.rtu?.baudRate} ${conn.rtu?.dataBits}${conn.rtu?.parity.charAt(0).toUpperCase()}${conn.rtu?.stopBits}` : conn?.tcp?.host}`} /></Field>
      <div className="mt-4 grid grid-cols-2 gap-4">
        <Field label={t('overlays.fieldDeviceName')}><TextInput value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={t('overlays.fieldSlaveAddr')}><TextInput type="number" value={unit} onChange={(e) => setUnit(e.target.value)} /></Field>
      </div>
      <div className="mt-4">
        <div className="text-xs text-ink2 mb-1.5">{t('overlays.deviceTemplate')}</div>
        <Select value={templateId} onChange={setTemplateId} options={[{ value: '', label: t('overlays.noTemplateOption') }, ...(workspace?.templates.map((t) => ({ value: t.id, label: t.name })) ?? [])]} />
      </div>
      {templateId === '' ? (
        <InfoBand tone="blue" className="mt-3">{t('overlays.noTemplateHint')}</InfoBand>
      ) : template ? (
        <div className="mt-3 rounded-card bg-surface2 p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-bold">{template.name}</span>
            <span className="flex gap-4 text-xs text-accent">
              <button className="focus-ring cursor-pointer hover:underline" onClick={() => { select({ templateId: template.id }); setModule('templates'); close(); }}>{t('overlays.viewTemplate')}</button>
              <button className="focus-ring cursor-pointer hover:underline" onClick={async () => {
                if (!workspace) return;
                const copy = { ...template, id: uid('tpl'), name: t('overlays.templateCopyName', { name: template.name }) };
                await command({ type: 'workspace.apply', workspace: { ...workspace, templates: [...workspace.templates, copy] } });
                setTemplateId(copy.id);
              }}>{t('overlays.copyAsNewTemplate')}</button>
            </span>
          </div>
          <div className="text-xs text-ink2 mt-1">{t('overlays.templateStats', { blocks: String(template.blocks.length), points: String(template.points.length), slaves: String(workspace?.slaves.filter((s) => s.templateId === template.id).length) })}</div>
          <div className="text-xs text-ink2 mt-1">{template.blocks.map((b) => b.name).join(' · ')}</div>
          <div className="text-xs text-ink2 mt-2">{t('overlays.templateEditAffectsAll')}</div>
        </div>
      ) : null}
      <div className="mt-4 grid grid-cols-2 gap-6">
        <div>
          <div className="text-xs text-ink2 mb-1.5">{t('overlays.instanceOptions')}</div>
          <Checkbox checked={enabled} onCheckedChange={setEnabled} label={t('overlays.enableSlave')} />
        </div>
        <div>
          <div className="text-xs text-ink2 mb-1.5">{t('overlays.addrConflictCheck')}</div>
          <div className={`rounded-ctl border px-3 py-2 text-xs ${conflict ? 'border-err text-err' : 'border-line text-ok'}`}>{conflict ? t('overlays.unitTaken', { unit }) : t('overlays.unitFree', { unit })}</div>
        </div>
      </div>
      <InfoBand tone="blue" className="mt-4">{t('overlays.copyTemplateHint')}</InfoBand>
    </Dialog>
  );
}

function EditBlockDialog(props: { templateId: string; blockId?: string }) {
  const { t } = useTranslation();
  const workspace = useWorkspace();
  const command = useApp((s) => s.command);
  const close = useApp((s) => s.closeOverlay);
  const template = workspace?.templates.find((t) => t.id === props.templateId);
  const existing = template?.blocks.find((b) => b.id === props.blockId);
  const [name, setName] = useState(existing?.name ?? t('overlays.defaultBlockName'));
  const [area, setArea] = useState(String(existing?.area ?? 3));
  const [start, setStart] = useState(String(existing?.start ?? 0));
  const [length, setLength] = useState(String(existing?.length ?? 32));
  const [period, setPeriod] = useState(String(existing?.periodMs ?? 100));
  if (!workspace || !template) return null;
  const candidate: BlockDef = { id: existing?.id ?? 'new', name, area: Number(area) as 1 | 2 | 3 | 4, start: Number(start), length: Number(length), periodMs: Number(period) };
  const others = template.blocks.filter((b) => b.id !== existing?.id);
  const overlaps = findBlockOverlaps([...others, candidate]);
  const bad = overlaps.length > 0;
  const save = async () => {
    const blocks = existing ? template.blocks.map((b) => (b.id === existing.id ? { ...candidate, id: existing.id } : b)) : [...template.blocks, { ...candidate, id: uid('blk') }];
    await command({ type: 'workspace.apply', workspace: { ...workspace, templates: workspace.templates.map((t) => (t.id === template.id ? { ...t, blocks } : t)) } });
    close();
  };
  return (
    <Dialog title={existing ? t('overlays.editBlockTitle') : t('overlays.newBlockTitle')} subtitle={t('overlays.blockSubtitle')} width={620} onClose={close} footer={<><Button onClick={close}>{t('overlays.cancel')}</Button><Button variant="primary" disabled={bad} onClick={() => void save()}>{t('overlays.saveBlock')}</Button></>}>
      <Field label={t('overlays.name')}><TextInput value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="mt-4">
        <Field label={t('overlays.area')}>
          <Select value={area} onChange={setArea} options={[1, 2, 3, 4].map((a) => ({ value: String(a), label: AREAS[a as 1 | 2 | 3 | 4] ?? String(a) }))} />
        </Field>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-4">
        <Field label={t('overlays.startAddr')}><TextInput type="number" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
        <Field label={t('overlays.length')}><TextInput type="number" value={length} onChange={(e) => setLength(e.target.value)} /></Field>
        <Field label={t('overlays.defaultPeriod')}><Select value={period} onChange={setPeriod} options={['50', '100', '200', '500', '1000'].map((p) => ({ value: p, label: `${p} ms` }))} /></Field>
      </div>
      <div className="mt-4">
        <div className="text-xs text-ink2 mb-1.5">{t('overlays.computedRange')}</div>
        <InfoBand className="flex items-center justify-between"><span className="text-sm font-bold mono">{candidate.start}–{candidate.start + candidate.length - 1}</span><span className="text-xs text-ink2">{t('overlays.registerCount', { n: String(candidate.length) })}</span></InfoBand>
      </div>
      <div className="mt-4">
        <div className="text-xs text-ink2 mb-1.5">{t('overlays.rangeValidation')}</div>
        <InfoBand className={bad ? 'bg-[#FDECEA]' : 'bg-accentsoft'}>
          <div className={`text-sm ${bad ? 'text-err' : 'text-ok'}`}>{bad ? t('overlays.overlapError', { names: overlaps.map((o) => (o.blockA === name ? o.blockB : o.blockA)).join(t('overlays.listSep')) }) : t('overlays.noOverlapOk')}</div>
          {others.filter((o) => o.area === candidate.area).map((o) => (
            <div key={o.id} className="text-xs text-ink2 mt-1">{t('overlays.overlapItem', { name: o.name, start: String(o.start), end: String(o.start + o.length - 1) })}</div>
          ))}
        </InfoBand>
      </div>
    </Dialog>
  );
}

function EditPointDrawer(props: { templateId: string; blockId: string; pointId?: string }) {
  const { t } = useTranslation();
  const workspace = useWorkspace();
  const command = useApp((s) => s.command);
  const close = useApp((s) => s.closeOverlay);
  const template = workspace?.templates.find((t) => t.id === props.templateId);
  const block = template?.blocks.find((b) => b.id === props.blockId);
  const existing = template?.points.find((p) => p.id === props.pointId);
  const [name, setName] = useState(existing?.name ?? t('overlays.defaultPointName'));
  const [rawType, setRawType] = useState<RawType>(existing?.mapping.rawType ?? 'UInt16');
  const [offset, setOffset] = useState(String(existing?.mapping.offset ?? 0));
  const [bitOffset, setBitOffset] = useState(String(existing?.mapping.bitOffset ?? 0));
  const [bitWidth, setBitWidth] = useState(String(existing?.mapping.bitWidth ?? 3));
  const [access, setAccess] = useState<'ro' | 'rw'>(existing?.access ?? 'rw');
  const [unit, setUnit] = useState(existing?.unit ?? '');
  const [format, setFormat] = useState(existing?.displayFormat ?? 'auto');
  const [scale, setScale] = useState(String(existing?.scale ?? 1));
  const [offsetEng, setOffsetEng] = useState(String(existing?.offset ?? 0));
  const [wordOrder, setWordOrder] = useState(existing?.mapping.wordOrder ?? 'ABCD');
  const [encoding, setEncoding] = useState(existing?.mapping.stringEncoding ?? 'ascii');
  const [strLen, setStrLen] = useState(String(existing?.mapping.stringLength ?? 8));
  const [enumText, setEnumText] = useState(Object.entries(existing?.enumMap ?? {}).map(([k, v]) => `${k}=${v}`).join(', '));
  const [highRisk, setHighRisk] = useState(existing?.highRisk ?? false);
  if (!workspace || !template || !block) return null;

  const isNumeric = !['Bool', 'String'].includes(rawType);
  const showScale = isNumeric && !enumText.trim();
  const mapping = {
    rawType,
    offset: Number(offset),
    registerCount: rawType === 'String' ? Math.max(1, Math.ceil(Number(strLen) / 2)) : registersForType(rawType, Number(strLen)),
    wordOrder,
    byteSelector: existing?.mapping.byteSelector ?? ('low' as const),
    bitOffset: Number(bitOffset),
    bitWidth: Number(bitWidth),
    stringLength: Number(strLen),
    stringEncoding: encoding,
  };
  const enumMap = Object.fromEntries(
    enumText.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean).map((pair) => {
      const [k, v] = pair.split('=');
      return [k as string, v as string];
    }),
  );
  const shared = template.points.filter((p) => p.id !== existing?.id && p.blockId === block.id && p.mapping.offset < mapping.offset + mapping.registerCount && mapping.offset < p.mapping.offset + p.mapping.registerCount);
  const scaleNum = Number(scale);
  const conv = showScale ? engineeringToRaw(1500, { scale: scaleNum, offset: Number(offsetEng) }, rawType, Number(bitWidth)) : null;

  const save = async () => {
    const point: PointDef = {
      id: existing?.id ?? uid('pt'),
      blockId: block.id,
      name,
      mapping,
      scale: scaleNum,
      offset: Number(offsetEng),
      unit,
      access,
      displayFormat: format,
      enumMap,
      highRisk,
      description: existing?.description ?? '',
    };
    const points = existing ? template.points.map((p) => (p.id === existing.id ? point : p)) : [...template.points, point];
    await command({ type: 'workspace.apply', workspace: { ...workspace, templates: workspace.templates.map((t) => (t.id === template.id ? { ...t, points } : t)) } });
    close();
  };

  return (
    <Drawer
      title={t('overlays.editPointTitle')}
      subtitle={existing ? t('overlays.editPointSubtitleNumeric') : t('overlays.editPointSubtitleNew')}
      width={590}
      onClose={close}
      footer={<><Button onClick={close}>{t('overlays.cancel')}</Button><Button variant="primary" onClick={() => void save()}>{t('overlays.savePoint')}</Button></>}
    >
      <div className="text-xs text-ink2 mb-1.5">{t('overlays.basicSettings')}</div>
      <Field label={t('overlays.name')}><TextInput value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="mt-5 text-xs text-ink2 mb-1.5">{t('overlays.memoryMapping')}</div>
      <div className="grid grid-cols-3 gap-4">
        <Field label={t('overlays.registerOffset')}><TextInput type="number" value={offset} onChange={(e) => setOffset(e.target.value)} /></Field>
        <Field label={t('overlays.dataType')}><Select value={rawType} onChange={(v) => setRawType(v as RawType)} options={['Bool', 'BitField', 'Int8', 'UInt8', 'Int16', 'UInt16', 'Int32', 'UInt32', 'Float32', 'Float64', 'String'].map((t) => ({ value: t, label: t }))} /></Field>
        <Field label={t('overlays.registerQty')}><TextInput type="number" value={String(mapping.registerCount)} readOnly /></Field>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-4">
        <Field label={t('overlays.bitOffset')}><TextInput type="number" value={bitOffset} onChange={(e) => setBitOffset(e.target.value)} disabled={rawType !== 'BitField' && rawType !== 'Bool'} /></Field>
        <Field label={t('overlays.bitWidth')}><TextInput type="number" value={bitWidth} onChange={(e) => setBitWidth(e.target.value)} disabled={rawType !== 'BitField'} /></Field>
        <Field label={t('overlays.access')}><Select value={access} onChange={(v) => setAccess(v as 'ro' | 'rw')} options={[{ value: 'ro', label: t('overlays.accessRo') }, { value: 'rw', label: t('overlays.accessRw') }]} disabled={block.area === 2 || block.area === 4} /></Field>
      </div>
      <div className="mt-5 text-xs text-ink2 mb-1.5">{t('overlays.displayAndConvert')}</div>
      <div className="grid grid-cols-3 gap-4">
        <Field label={t('overlays.format')}><Select value={format} onChange={(v) => setFormat(v as typeof format)} options={[{ value: 'auto', label: t('overlays.formatDec') }, { value: 'hex', label: t('overlays.formatHex') }, { value: 'binary', label: t('overlays.formatBin') }]} /></Field>
        <Field label={t('overlays.unit')}><TextInput value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="—" /></Field>
        <Field label={t('overlays.scaleOffset')}><TextInput readOnly value={showScale ? t('overlays.scaleConfigurable') : t('overlays.scaleNA')} /></Field>
      </div>
      {showScale ? (
        <div className="mt-4 grid grid-cols-2 gap-4">
          <Field label={t('overlays.scaleFactor')}><TextInput value={scale} onChange={(e) => setScale(e.target.value)} /></Field>
          <Field label={t('overlays.offsetAmount')}><TextInput value={offsetEng} onChange={(e) => setOffsetEng(e.target.value)} /></Field>
        </div>
      ) : null}
      {showScale ? (
        <InfoBand tone="blue" className="mt-4">
          <div className="text-sm text-accent">{t('overlays.scaleDisplayFormula', { scale: String(scaleNum), offset: String(Number(offsetEng)) })}</div>
          <div className="text-sm text-accent">{t('overlays.scaleWriteFormula', { offset: String(Number(offsetEng)), scale: String(scaleNum) })}</div>
          <div className="text-xs text-ink2 mt-1">{conv && conv.ok ? t('overlays.scaleConvOk', { value: String(conv.value), type: rawType }) : t('overlays.scaleConvFail', { reason: conv && !conv.ok ? conv.reason : '' })}</div>
        </InfoBand>
      ) : null}
      <div className="mt-5 text-xs text-ink2 mb-1.5">{t('overlays.advancedMapping')}</div>
      <InfoBand className="flex flex-wrap items-center gap-3 text-xs">
        <span>{t('overlays.wordOrder')}</span>
        <Select value={wordOrder} onChange={(v) => setWordOrder(v as typeof wordOrder)} options={['ABCD', 'CDAB', 'BADC', 'DCBA'].map((w) => ({ value: w, label: w }))} />
        <span>{t('overlays.encoding')}</span>
        <Select value={encoding} onChange={(v) => setEncoding(v as typeof encoding)} options={[{ value: 'ascii', label: 'ASCII' }, { value: 'utf8', label: 'UTF-8' }]} />
        <span>{t('overlays.stringLength')}</span>
        <TextInput className="w-20" type="number" value={strLen} onChange={(e) => setStrLen(e.target.value)} disabled={rawType !== 'String'} />
      </InfoBand>
      <div className="mt-3">
        <Field label={t('overlays.enumTable')}><TextInput value={enumText} onChange={(e) => setEnumText(e.target.value)} /></Field>
      </div>
      <div className="mt-5 text-xs text-ink2 mb-1.5">{t('overlays.mappingPreview')}</div>
      <InfoBand>
        <div className="text-sm font-bold">{t('overlays.regOffsetPrefix', { offset: String(mapping.offset) })}{rawType === 'BitField' || rawType === 'Bool' ? ` · bits ${mapping.bitOffset}..${mapping.bitOffset + mapping.bitWidth - 1}` : ''} → {name}</div>
        <div className="text-xs text-ink2 mt-1">{shared.length ? t('overlays.sharedRegisters', { names: shared.map((s) => s.name).join(' / ') }) : t('overlays.exclusiveRegister')}</div>
      </InfoBand>
      <div className="mt-4">
        <Checkbox checked={highRisk} onCheckedChange={setHighRisk} label={t('overlays.highRiskConfirm')} />
      </div>
    </Drawer>
  );
}

function InspectorDrawer(props: { pointId: string }) {
  const { t } = useTranslation();
  const workspace = useWorkspace();
  const blockStates = useBlocks();
  const points = usePoints();
  const close = useApp((s) => s.closeOverlay);
  const select = useApp((s) => s.select);
  const setModule = useApp((s) => s.setModule);
  const point = workspace?.templates.flatMap((t) => t.points).find((p) => p.id === props.pointId);
  const block = workspace?.templates.flatMap((t) => t.blocks).find((b) => b.id === point?.blockId);
  const entry = block ? Object.values(blockStates).find((b) => b.blockId === block.id) : undefined;
  const view = points[props.pointId];
  if (!workspace || !point || !block || !entry) return null;
  const regs = Array.from({ length: Math.min(4, block.length) }, () => 0);
  void regs;
  return (
    <Drawer title={t('overlays.inspectorTitle')} subtitle={t('overlays.inspectorSubtitle', { point: point.name, type: point.mapping.rawType, offset: String(point.mapping.offset) })} width={500} onClose={close}
      footer={<Button onClick={() => { close(); select({ commView: 'messages' }); setModule('comm'); }}>{t('overlays.viewRecentComm')}</Button>}>
      <InfoBand tone="blue" className="flex items-center justify-between">
        <div>
          <div className="text-xs text-ink2 mb-1">{t('overlays.engValue')}</div>
          <div className="text-2xl font-bold text-accent">{view?.engText ?? '—'} {point.unit}</div>
        </div>
        <div className="text-xs text-ink2">{t('overlays.inspectorSource', { block: block.name, addr: String(block.start + point.mapping.offset) })}</div>
      </InfoBand>
      <div className="mt-5 text-sm font-bold mb-2">{t('overlays.rawRegisters')}</div>
      <InfoBand>
        <div className="grid grid-cols-2 gap-4">
          {[0, 1].map((i) => (
            <div key={i}>
              <div className="text-xs text-ink2">+{point.mapping.offset + i}</div>
              <div className="mono text-lg font-bold mt-1">0x0000</div>
            </div>
          ))}
        </div>
        <div className="text-xs text-ink2 mt-2 mono">{t('overlays.bytesFromCache')}</div>
      </InfoBand>
      <div className="mt-5 text-sm font-bold mb-2">{t('overlays.dataInterpretation')}</div>
      <div className="rounded-card border border-line bg-surface px-4">
        {(['Float32 · ABCD', 'Float32 · BADC', 'Float32 · CDAB', 'Float32 · DCBA', 'UInt32 · ABCD'] as const).map((label, i) => (
          <div key={label} className="flex justify-between border-b border-[#E7EAEE] py-2 text-xs last:border-0">
            <span className={i === 0 ? 'text-accent' : ''}>{label}</span>
            <span className={i === 0 ? 'text-accent mono' : 'mono'}>{i === 0 ? view?.engText ?? '—' : '—'}</span>
          </div>
        ))}
      </div>
      <div className="mt-5 text-sm font-bold mb-2">{t('overlays.conversionRules')}</div>
      <InfoBand>
        <div className="text-sm">{t('overlays.scaleDisplayFormula', { scale: String(point.scale), offset: String(point.offset) })}</div>
        <div className="text-sm">{t('overlays.scaleWriteFormula', { offset: String(point.offset), scale: String(point.scale) })}</div>
        <div className="text-xs text-ink2 mt-1">{t('overlays.currentExample', { eng: view?.engText ?? '—', unit: point.unit, raw: view?.rawText ?? '—', type: point.mapping.rawType })}</div>
      </InfoBand>
    </Drawer>
  );
}
function pointOwner(ws: import('../../domain/model').Workspace, pointId: string): { slaveId: string; connectionId: string } | null {
  for (const slave of ws.slaves) {
    const template = ws.templates.find((t) => t.id === slave.templateId);
    if (template?.points.some((p) => p.id === pointId)) return { slaveId: slave.id, connectionId: slave.connectionId };
  }
  return null;
}

function AddSignalDialog(props: { groupId: string }) {
  const { t } = useTranslation();
  const workspace = useWorkspace();
  const command = useApp((s) => s.command);
  const close = useApp((s) => s.closeOverlay);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState('');
  const group = workspace?.trendGroups.find((g) => g.id === props.groupId);
  const inGroup = new Set(group?.signals.map((s) => s.pointRef.pointId) ?? []);
  const pickedIds = Object.keys(picked).filter((k) => picked[k]);
  if (!workspace || !group) return null;
  const add = async () => {
    const signals = pickedIds.map((pointId) => {
      const owner = pointOwner(workspace, pointId);
      return { id: uid('sig'), pointRef: { connectionId: owner?.connectionId ?? '', slaveId: owner?.slaveId ?? '', pointId }, visible: true };
    });
    await command({ type: 'workspace.apply', workspace: { ...workspace, trendGroups: workspace.trendGroups.map((g) => (g.id === group.id ? { ...g, signals: [...g.signals, ...signals] } : g)) } });
    close();
  };
  return (
    <Dialog title={t('overlays.addSignalTitle')} subtitle={t('overlays.addSignalSubtitle', { group: group.name })} width={820} onClose={close} footer={<><Button onClick={close}>{t('overlays.cancel')}</Button><Button variant="primary" disabled={!pickedIds.length} onClick={() => void add()}>{t('overlays.addSignal')}</Button></>}>
      <TextInput placeholder={t('overlays.searchPoints')} value={search} onChange={(e) => setSearch(e.target.value)} />
      <div className="mt-4 grid grid-cols-3 gap-5">
        <div className="col-span-2 rounded-card border border-line bg-surface p-4 max-h-[420px] overflow-y-auto">
          <div className="text-xs text-ink2 mb-2">{t('overlays.devicesAndPoints')}</div>
          {workspace.connections.map((c) => (
            <div key={c.id} className="mb-3">
              <div className="text-sm font-medium mb-1">▼ {c.name}</div>
              {workspace.slaves.filter((s) => s.connectionId === c.id).map((s) => {
                const template = workspace.templates.find((t) => t.id === s.templateId);
                return (
                  <div key={s.id} className="ml-4 mb-2">
                    <div className="text-sm mb-1">▼ {s.name} · {t('overlays.slaveUnit', { unit: String(s.unitId) })}</div>
                    {template?.blocks.map((b) => (
                      <div key={b.id} className="ml-4 mb-1">
                        <div className="text-xs text-accent mb-1">▼ {b.name}</div>
                        {template.points.filter((p) => p.blockId === b.id && (!search || p.name.includes(search))).map((p) => (
                          <div key={p.id} className="ml-4 flex items-center gap-2 py-0.5">
                            <Checkbox checked={!!picked[p.id]} disabled={inGroup.has(p.id)} onCheckedChange={(v) => setPicked({ ...picked, [p.id]: v })} />
                            <span className="text-sm">{p.name}</span>
                            {inGroup.has(p.id) ? <span className="text-xs text-ink2">{t('overlays.inGroup')}</span> : null}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="rounded-card bg-surface2 p-4">
          <div className="text-xs text-ink2">{t('overlays.newThisTime')}</div>
          <div className="text-2xl font-bold mt-1">{t('overlays.signalCount', { n: String(pickedIds.length) })}</div>
          <div className="text-xs text-ink2 mt-1">{t('overlays.selectionHint')}</div>
          <div className="mt-5 text-xs text-ink2 mb-1.5">{t('overlays.afterAdd')}</div>
          <ul className="text-xs text-ink2 list-disc pl-4 space-y-1">
            <li>{t('overlays.afterAdd1')}</li>
            <li>{t('overlays.afterAdd2')}</li>
            <li>{t('overlays.afterAdd3')}</li>
            <li>{t('overlays.afterAdd4')}</li>
          </ul>
          <div className="mt-5 text-xs text-ink2 mb-1.5">{t('overlays.tips')}</div>
          <div className="text-xs text-ink2">{t('overlays.stringTip')}</div>
        </div>
      </div>
    </Dialog>
  );
}

function NewTrendGroupDialog() {
  const { t } = useTranslation();
  const workspace = useWorkspace();
  const command = useApp((s) => s.command);
  const close = useApp((s) => s.closeOverlay);
  const select = useApp((s) => s.select);
  const openOverlay = useApp((s) => s.openOverlay);
  const [name, setName] = useState<string>(t('overlays.defaultGroupName'));
  const [windowSec, setWindowSec] = useState('60');
  const [desc, setDesc] = useState('');
  const create = async () => {
    if (!workspace) return;
    const id = uid('g');
    await command({ type: 'workspace.apply', workspace: { ...workspace, trendGroups: [...workspace.trendGroups, { id, name, windowSec: Number(windowSec), description: desc, signals: [] }] } });
    select({ groupId: id });
    close();
    openOverlay({ kind: 'dialog', id: 'add-signal', groupId: id });
  };
  return (
    <Dialog title={t('overlays.newGroupTitle')} subtitle={t('overlays.newGroupSubtitle')} width={640} onClose={close} footer={<><Button onClick={close}>{t('overlays.cancel')}</Button><Button variant="primary" onClick={() => void create()}>{t('overlays.createGroup')}</Button></>}>
      <Field label={t('overlays.name')}><TextInput value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="mt-4 grid grid-cols-2 gap-4">
        <Field label={t('overlays.defaultWindow')}><Select value={windowSec} onChange={setWindowSec} options={[{ value: '30', label: t('overlays.window30') }, { value: '60', label: t('overlays.window60') }, { value: '300', label: t('overlays.window300') }]} /></Field>
        <Field label={t('overlays.description')}><TextInput value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={t('overlays.optionalPlaceholder')} /></Field>
      </div>
      <InfoBand tone="blue" className="mt-5">
        <div className="text-sm font-bold text-accent mb-1">{t('overlays.afterCreate')}</div>
        <div className="flex gap-8 text-sm"><span>{t('overlays.afterCreateOpen')}</span><span>{t('overlays.afterCreateAdd')}</span></div>
      </InfoBand>
    </Dialog>
  );
}

function SaveAsBlockDialog(props: { connectionId: string; unitId: number; area: 1 | 2 | 3 | 4; start: number; quantity: number; registers: number[] }) {
  const { t } = useTranslation();
  const workspace = useWorkspace();
  const command = useApp((s) => s.command);
  const close = useApp((s) => s.closeOverlay);
  const [templateId, setTemplateId] = useState(workspace?.templates[0]?.id ?? '');
  const [name, setName] = useState<string>(t('overlays.defaultTempBlockName'));
  const [period, setPeriod] = useState('500');
  const [newTemplateOpen, setNewTemplateOpen] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState<string>(t('overlays.defaultNewTemplateName'));
  const [newTemplateDesc, setNewTemplateDesc] = useState<string>(t('overlays.defaultNewTemplateDesc'));
  const template = workspace?.templates.find((t) => t.id === templateId);
  const candidate: BlockDef = { id: 'new', name, area: props.area, start: props.start, length: props.quantity, periodMs: Number(period) };
  const overlap = template ? findBlockOverlaps([...template.blocks, candidate]).length > 0 : false;

  const save = async () => {
    if (!workspace || !template) return;
    const block: BlockDef = { ...candidate, id: uid('blk') };
    await command({ type: 'workspace.apply', workspace: { ...workspace, templates: workspace.templates.map((t) => (t.id === template.id ? { ...t, blocks: [...t.blocks, block] } : t)) } });
    close();
  };

  return (
    <>
      <Dialog title={t('overlays.saveAsBlockTitle')} subtitle={t('overlays.saveAsBlockSubtitle')} width={720} onClose={close} footer={<><Button onClick={close}>{t('overlays.cancel')}</Button><Button variant="primary" disabled={overlap} onClick={() => void save()}>{t('overlays.saveBlock')}</Button></>}>
        <Field label={t('overlays.targetTemplate')}>
          <Select value={templateId} onChange={setTemplateId} options={[{ value: '', label: t('overlays.noTemplateOption') }, ...(workspace?.templates.map((t) => ({ value: t.id, label: t.name })) ?? [])]} />
        </Field>
        <div className="mt-2 -mt-1 mb-3 rounded-ctl border border-line bg-surface px-3 py-2 text-sm">
          {workspace?.templates.map((t) => (t.id === templateId ? <span key={t.id} className="text-accent">✓ {t.name}</span> : <span key={t.id} className="block text-ink2">{t.name}</span>))}
          <button className="focus-ring mt-1 cursor-pointer text-xs text-accent hover:underline" onClick={() => setNewTemplateOpen(true)}>{t('overlays.newTemplateEllipsis')}</button>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label={t('overlays.blockName')}><TextInput value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label={t('overlays.pollPeriod')}><Select value={period} onChange={setPeriod} options={['100', '200', '500', '1000'].map((p) => ({ value: p, label: `${p} ms` }))} /></Field>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-4">
          <Field label={t('overlays.area')}><TextInput readOnly value={AREAS[props.area]} /></Field>
          <Field label={t('overlays.startAddr')}><TextInput readOnly value={String(props.start)} /></Field>
          <Field label={t('overlays.length')}><TextInput readOnly value={String(props.quantity)} /></Field>
        </div>
        <InfoBand tone="blue" className={`mt-5 ${overlap ? 'bg-[#FDECEA]' : ''}`}>
          <div className={`text-sm ${overlap ? 'text-err' : 'text-ok'}`}>{overlap ? t('overlays.overlapExisting') : t('overlays.noOverlapRange', { area: props.area === 3 ? 'Holding' : props.area === 4 ? 'Input' : props.area === 2 ? 'Discrete' : 'Coil', start: String(props.start), end: String(props.start + props.quantity - 1) })}</div>
        </InfoBand>
      </Dialog>
      {newTemplateOpen ? (
        <Dialog title={t('overlays.newTemplateTitle')} width={520} onClose={() => setNewTemplateOpen(false)} footer={<><Button onClick={() => setNewTemplateOpen(false)}>{t('overlays.cancel')}</Button><Button variant="primary" onClick={async () => {
          if (!workspace) return;
          const id = uid('tpl');
          await command({ type: 'workspace.apply', workspace: { ...workspace, templates: [...workspace.templates, { id, name: newTemplateName, version: '1.0', description: newTemplateDesc, blocks: [], points: [] }] } });
          setTemplateId(id);
          setNewTemplateOpen(false);
        }}>{t('overlays.createAndSelect')}</Button></>}>
          <Field label={t('overlays.name')}><TextInput value={newTemplateName} onChange={(e) => setNewTemplateName(e.target.value)} /></Field>
          <div className="mt-4">
            <Field label={t('overlays.nameOptional')}><TextInput value={newTemplateDesc} onChange={(e) => setNewTemplateDesc(e.target.value)} /></Field>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

function ConfirmDialog(props: { title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void }) {
  const { t } = useTranslation();
  const close = useApp((s) => s.closeOverlay);
  return (
    <Dialog title={props.title} width={460} onClose={close} footer={<><Button onClick={close}>{t('overlays.cancel')}</Button><Button variant={props.danger ? 'danger' : 'primary'} onClick={() => { props.onConfirm(); close(); }}>{props.confirmLabel}</Button></>}>
      <div className="text-sm pb-4">{props.message}</div>
    </Dialog>
  );
}