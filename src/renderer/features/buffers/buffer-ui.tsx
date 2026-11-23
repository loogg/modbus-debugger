import React, { useEffect, useState } from 'react';
import { useApp, useWorkspace } from '../../store/app';
import { Button, Dialog, Field, TextInput } from '../../components/ui';
import { bufferCapacity, bufferReferences } from '../../../domain/point-buffers';
import { MAX_BUFFER_CAPACITY, type BufferExportResult, type BufferInfo, type DataPointRef, type DataReadResult } from '../../../shared/point-data';
import { pointKey } from '../../../shared/point-key';
import { fmtEpochDateTimeMs } from '../../time';
import { useDirtyGuard } from '../../workbench/view-context';

export function BufferSettingsDialog({ pointRef }: { pointRef: DataPointRef }) {
  const workspace = useWorkspace();
  const command = useApp(state => state.command);
  const close = useApp(state => state.closeOverlay);
  const open = useApp(state => state.openOverlay);
  const key = pointKey(pointRef.slaveId, pointRef.pointId);
  const info = useApp(state => state.dataBuffers[key]);
  const currentCapacity = workspace ? bufferCapacity(workspace, pointRef) : 10000;
  const [baseline, setBaseline] = useState(currentCapacity);
  const [capacity, setCapacity] = useState(String(currentCapacity));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dirty = capacity !== String(baseline);
  useDirtyGuard(dirty);
  useEffect(() => {
    if (!dirty) { setBaseline(currentCapacity); setCapacity(String(currentCapacity)); }
  }, [currentCapacity, dirty]);
  const slave = workspace?.slaves.find(item => item.id === pointRef.slaveId);
  const point = workspace?.templates.find(item => item.id === slave?.templateId)?.points.find(item => item.id === pointRef.pointId);
  const references = workspace ? bufferReferences(workspace).get(key)?.references ?? info?.references ?? [] : [];
  const value = Number(capacity);
  const valid = Number.isInteger(value) && value >= 10 && value <= MAX_BUFFER_CAPACITY;
  const save = async () => {
    if (!valid) return;
    setSaving(true); setError('');
    const result = await command({ type: 'buffer.configure', config: { ...pointRef, capacity: value }, expectedCapacity: baseline });
    setSaving(false);
    if (result.ok) { setBaseline(value); setCapacity(String(value)); close(); }
    else setError(result.error);
  };
  return <Dialog title="点位采样缓冲" subtitle={`${slave?.name ?? pointRef.slaveId} / ${point?.name ?? pointRef.pointId}`} width={520} onClose={close}
    footer={<><Button onClick={close}>关闭</Button><Button variant="primary" disabled={!valid || saving} onClick={() => void save()}>{saving ? '保存中…' : '保存共享容量'}</Button></>}>
    <Field label="共享容量（点）"><TextInput aria-label="共享缓冲容量" type="number" min={10} max={MAX_BUFFER_CAPACITY} value={capacity} onChange={event => setCapacity(event.target.value)} /></Field>
    <p className="mt-2 text-xs text-ink2">该设备点位的所有趋势和曲线共用此容量。</p>
    {error && <p role="alert" className="mt-3 text-xs text-err">{error}</p>}
    {info && <div className="mt-4 space-y-1 text-sm"><div>已缓存 {info.count.toLocaleString()} / {info.capacity.toLocaleString()} 点</div>
      {info.firstTimeMs !== null && <div className="text-xs text-ink2">{fmtEpochDateTimeMs(info.firstTimeMs)} — {fmtEpochDateTimeMs(info.lastTimeMs!)}</div>}
      {info.error && <p role="alert" className="text-err">{info.error}</p>}
    </div>}
    {valid && info && value < info.count && <p className="mt-3 text-xs text-warn">缩小后保留最近 {value.toLocaleString()} 个样本。</p>}
    {dirty && currentCapacity !== baseline && <p role="alert" className="mt-3 text-xs text-warn">其他页面已把容量改为 {currentCapacity}。<button className="text-accent" onClick={() => { setBaseline(currentCapacity); setCapacity(String(currentCapacity)); }}>采用当前容量</button></p>}
    <div className="mt-5 text-xs font-semibold">使用此缓冲的位置</div>
    <ul className="mt-2 space-y-1 text-xs text-ink2">{references.map(label => <li key={label}>{label}</li>)}</ul>
    <Button className="mt-5" disabled={dirty} onClick={() => open({ kind: 'dialog', id: 'buffer-export', points: [pointRef], name: point?.name ?? '点位' })}>导出该点位</Button>
  </Dialog>;
}

export function BufferExportDialog({ points, name }: { points: DataPointRef[]; name: string }) {
  const command = useApp(state => state.command);
  const api = useApp(state => state.api);
  const close = useApp(state => state.closeOverlay);
  const toast = useApp(state => state.toast);
  const [infos, setInfos] = useState<BufferInfo[]>([]);
  const [file, setFile] = useState('');
  const [range, setRange] = useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const signature = JSON.stringify(points);
  useEffect(() => {
    let alive = true;
    void command<DataReadResult>({ type: 'data.read', points: [], blocks: [], series: [], buffers: JSON.parse(signature) as DataPointRef[] }).then(result => {
      if (!alive) return;
      if (!result.ok) { setError(result.error); return; }
      const values = Object.values(result.value.buffers);
      setInfos(values);
      const first = Math.min(...values.flatMap(info => info.firstTimeMs === null ? [] : [info.firstTimeMs]));
      const last = Math.max(...values.flatMap(info => info.lastTimeMs === null ? [] : [info.lastTimeMs]));
      if (Number.isFinite(first)) setStart(new Date(first).toISOString().slice(0, 23));
      if (Number.isFinite(last)) setEnd(new Date(last).toISOString().slice(0, 23));
    });
    return () => { alive = false; };
  }, [command, signature]);
  const startMs = range ? Date.parse(`${start}Z`) : undefined;
  const endMs = range ? Date.parse(`${end}Z`) : undefined;
  const validRange = !range || (Number.isFinite(startMs) && Number.isFinite(endMs) && startMs! <= endMs!);
  const exportFile = async () => {
    if (!file.trim() || !validRange) return;
    setBusy(true); setError('');
    const result = await command<BufferExportResult>({ type: 'buffer.export', points, path: file.trim(), startMs, endMs });
    setBusy(false);
    if (result.ok) { toast({ kind: 'success', title: `已导出 ${result.value.count.toLocaleString()} 个样本`, message: result.value.path }); close(); }
    else setError(result.error);
  };
  return <Dialog title="导出采样数据" subtitle={name} width={620} onClose={close} footer={<><Button disabled={busy} onClick={close}>取消</Button><Button variant="primary" disabled={busy || !file.trim() || !validRange} onClick={() => void exportFile()}>{busy ? '导出中…' : '导出 CSV'}</Button></>}>
    <p className="mb-4 text-sm">{points.length} 个点位 · 当前缓冲约 {infos.reduce((sum, info) => sum + info.count, 0).toLocaleString()} 个样本</p>
    {infos.some(info => info.firstTimeMs !== null) && <p className="mb-4 text-xs text-ink2">可用范围 {start.replace('T', ' ')} — {end.replace('T', ' ')} UTC</p>}
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={range} onChange={event => setRange(event.target.checked)} />指定时间范围</label>
    {range && <div className="my-4 grid grid-cols-2 gap-3"><Field label="起始时间（UTC）"><TextInput aria-label="导出起始时间" type="datetime-local" step="0.001" value={start} onInput={event => setStart(event.currentTarget.value)} /></Field><Field label="结束时间（UTC）"><TextInput aria-label="导出结束时间" type="datetime-local" step="0.001" value={end} onInput={event => setEnd(event.currentTarget.value)} /></Field></div>}
    <div className="mt-4"><Field label="CSV 文件"><div className="flex gap-2"><TextInput className="min-w-0 flex-1" aria-label="采样导出路径" value={file} onChange={event => setFile(event.target.value)} placeholder="选择保存位置或输入绝对路径" /><Button className="shrink-0 whitespace-nowrap" onClick={async () => {
      const safeName = name.replace(/[<>:"/\\|?*]/g, '_');
      const result = await api?.command<string>({ type: 'dialog.saveFile', defaultName: `${safeName}-${Date.now()}.csv` });
      if (result?.ok) setFile(result.value);
      else if (result?.error !== 'cancelled') setError(result?.error ?? '文件选择器未连接');
    }}>浏览…</Button></div></Field></div>
    {error && <p role="alert" className="mt-3 text-xs text-err">{error}</p>}
    <p className="mt-3 text-xs leading-5 text-ink2">导出缓冲中保留的原始样本，包含 UTC 毫秒时间、序号和值。采样期间持续覆盖最旧数据。</p>
  </Dialog>;
}

export function InstanceBuffers({ slaveId }: { slaveId: string }) {
  const workspace = useWorkspace();
  const open = useApp(state => state.openOverlay);
  const infos = useApp(state => state.dataBuffers);
  if (!workspace) return null;
  const refs = [...bufferReferences(workspace).values()].filter(ref => ref.slaveId === slaveId);
  if (!refs.length) return null;
  const slave = workspace.slaves.find(item => item.id === slaveId);
  const template = workspace.templates.find(item => item.id === slave?.templateId);
  return <section className="mt-6" aria-label="实例采样缓冲"><h2 className="mb-3 text-sm font-semibold">采样缓冲</h2><div className="divide-y divide-line rounded border border-line bg-surface">
    {refs.map(ref => {
      const key = pointKey(ref.slaveId, ref.pointId);
      const info = infos[key];
      return <div key={key} className="flex flex-wrap items-center gap-3 px-4 py-3 text-xs"><span className="min-w-24 flex-1 font-medium">{template?.points.find(point => point.id === ref.pointId)?.name ?? ref.pointId}</span>
        <span className="text-ink2">{info?.count ?? 0} / {bufferCapacity(workspace, ref)} 点</span><span className="text-ink2">{ref.references.length} 处引用</span>
        <button className="focus-ring text-accent" aria-label={`${ref.pointId} 缓冲设置`} onClick={() => open({ kind: 'dialog', id: 'point-buffer', pointRef: ref })}>设置容量</button>
        <button className="focus-ring text-accent" aria-label={`${ref.pointId} 导出采样`} onClick={() => open({ kind: 'dialog', id: 'buffer-export', points: [ref], name: template?.points.find(point => point.id === ref.pointId)?.name ?? ref.pointId })}>导出</button>
      </div>;
    })}
  </div></section>;
}
