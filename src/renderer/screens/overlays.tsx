import React, { useEffect, useRef, useState } from 'react';
import { useApp, useBlocks, usePoints, useWorkspace } from '../store/app';
import { Button, Checkbox, ComboInput, Dialog, Drawer, Field, InfoBand, Select, TextInput } from '../components/ui';
import { AREAS } from '../../domain/address';
import { BAUD_PRESETS } from './devices';
import { findBlockOverlaps } from '../../domain/overlap';
import { registersForType, type RawType } from '../../domain/mapping';
import { engineeringToRaw } from '../../domain/scale';
import type { BlockDef, PointDef } from '../../domain/model';

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
  const workspace = useWorkspace();
  const existingConn = workspace?.connections.find((c) => c.id === props.connectionId);
  const command = useApp((s) => s.command);
  const close = useApp((s) => s.closeOverlay);
  const toast = useApp((s) => s.toast);
  const [name, setName] = useState(existingConn?.name ?? '生产线 RS485');
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
    toast({ kind: 'success', title: existingConn ? '连接已更新' : '连接已创建', message: existingConn ? '参数已应用到运行时。' : '可继续添加从站。' });
    close();
  };

  return (
    <Dialog title={existingConn ? '编辑连接' : '添加连接'} subtitle="配置 RTU / TCP 通信参数。" width={660} onClose={close} footer={<><Button onClick={close}>取消</Button><Button variant="primary" onClick={() => void create()}>{existingConn ? '保存修改' : '创建连接'}</Button></>}>
      <Field label="连接名称"><TextInput value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="mt-4">
        <div className="text-xs text-ink2 mb-1.5">协议</div>
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
            <Field label="串口" hint="打开下拉时重新枚举当前可用串口，也可直接输入">
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
            <Field label="波特率" hint="支持自定义波特率输入">
              <ComboInput testId="baud-combo" value={baud} onChange={(v) => setBaud(v)} options={BAUD_PRESETS} />
            </Field>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-4">
            <Field label="数据位"><Select value={dataBits} onChange={setDataBits} options={[{ value: '8', label: '8' }, { value: '7', label: '7' }]} /></Field>
            <Field label="校验"><Select value={parity} onChange={(v) => setParity(v as typeof parity)} options={[{ value: 'none', label: 'None' }, { value: 'even', label: 'Even' }, { value: 'odd', label: 'Odd' }]} /></Field>
            <Field label="停止位"><Select value={stopBits} onChange={setStopBits} options={[{ value: '1', label: '1' }, { value: '2', label: '2' }]} /></Field>
          </div>
        </>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-4">
          <Field label="主机"><TextInput value={host} onChange={(e) => setHost(e.target.value)} /></Field>
          <Field label="端口"><TextInput value={tcpPort} onChange={(e) => setTcpPort(e.target.value)} /></Field>
        </div>
      )}
      <div className="mt-4 grid grid-cols-3 gap-4">
        <Field label="超时"><TextInput data-testid="timeout-input" value={timeout} onChange={(e) => setTimeoutMs(e.target.value)} /></Field>
        <Field label="重试"><TextInput value={retries} onChange={(e) => setRetries(e.target.value)} /></Field>
        <Field label="重连策略"><Select value={reconnect} onChange={(v) => setReconnect(v as typeof reconnect)} options={[{ value: 'auto', label: '自动重连' }, { value: 'manual', label: '手动' }]} /></Field>
      </div>
      <InfoBand tone="blue" className="mt-5">
        <div className="text-sm font-bold text-accent mb-1">创建后</div>
        <div className="text-sm">创建连接后可继续添加从站。</div>
      </InfoBand>
      <div className="mt-5 grid grid-cols-3 gap-4">
        <Field label="帧间隔 (ms)"><TextInput type="number" value={interFrame} onChange={(e) => setInterFrame(e.target.value)} /></Field>
        <Field label="RTS 控制"><Select value={rts} onChange={(v) => setRts(v as 'none' | 'toggle')} options={[{ value: 'none', label: 'None' }, { value: 'toggle', label: 'Toggle' }]} /></Field>
        <Field label="日志级别"><Select value={logLevel} onChange={(v) => setLogLevel(v as 'info' | 'debug')} options={[{ value: 'info', label: 'Info' }, { value: 'debug', label: 'Debug' }]} /></Field>
      </div>
    </Dialog>
  );
}
function AddSlaveDialog(props: { connectionId: string; slaveId?: string }) {
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
  const [name, setName] = useState(existing?.name ?? ('从站 ' + String(nextUnit)));
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
    <Dialog title={existing ? '编辑从站' : '添加从站'} subtitle={conn?.name ?? ''} width={660} onClose={close} footer={<><Button onClick={close}>取消</Button><Button variant="primary" disabled={conflict} onClick={() => void save()}>{existing ? '保存从站' : '添加从站'}</Button></>}>
      <Field label="所属连接"><TextInput readOnly value={`${conn?.name ?? ''} · ${conn?.transport === 'rtu' ? `${conn.rtu?.baudRate} ${conn.rtu?.dataBits}${conn.rtu?.parity.charAt(0).toUpperCase()}${conn.rtu?.stopBits}` : conn?.tcp?.host}`} /></Field>
      <div className="mt-4 grid grid-cols-2 gap-4">
        <Field label="设备名称"><TextInput value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="从站地址 (Unit ID)"><TextInput type="number" value={unit} onChange={(e) => setUnit(e.target.value)} /></Field>
      </div>
      <div className="mt-4">
        <div className="text-xs text-ink2 mb-1.5">设备模板</div>
        <Select value={templateId} onChange={setTemplateId} options={[{ value: '', label: '（暂不绑定模板）' }, ...(workspace?.templates.map((t) => ({ value: t.id, label: t.name })) ?? [])]} />
      </div>
      {templateId === '' ? (
        <InfoBand tone="blue" className="mt-3">未绑定模板：从站创建后不会轮询，可在之后编辑从站时绑定或新建模板。</InfoBand>
      ) : template ? (
        <div className="mt-3 rounded-card bg-surface2 p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-bold">{template.name}</span>
            <span className="flex gap-4 text-xs text-accent">
              <button className="focus-ring cursor-pointer hover:underline" onClick={() => { select({ templateId: template.id }); setModule('templates'); close(); }}>查看模板</button>
              <button className="focus-ring cursor-pointer hover:underline" onClick={async () => {
                if (!workspace) return;
                const copy = { ...template, id: uid('tpl'), name: `${template.name} 副本` };
                await command({ type: 'workspace.apply', workspace: { ...workspace, templates: [...workspace.templates, copy] } });
                setTemplateId(copy.id);
              }}>复制为新模板</button>
            </span>
          </div>
          <div className="text-xs text-ink2 mt-1">{template.blocks.length} 个数据块 · {template.points.length} 个点位 · 已被 {workspace?.slaves.filter((s) => s.templateId === template.id).length} 个从站使用</div>
          <div className="text-xs text-ink2 mt-1">{template.blocks.map((b) => b.name).join(' · ')}</div>
          <div className="text-xs text-ink2 mt-2">模板修改会同步影响所有绑定从站。</div>
        </div>
      ) : null}
      <div className="mt-4 grid grid-cols-2 gap-6">
        <div>
          <div className="text-xs text-ink2 mb-1.5">实例选项</div>
          <Checkbox checked={enabled} onCheckedChange={setEnabled} label="启用从站" />
        </div>
        <div>
          <div className="text-xs text-ink2 mb-1.5">地址冲突检查</div>
          <div className={`rounded-ctl border px-3 py-2 text-xs ${conflict ? 'border-err text-err' : 'border-line text-ok'}`}>{conflict ? `Unit ID ${unit} 已被占用` : `✓ Unit ID ${unit} 可用`}</div>
        </div>
      </div>
      <InfoBand tone="blue" className="mt-4">设备寄存器定义不同？复制模板后再绑定。</InfoBand>
    </Dialog>
  );
}

function EditBlockDialog(props: { templateId: string; blockId?: string }) {
  const workspace = useWorkspace();
  const command = useApp((s) => s.command);
  const close = useApp((s) => s.closeOverlay);
  const template = workspace?.templates.find((t) => t.id === props.templateId);
  const existing = template?.blocks.find((b) => b.id === props.blockId);
  const [name, setName] = useState(existing?.name ?? '控制寄存器');
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
    <Dialog title={existing ? '编辑数据块' : '新建数据块'} subtitle="地址按 Modbus 0-based 填写。" width={620} onClose={close} footer={<><Button onClick={close}>取消</Button><Button variant="primary" disabled={bad} onClick={() => void save()}>保存数据块</Button></>}>
      <Field label="名称"><TextInput value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="mt-4">
        <Field label="地址区">
          <Select value={area} onChange={setArea} options={[1, 2, 3, 4].map((a) => ({ value: String(a), label: AREAS[a as 1 | 2 | 3 | 4] ?? String(a) }))} />
        </Field>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-4">
        <Field label="起始地址"><TextInput type="number" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
        <Field label="长度"><TextInput type="number" value={length} onChange={(e) => setLength(e.target.value)} /></Field>
        <Field label="默认轮询周期"><Select value={period} onChange={setPeriod} options={['50', '100', '200', '500', '1000'].map((p) => ({ value: p, label: `${p} ms` }))} /></Field>
      </div>
      <div className="mt-4">
        <div className="text-xs text-ink2 mb-1.5">计算范围</div>
        <InfoBand className="flex items-center justify-between"><span className="text-sm font-bold mono">{candidate.start}–{candidate.start + candidate.length - 1}</span><span className="text-xs text-ink2">{candidate.length} 个寄存器</span></InfoBand>
      </div>
      <div className="mt-4">
        <div className="text-xs text-ink2 mb-1.5">范围校验</div>
        <InfoBand className={bad ? 'bg-[#FDECEA]' : 'bg-accentsoft'}>
          <div className={`text-sm ${bad ? 'text-err' : 'text-ok'}`}>{bad ? `✕ 与同地址区数据块重叠：${overlaps.map((o) => (o.blockA === name ? o.blockB : o.blockA)).join('、')}` : '✓ 与同地址区其他数据块不重叠'}</div>
          {others.filter((o) => o.area === candidate.area).map((o) => (
            <div key={o.id} className="text-xs text-ink2 mt-1">{o.name}：{o.start}–{o.start + o.length - 1}</div>
          ))}
        </InfoBand>
      </div>
    </Dialog>
  );
}

function EditPointDrawer(props: { templateId: string; blockId: string; pointId?: string }) {
  const workspace = useWorkspace();
  const command = useApp((s) => s.command);
  const close = useApp((s) => s.closeOverlay);
  const template = workspace?.templates.find((t) => t.id === props.templateId);
  const block = template?.blocks.find((b) => b.id === props.blockId);
  const existing = template?.points.find((p) => p.id === props.pointId);
  const [name, setName] = useState(existing?.name ?? '模式');
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
      title="编辑点位"
      subtitle={existing ? '配置数值点位的映射、单位、缩放与写入转换。' : '配置点位在当前数据块中的偏移、数据类型与显示方式。'}
      width={590}
      onClose={close}
      footer={<><Button onClick={close}>取消</Button><Button variant="primary" onClick={() => void save()}>保存点位</Button></>}
    >
      <div className="text-xs text-ink2 mb-1.5">基本设置</div>
      <Field label="名称"><TextInput value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="mt-5 text-xs text-ink2 mb-1.5">内存映射</div>
      <div className="grid grid-cols-3 gap-4">
        <Field label="寄存器偏移"><TextInput type="number" value={offset} onChange={(e) => setOffset(e.target.value)} /></Field>
        <Field label="数据类型"><Select value={rawType} onChange={(v) => setRawType(v as RawType)} options={['Bool', 'BitField', 'Int8', 'UInt8', 'Int16', 'UInt16', 'Int32', 'UInt32', 'Float32', 'Float64', 'String'].map((t) => ({ value: t, label: t }))} /></Field>
        <Field label="寄存器数量"><TextInput type="number" value={String(mapping.registerCount)} readOnly /></Field>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-4">
        <Field label="位偏移"><TextInput type="number" value={bitOffset} onChange={(e) => setBitOffset(e.target.value)} disabled={rawType !== 'BitField' && rawType !== 'Bool'} /></Field>
        <Field label="位宽"><TextInput type="number" value={bitWidth} onChange={(e) => setBitWidth(e.target.value)} disabled={rawType !== 'BitField'} /></Field>
        <Field label="访问权限"><Select value={access} onChange={(v) => setAccess(v as 'ro' | 'rw')} options={[{ value: 'ro', label: '只读' }, { value: 'rw', label: '读 / 写' }]} disabled={block.area === 2 || block.area === 4} /></Field>
      </div>
      <div className="mt-5 text-xs text-ink2 mb-1.5">显示与转换</div>
      <div className="grid grid-cols-3 gap-4">
        <Field label="格式"><Select value={format} onChange={(v) => setFormat(v as typeof format)} options={[{ value: 'auto', label: '十进制' }, { value: 'hex', label: '十六进制' }, { value: 'binary', label: '二进制' }]} /></Field>
        <Field label="单位"><TextInput value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="—" /></Field>
        <Field label="缩放 / 偏移"><TextInput readOnly value={showScale ? '可配置' : '不适用'} /></Field>
      </div>
      {showScale ? (
        <div className="mt-4 grid grid-cols-2 gap-4">
          <Field label="缩放因子"><TextInput value={scale} onChange={(e) => setScale(e.target.value)} /></Field>
          <Field label="偏移量"><TextInput value={offsetEng} onChange={(e) => setOffsetEng(e.target.value)} /></Field>
        </div>
      ) : null}
      {showScale ? (
        <InfoBand tone="blue" className="mt-4">
          <div className="text-sm text-accent">显示：工程值 = Raw × {scaleNum} + {Number(offsetEng)}</div>
          <div className="text-sm text-accent">写入：Raw = (工程值 − {Number(offsetEng)}) / {scaleNum}</div>
          <div className="text-xs text-ink2 mt-1">{conv && conv.ok ? `1500 → Raw ${conv.value} · ${rawType} 范围校验后写入` : `校验失败：${conv && !conv.ok ? conv.reason : ''}`}</div>
        </InfoBand>
      ) : null}
      <div className="mt-5 text-xs text-ink2 mb-1.5">高级映射</div>
      <InfoBand className="flex flex-wrap items-center gap-3 text-xs">
        <span>字节序</span>
        <Select value={wordOrder} onChange={(v) => setWordOrder(v as typeof wordOrder)} options={['ABCD', 'CDAB', 'BADC', 'DCBA'].map((w) => ({ value: w, label: w }))} />
        <span>编码</span>
        <Select value={encoding} onChange={(v) => setEncoding(v as typeof encoding)} options={[{ value: 'ascii', label: 'ASCII' }, { value: 'utf8', label: 'UTF-8' }]} />
        <span>字符串长度</span>
        <TextInput className="w-20" type="number" value={strLen} onChange={(e) => setStrLen(e.target.value)} disabled={rawType !== 'String'} />
      </InfoBand>
      <div className="mt-3">
        <Field label="枚举表（0=位置, 1=速度）"><TextInput value={enumText} onChange={(e) => setEnumText(e.target.value)} /></Field>
      </div>
      <div className="mt-5 text-xs text-ink2 mb-1.5">映射预览</div>
      <InfoBand>
        <div className="text-sm font-bold">寄存器 +{mapping.offset}{rawType === 'BitField' || rawType === 'Bool' ? ` · bits ${mapping.bitOffset}..${mapping.bitOffset + mapping.bitWidth - 1}` : ''} → {name}</div>
        <div className="text-xs text-ink2 mt-1">{shared.length ? `与“${shared.map((s) => s.name).join(' / ')}”共享寄存器。` : '独占寄存器。'}</div>
      </InfoBand>
      <div className="mt-4">
        <Checkbox checked={highRisk} onCheckedChange={setHighRisk} label="写入时要求二次确认（适合复位、清故障等高风险点）" />
      </div>
    </Drawer>
  );
}

function InspectorDrawer(props: { pointId: string }) {
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
    <Drawer title="原始数据检查器" subtitle={`${point.name} · ${point.mapping.rawType} · +${point.mapping.offset}`} width={500} onClose={close}
      footer={<Button onClick={() => { close(); select({ commView: 'messages' }); setModule('comm'); }}>查看最近通信</Button>}>
      <InfoBand tone="blue" className="flex items-center justify-between">
        <div>
          <div className="text-xs text-ink2 mb-1">工程值</div>
          <div className="text-2xl font-bold text-accent">{view?.engText ?? '—'} {point.unit}</div>
        </div>
        <div className="text-xs text-ink2">来源：{block.name} / 地址 {block.start + point.mapping.offset}</div>
      </InfoBand>
      <div className="mt-5 text-sm font-bold mb-2">原始寄存器</div>
      <InfoBand>
        <div className="grid grid-cols-2 gap-4">
          {[0, 1].map((i) => (
            <div key={i}>
              <div className="text-xs text-ink2">+{point.mapping.offset + i}</div>
              <div className="mono text-lg font-bold mt-1">0x0000</div>
            </div>
          ))}
        </div>
        <div className="text-xs text-ink2 mt-2 mono">字节：00 00 00 00（来自 Block Cache，不额外请求设备）</div>
      </InfoBand>
      <div className="mt-5 text-sm font-bold mb-2">数据解释</div>
      <div className="rounded-card border border-line bg-surface px-4">
        {(['Float32 · ABCD', 'Float32 · BADC', 'Float32 · CDAB', 'Float32 · DCBA', 'UInt32 · ABCD'] as const).map((label, i) => (
          <div key={label} className="flex justify-between border-b border-[#E7EAEE] py-2 text-xs last:border-0">
            <span className={i === 0 ? 'text-accent' : ''}>{label}</span>
            <span className={i === 0 ? 'text-accent mono' : 'mono'}>{i === 0 ? view?.engText ?? '—' : '—'}</span>
          </div>
        ))}
      </div>
      <div className="mt-5 text-sm font-bold mb-2">转换规则</div>
      <InfoBand>
        <div className="text-sm">显示：工程值 = Raw × {point.scale} + {point.offset}</div>
        <div className="text-sm">写入：Raw = (工程值 − {point.offset}) / {point.scale}</div>
        <div className="text-xs text-ink2 mt-1">当前示例：{view?.engText ?? '—'} {point.unit} ↔ Raw {view?.rawText ?? '—'}（{point.mapping.rawType}）</div>
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
    <Dialog title="添加趋势信号" subtitle={`从设备实例中选择点位，加入趋势组「${group.name}」。已在组内的信号不可重复添加。`} width={820} onClose={close} footer={<><Button onClick={close}>取消</Button><Button variant="primary" disabled={!pickedIds.length} onClick={() => void add()}>添加信号</Button></>}>
      <TextInput placeholder="搜索点位、设备或数据块" value={search} onChange={(e) => setSearch(e.target.value)} />
      <div className="mt-4 grid grid-cols-3 gap-5">
        <div className="col-span-2 rounded-card border border-line bg-surface p-4 max-h-[420px] overflow-y-auto">
          <div className="text-xs text-ink2 mb-2">设备与点位</div>
          {workspace.connections.map((c) => (
            <div key={c.id} className="mb-3">
              <div className="text-sm font-medium mb-1">▼ {c.name}</div>
              {workspace.slaves.filter((s) => s.connectionId === c.id).map((s) => {
                const template = workspace.templates.find((t) => t.id === s.templateId);
                return (
                  <div key={s.id} className="ml-4 mb-2">
                    <div className="text-sm mb-1">▼ {s.name} · 从站 {s.unitId}</div>
                    {template?.blocks.map((b) => (
                      <div key={b.id} className="ml-4 mb-1">
                        <div className="text-xs text-accent mb-1">▼ {b.name}</div>
                        {template.points.filter((p) => p.blockId === b.id && (!search || p.name.includes(search))).map((p) => (
                          <div key={p.id} className="ml-4 flex items-center gap-2 py-0.5">
                            <Checkbox checked={!!picked[p.id]} disabled={inGroup.has(p.id)} onCheckedChange={(v) => setPicked({ ...picked, [p.id]: v })} />
                            <span className="text-sm">{p.name}</span>
                            {inGroup.has(p.id) ? <span className="text-xs text-ink2">已在组内</span> : null}
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
          <div className="text-xs text-ink2">本次新增</div>
          <div className="text-2xl font-bold mt-1">{pickedIds.length} 个信号</div>
          <div className="text-xs text-ink2 mt-1">选择后会显示在这里</div>
          <div className="mt-5 text-xs text-ink2 mb-1.5">加入后</div>
          <ul className="text-xs text-ink2 list-disc pl-4 space-y-1">
            <li>加入后立即显示后台刷新值</li>
            <li>默认在图表中显示</li>
            <li>可在信号页修改显示 / 隐藏</li>
            <li>记录开始时同步写入历史</li>
          </ul>
          <div className="mt-5 text-xs text-ink2 mb-1.5">提示</div>
          <div className="text-xs text-ink2">String 可加入组并记录变化，但不绘制连续折线。</div>
        </div>
      </div>
    </Dialog>
  );
}

function NewTrendGroupDialog() {
  const workspace = useWorkspace();
  const command = useApp((s) => s.command);
  const close = useApp((s) => s.closeOverlay);
  const select = useApp((s) => s.select);
  const openOverlay = useApp((s) => s.openOverlay);
  const [name, setName] = useState('功耗分析');
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
    <Dialog title="新建趋势组" subtitle="设置趋势组名称与默认时间窗口。" width={640} onClose={close} footer={<><Button onClick={close}>取消</Button><Button variant="primary" onClick={() => void create()}>创建趋势组</Button></>}>
      <Field label="名称"><TextInput value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="mt-4 grid grid-cols-2 gap-4">
        <Field label="默认时间窗口"><Select value={windowSec} onChange={setWindowSec} options={[{ value: '30', label: '最近 30 秒' }, { value: '60', label: '最近 60 秒' }, { value: '300', label: '最近 5 分钟' }]} /></Field>
        <Field label="说明"><TextInput value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="可选" /></Field>
      </div>
      <InfoBand tone="blue" className="mt-5">
        <div className="text-sm font-bold text-accent mb-1">创建后</div>
        <div className="flex gap-8 text-sm"><span>✓ 打开趋势组</span><span>✓ 立即进入“添加信号”</span></div>
      </InfoBand>
    </Dialog>
  );
}

function SaveAsBlockDialog(props: { connectionId: string; unitId: number; area: 1 | 2 | 3 | 4; start: number; quantity: number; registers: number[] }) {
  const workspace = useWorkspace();
  const command = useApp((s) => s.command);
  const close = useApp((s) => s.closeOverlay);
  const [templateId, setTemplateId] = useState(workspace?.templates[0]?.id ?? '');
  const [name, setName] = useState('临时寄存器块');
  const [period, setPeriod] = useState('500');
  const [newTemplateOpen, setNewTemplateOpen] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState('新设备模板');
  const [newTemplateDesc, setNewTemplateDesc] = useState('用于保存本次临时读取的数据块');
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
      <Dialog title="保存为数据块" subtitle="选择目标模板并确认数据块参数。" width={720} onClose={close} footer={<><Button onClick={close}>取消</Button><Button variant="primary" disabled={overlap} onClick={() => void save()}>保存数据块</Button></>}>
        <Field label="目标模板">
          <Select value={templateId} onChange={setTemplateId} options={[{ value: '', label: '（暂不绑定模板）' }, ...(workspace?.templates.map((t) => ({ value: t.id, label: t.name })) ?? [])]} />
        </Field>
        <div className="mt-2 -mt-1 mb-3 rounded-ctl border border-line bg-surface px-3 py-2 text-sm">
          {workspace?.templates.map((t) => (t.id === templateId ? <span key={t.id} className="text-accent">✓ {t.name}</span> : <span key={t.id} className="block text-ink2">{t.name}</span>))}
          <button className="focus-ring mt-1 cursor-pointer text-xs text-accent hover:underline" onClick={() => setNewTemplateOpen(true)}>＋ 新建模板…</button>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="数据块名称"><TextInput value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="轮询周期"><Select value={period} onChange={setPeriod} options={['100', '200', '500', '1000'].map((p) => ({ value: p, label: `${p} ms` }))} /></Field>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-4">
          <Field label="地址区"><TextInput readOnly value={AREAS[props.area]} /></Field>
          <Field label="起始地址"><TextInput readOnly value={String(props.start)} /></Field>
          <Field label="长度"><TextInput readOnly value={String(props.quantity)} /></Field>
        </div>
        <InfoBand tone="blue" className={`mt-5 ${overlap ? 'bg-[#FDECEA]' : ''}`}>
          <div className={`text-sm ${overlap ? 'text-err' : 'text-ok'}`}>{overlap ? '✕ 与模板中已有数据块重叠' : `✓ 当前模板中 ${props.area === 3 ? 'Holding' : props.area === 4 ? 'Input' : props.area === 2 ? 'Discrete' : 'Coil'} ${props.start}–${props.start + props.quantity - 1} 无重叠`}</div>
        </InfoBand>
      </Dialog>
      {newTemplateOpen ? (
        <Dialog title="新建设备模板" width={520} onClose={() => setNewTemplateOpen(false)} footer={<><Button onClick={() => setNewTemplateOpen(false)}>取消</Button><Button variant="primary" onClick={async () => {
          if (!workspace) return;
          const id = uid('tpl');
          await command({ type: 'workspace.apply', workspace: { ...workspace, templates: [...workspace.templates, { id, name: newTemplateName, version: '1.0', description: newTemplateDesc, blocks: [], points: [] }] } });
          setTemplateId(id);
          setNewTemplateOpen(false);
        }}>创建并选择</Button></>}>
          <Field label="名称"><TextInput value={newTemplateName} onChange={(e) => setNewTemplateName(e.target.value)} /></Field>
          <div className="mt-4">
            <Field label="说明（可选）"><TextInput value={newTemplateDesc} onChange={(e) => setNewTemplateDesc(e.target.value)} /></Field>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

function ConfirmDialog(props: { title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void }) {
  const close = useApp((s) => s.closeOverlay);
  return (
    <Dialog title={props.title} width={460} onClose={close} footer={<><Button onClick={close}>取消</Button><Button variant={props.danger ? 'danger' : 'primary'} onClick={() => { props.onConfirm(); close(); }}>{props.confirmLabel}</Button></>}>
      <div className="text-sm pb-4">{props.message}</div>
    </Dialog>
  );
}