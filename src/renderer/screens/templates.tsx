import React, { useMemo, useState } from 'react';
import { useApp } from '../store/app';
import { Button, EmptyState, InfoBand, InfoColumns, PageHeader, SectionTitle, Select, StatusDot, TextInput } from '../components/ui';
import { DataTable, type Column } from '../components/table';
import { AREAS, parsePlcReference, toPlcReference } from '../../domain/address';
import { findBlockOverlaps } from '../../domain/overlap';
import type { BlockDef, PointDef } from '../../domain/model';
import { registersForType } from '../../domain/mapping';

export function TemplatesScreen() {
  const snapshot = useApp((s) => s.snapshot);
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const command = useApp((s) => s.command);
  const overlay = useApp((s) => s.overlay);

  const template = snapshot?.workspace.templates.find((t) => t.id === selection.templateId) ?? snapshot?.workspace.templates[0];
  if (!snapshot) return null;
  if (overlay?.kind === 'screen' && overlay.id === 'import-registers') return <ImportRegisters templateId={overlay.templateId} />;
  if (!template) {
    return <EmptyState title="还没有设备模板" message="模板定义数据块与点位，可被多个从站复用。" />;
  }
  if (selection.templateEditing) return <TemplateEdit templateId={template.id} />;

  const bound = snapshot.workspace.slaves.filter((s) => s.templateId === template.id);
  return (
    <>
      <PageHeader
        title={template.name}
        subtitle="管理可复用的设备寄存器模板。"
        actions={
          <>
            <Button
              onClick={async () => {
                const ws = snapshot.workspace;
                const copy = { ...template, id: `tpl-${Date.now().toString(36)}`, name: `${template.name} 副本` };
                await command({ type: 'workspace.apply', workspace: { ...ws, templates: [...ws.templates, copy] } });
              }}
            >
              复制模板
            </Button>
            <Button variant="primary" onClick={() => select({ templateEditing: true, editBlockId: template.blocks[0]?.id ?? null })}>编辑模板</Button>
          </>
        }
      />
      <InfoColumns
        items={[
          { label: '数据块', value: String(template.blocks.length) },
          { label: '点位', value: String(template.points.length) },
          { label: '绑定从站', value: String(bound.length) },
          { label: '模板版本', value: template.version },
          { label: '最近修改', value: '—' },
        ]}
      />
      <SectionTitle>数据块</SectionTitle>
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
        {template.blocks.map((b) => (
          <div key={b.id} className="rounded-card border border-line bg-surface p-5">
            <div className="text-sm font-bold">{b.name}</div>
            <div className="text-xs text-accent mt-1">{AREAS[b.area]}</div>
            <div className="mt-4 flex flex-col gap-2 text-xs">
              <div className="flex"><span className="w-16 text-ink2">地址范围</span><span className="mono">{b.start}–{b.start + b.length - 1}</span></div>
              <div className="flex"><span className="w-16 text-ink2">长度</span><span>{b.length} 个寄存器</span></div>
              <div className="flex"><span className="w-16 text-ink2">点位</span><span>{template.points.filter((p) => p.blockId === b.id).length} 个</span></div>
            </div>
          </div>
        ))}
      </div>
      <SectionTitle>绑定到此模板的从站</SectionTitle>
      <div className="rounded-card border border-line bg-surface px-5">
        {bound.length === 0 ? <div className="py-6 text-center text-sm text-ink2">还没有从站绑定此模板</div> : null}
        {bound.map((s) => {
          const conn = snapshot.workspace.connections.find((c) => c.id === s.connectionId);
          const online = snapshot.connections[s.connectionId]?.state === 'online';
          return (
            <div key={s.id} className="flex items-center justify-between border-b border-[#E7EAEE] py-3 last:border-0 text-sm">
              <span>{conn?.name} / {s.name}</span>
              <span className="text-xs text-ink2">从站 {s.unitId}</span>
              <StatusDot tone={online ? 'ok' : 'idle'} label={online ? '在线' : '离线'} />
              <button className="focus-ring cursor-pointer text-xs text-accent hover:underline" onClick={() => select({ slaveId: s.id, connectionId: s.connectionId })}>打开设备</button>
            </div>
          );
        })}
      </div>
      <InfoBand tone="blue" className="mt-6">
        <div className="text-sm font-bold text-accent mb-1">修改影响</div>
        <div className="text-sm">模板保存后会影响所有绑定实例；某台设备定义不同时，请“复制模板”后重新绑定，避免实例结构覆写。</div>
      </InfoBand>
    </>
  );
}

function TemplateEdit(props: { templateId: string }) {
  const snapshot = useApp((s) => s.snapshot);
  const selection = useApp((s) => s.selection);
  const openOverlay = useApp((s) => s.openOverlay);
  const command = useApp((s) => s.command);
  const toast = useApp((s) => s.toast);
  const [tab, setTab] = useState<'map' | 'memory' | 'block'>('map');
  const [search, setSearch] = useState('');
  const [selectedPoint, setSelectedPoint] = useState<string | null>(null);

  const template = snapshot?.workspace.templates.find((t) => t.id === props.templateId);
  const block = template?.blocks.find((b) => b.id === selection.editBlockId) ?? template?.blocks[0];
  if (!snapshot || !template || !block) return <EmptyState title="模板没有数据块" actions={<Button variant="primary" onClick={() => openOverlay({ kind: 'dialog', id: 'edit-block', templateId: props.templateId })}>＋ 添加数据块</Button>} />;

  const points = template.points.filter((p) => p.blockId === block.id && (!search || p.name.includes(search)));
  const detail = template.points.find((p) => p.id === selectedPoint) ?? points[0];
  const cacheEntry = Object.values(snapshot.blocks).find((b) => b.blockId === block.id);

  const cols: Array<Column<PointDef>> = [
    { id: 'offset', header: '偏移', width: 80, render: (p) => <span className="mono text-xs">+{p.mapping.offset}{p.mapping.bitOffset ? `.${p.mapping.bitOffset}:${p.mapping.bitOffset + p.mapping.bitWidth - 1}` : ''}</span> },
    { id: 'name', header: '名称', width: 160, render: (p) => <span className="text-sm font-medium">{p.name}</span> },
    { id: 'type', header: '类型', width: 100, render: (p) => <span className="text-xs text-ink2">{p.mapping.rawType}</span> },
    { id: 'map', header: '映射', width: 120, render: (p) => <span className="text-xs">{p.mapping.rawType === 'Bool' ? `bit ${p.mapping.bitOffset}` : p.mapping.rawType === 'BitField' ? `bits ${p.mapping.bitOffset}..${p.mapping.bitOffset + p.mapping.bitWidth - 1}` : `${p.mapping.registerCount} 寄存器`}</span> },
    { id: 'unit', header: '单位', width: 70, render: (p) => <span className="text-xs">{p.unit || '—'}</span> },
    { id: 'access', header: '访问权限', width: 90, render: (p) => <span className={`text-xs ${p.access === 'rw' ? 'text-accent font-medium' : 'text-ink2'}`}>{p.access === 'rw' ? '读写' : '只读'}</span> },
    { id: 'desc', header: '说明', width: 140, render: (p) => <span className="text-xs text-ink2">{p.mapping.wordOrder !== 'ABCD' ? p.mapping.wordOrder : p.enumMap && Object.keys(p.enumMap).length ? 'Enum' : p.mapping.rawType === 'String' ? p.mapping.stringEncoding.toUpperCase() : ''}</span> },
  ];

  return (
    <>
      <PageHeader
        title={block.name}
        subtitle={`${AREAS[block.area]} · 地址 ${block.start}–${block.start + block.length - 1} · 长度 ${block.length} · 默认轮询周期 ${block.periodMs} ms`}
        actions={
          <>
            <Button onClick={() => openOverlay({ kind: 'dialog', id: 'edit-block', templateId: template.id, blockId: block.id })}>编辑块</Button>
            <Button variant="primary" onClick={() => toast({ kind: 'success', title: '模板已保存' })}>保存</Button>
          </>
        }
      />
      <div className="flex items-center gap-6 border-b border-line mb-4">
        {([['map', '点位映射'], ['memory', '内存布局'], ['block', '块设置']] as const).map(([id, label]) => (
          <button key={id} className={`focus-ring -mb-px cursor-pointer border-b-2 px-1 pb-2 text-sm ${tab === id ? 'border-accent text-accent font-medium' : 'border-transparent text-ink2'}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'map' && (
        <div className="flex gap-6">
          <div className="min-w-0 flex-1">
            <div className="mb-3 flex items-center gap-4">
              <button className="focus-ring cursor-pointer text-sm text-accent hover:underline" onClick={() => openOverlay({ kind: 'drawer', id: 'edit-point', templateId: template.id, blockId: block.id })}>＋ 添加点位</button>
              <button className="focus-ring cursor-pointer text-sm text-ink2 hover:underline" onClick={() => openOverlay({ kind: 'screen', id: 'import-registers', templateId: template.id })}>导入 CSV</button>
              <div className="flex-1" />
              <div className="w-48"><TextInput className="h-8" placeholder="搜索" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
            </div>
            <DataTable columns={cols} rows={points} rowKey={(p) => p.id} onRowClick={(p) => setSelectedPoint(p.id)} selectedKey={detail?.id ?? null} maxHeight={460} />
          </div>
          <aside className="w-[280px] shrink-0 rounded-card bg-surface2 p-5 self-start">
            <div className="text-sm font-bold mb-2">映射详情</div>
            {detail ? (
              <>
                <div className="text-sm text-accent font-medium mb-3">{detail.name}</div>
                <div className="text-xs text-ink2 mb-1">内存</div>
                <div className="text-xs leading-6 mb-3">
                  寄存器偏移 +{detail.mapping.offset}<br />
                  {detail.mapping.rawType === 'Bool' || detail.mapping.rawType === 'BitField' ? <>位偏移 {detail.mapping.bitOffset} · 位宽 {detail.mapping.bitWidth}<br /></> : null}
                  数据类型 {detail.mapping.rawType === 'BitField' ? 'UInt' : detail.mapping.rawType}<br />
                  {Object.keys(detail.enumMap).length ? '显示 Enum' : detail.mapping.rawType === 'String' ? `显示 String · ${detail.mapping.stringEncoding}` : `显示 ${detail.mapping.rawType}`}
                </div>
                <div className="text-xs text-ink2 mb-1">访问规则</div>
                <div className="text-xs leading-6 mb-3">
                  {block.area === 3 ? '保持寄存器块允许该点位配置为读写' : '输入寄存器 / 离散输入固定只读'}
                  <br />
                  {detail.access === 'rw' ? '已配置为读写' : '只读'}
                </div>
                <div className="text-xs text-ink2 mb-1">点位重叠</div>
                <div className="text-xs leading-6 mb-3">允许。多点可解释同一寄存器<br />写入后刷新所有受影响点位</div>
                <div className="text-xs text-ink2 mb-1">高级</div>
                <div className="text-xs">字节序 · 编码 · 缩放 · 枚举映射</div>
                <Button size="sm" className="mt-4 w-full" onClick={() => openOverlay({ kind: 'drawer', id: 'edit-point', templateId: template.id, blockId: block.id, pointId: detail.id })}>编辑点位</Button>
              </>
            ) : (
              <div className="text-xs text-ink2">选择点位查看映射详情</div>
            )}
          </aside>
        </div>
      )}
      {tab === 'memory' && (
        <div className="rounded-card border border-line bg-surface p-5">
          <div className="text-sm font-bold mb-3">Block Raw Memory（只解释当前 Block Cache，不额外请求设备）</div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {Array.from({ length: Math.min(block.length, 32) }, (_, i) => (
              <div key={i} className="rounded-ctl bg-surface2 px-3 py-2">
                <div className="flex justify-between text-xs text-ink2"><span>+{i}</span><span>+{i + 1}</span></div>
                <div className="mono text-sm mt-1">0x{(cacheEntry ? 0 : 0).toString(16).toUpperCase().padStart(4, '0')}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {tab === 'block' && (
        <div className="max-w-xl flex flex-col gap-4">
          <label className="block"><div className="text-xs text-ink2 mb-1.5">名称</div><TextInput value={block.name} onChange={(e) => void command({ type: 'workspace.apply', workspace: { ...snapshot.workspace, templates: snapshot.workspace.templates.map((t) => (t.id === template.id ? { ...t, blocks: t.blocks.map((b) => (b.id === block.id ? { ...b, name: e.target.value } : b)) } : t)) } })} /></label>
          <div className="grid grid-cols-3 gap-4">
            <label className="block"><div className="text-xs text-ink2 mb-1.5">起始地址</div><TextInput type="number" value={String(block.start)} onChange={(e) => void command({ type: 'workspace.apply', workspace: { ...snapshot.workspace, templates: snapshot.workspace.templates.map((t) => (t.id === template.id ? { ...t, blocks: t.blocks.map((b) => (b.id === block.id ? { ...b, start: Number(e.target.value) } : b)) } : t)) } })} /></label>
            <label className="block"><div className="text-xs text-ink2 mb-1.5">长度</div><TextInput type="number" value={String(block.length)} onChange={(e) => void command({ type: 'workspace.apply', workspace: { ...snapshot.workspace, templates: snapshot.workspace.templates.map((t) => (t.id === template.id ? { ...t, blocks: t.blocks.map((b) => (b.id === block.id ? { ...b, length: Number(e.target.value) } : b)) } : t)) } })} /></label>
            <label className="block"><div className="text-xs text-ink2 mb-1.5">默认轮询周期</div><Select value={String(block.periodMs)} onChange={(v) => void command({ type: 'workspace.apply', workspace: { ...snapshot.workspace, templates: snapshot.workspace.templates.map((t) => (t.id === template.id ? { ...t, blocks: t.blocks.map((b) => (b.id === block.id ? { ...b, periodMs: Number(v) } : b)) } : t)) } })} options={[{ value: '50', label: '50 ms' }, { value: '100', label: '100 ms' }, { value: '200', label: '200 ms' }, { value: '500', label: '500 ms' }, { value: '1000', label: '1000 ms' }]} /></label>
          </div>
          <InfoBand tone="blue">计算范围：{block.start}–{block.start + block.length - 1} · {block.length} 个寄存器</InfoBand>
        </div>
      )}
    </>
  );
}

interface ImportRow {
  address: number;
  name: string;
  type: string;
  access: string;
  unit: string;
  scale: string;
  offset: string;
}

function ImportRegisters(props: { templateId: string }) {
  const snapshot = useApp((s) => s.snapshot);
  const command = useApp((s) => s.command);
  const toast = useApp((s) => s.toast);
  const closeOverlay = useApp((s) => s.closeOverlay);
  const [table, setTable] = useState<{ columns: string[]; rows: string[][]; sourceLabel: string } | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({ Address: 'address', Name: 'name', Type: 'type', Access: 'access', Unit: 'unit', Scale: 'scale', Offset: 'offset' });
  const [blockStrategy, setBlockStrategy] = useState<'auto' | 'single'>('auto');

  const targetFields = ['address', 'name', 'type', 'access', 'unit', 'scale', 'offset'];

  const parsed = useMemo<ImportRow[]>(() => {
    if (!table) return [];
    const idx = (field: string) => {
      const col = Object.entries(mapping).find(([, v]) => v === field)?.[0];
      return col ? table.columns.indexOf(col) : -1;
    };
    return table.rows
      .map((r) => {
        const rawAddr = idx('address') >= 0 ? (r[idx('address')] ?? '') : '';
        const plc = parsePlcReference(rawAddr);
        return {
          address: plc ? plc.address : Number(rawAddr) || 0,
          area: plc?.area,
          name: idx('name') >= 0 ? (r[idx('name')] ?? '') : rawAddr,
          type: idx('type') >= 0 ? (r[idx('type')] ?? '') : 'UInt16',
          access: idx('access') >= 0 ? (r[idx('access')] ?? '') : 'R',
          unit: idx('unit') >= 0 ? (r[idx('unit')] ?? '') : '',
          scale: idx('scale') >= 0 ? (r[idx('scale')] ?? '') : '1',
          offset: idx('offset') >= 0 ? (r[idx('offset')] ?? '') : '0',
        } as ImportRow & { area?: 1 | 2 | 3 | 4 };
      })
      .filter((r) => r.name);
  }, [table, mapping]);

  const plcDetected = useMemo(() => {
    if (!table) return [];
    const i = table.columns.indexOf(Object.entries(mapping).find(([, v]) => v === 'address')?.[0] ?? '');
    if (i < 0) return [];
    return table.rows.slice(0, 3).map((r) => {
      const plc = parsePlcReference(r[i] ?? '');
      return plc ? `${r[i]} → ${plc.area === 3 ? 'Holding' : plc.area === 4 ? 'Input' : plc.area === 2 ? 'Discrete' : 'Coil'} ${plc.address}` : '';
    }).filter(Boolean);
  }, [table, mapping]);

  const errors = parsed.filter((p) => !p.name).length;

  const doImport = async () => {
    if (!snapshot) return;
    const template = snapshot.workspace.templates.find((t) => t.id === props.templateId);
    if (!template) return;
    const areas = new Set(parsed.map((p) => (p as { area?: number }).area ?? 3));
    const blocks: BlockDef[] = [];
    const points: PointDef[] = [];
    if (blockStrategy === 'auto') {
      for (const area of areas) {
        const list = parsed.filter((p) => ((p as { area?: number }).area ?? 3) === area).sort((a, b) => a.address - b.address);
        if (!list.length) continue;
        let chunk: typeof list = [];
        const flush = () => {
          if (!chunk.length) return;
          const start = (chunk[0] as ImportRow).address;
          const end = Math.max(...chunk.map((c) => c.address)) + 1;
          const id = `blk-${Date.now().toString(36)}-${blocks.length}`;
          blocks.push({ id, name: `导入块 ${blocks.length + 1}`, area: area as 1 | 2 | 3 | 4, start, length: end - start, periodMs: 200 });
          for (const p of chunk) {
            points.push(makePoint(id, p));
          }
          chunk = [];
        };
        for (const p of list) {
          if (chunk.length && p.address - (chunk[chunk.length - 1] as ImportRow).address > 8) flush();
          chunk.push(p);
        }
        flush();
      }
    } else {
      const id = `blk-${Date.now().toString(36)}`;
      const start = Math.min(...parsed.map((p) => p.address));
      const end = Math.max(...parsed.map((p) => p.address)) + 1;
      blocks.push({ id, name: '导入块 1', area: 3, start, length: end - start, periodMs: 200 });
      for (const p of parsed) points.push(makePoint(id, p));
    }
    const nextBlocks = [...template.blocks, ...blocks];
    if (findBlockOverlaps(nextBlocks).length) {
      toast({ kind: 'error', title: '无法导入', message: '同地址区数据块重叠，导入被阻止。' });
      return;
    }
    await command({ type: 'workspace.apply', workspace: { ...snapshot.workspace, templates: snapshot.workspace.templates.map((t) => (t.id === template.id ? { ...t, blocks: nextBlocks, points: [...t.points, ...points] } : t)) } });
    toast({ kind: 'success', title: `已导入 ${points.length} 个点位` });
    closeOverlay();
  };

  return (
    <>
      <PageHeader title="导入寄存器表" subtitle="Excel / CSV / 粘贴表格 / JSON → 字段映射 → 数据块与点位预览。" actions={<Button onClick={() => closeOverlay()}>取消</Button>} />
      <div className="flex items-center gap-8 border-b border-line mb-5 text-sm">
        <span className={table ? 'text-ink2' : 'text-accent font-medium'}>1 数据来源</span>
        <span className={table ? 'text-accent font-medium' : 'text-ink2'}>2 字段映射</span>
        <span className="text-ink2">3 导入预览</span>
      </div>
      <InfoBand className="mb-5 flex items-center justify-between">
        <div>
          <div className="text-xs text-ink2 mb-1">来源</div>
          <div className="text-sm mono">{table?.sourceLabel ?? '未选择文件'}</div>
        </div>
        <div className="flex gap-3">
          <Button
            size="sm"
            onClick={async () => {
              const res = await command<string>({ type: 'dialog.openFile', accept: ['xlsx', 'csv', 'json', 'tsv'] });
              if (!res.ok) return;
              const parse = await command<{ columns: string[]; rows: string[][]; sourceLabel: string }>({ type: 'import.parse', source: { kind: 'file', path: res.value } });
              if (parse.ok) setTable(parse.value);
            }}
          >
            更换文件
          </Button>
          <Button
            size="sm"
            onClick={async () => {
              const text = await navigator.clipboard.readText();
              const parse = await command<{ columns: string[]; rows: string[][]; sourceLabel: string }>({ type: 'import.parse', source: { kind: 'text', text, format: 'clipboard' } });
              if (parse.ok) setTable(parse.value);
            }}
          >
            粘贴表格
          </Button>
        </div>
      </InfoBand>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <div>
          <div className="text-sm font-bold mb-3">字段映射</div>
          <div className="rounded-card border border-line bg-surface p-4">
            <div className="grid grid-cols-2 gap-2 pb-2 text-xs text-ink2"><span>源列</span><span>目标字段</span></div>
            {(table?.columns ?? ['Address', 'Name', 'Type', 'Access', 'Unit', 'Scale', 'Offset']).map((col) => (
              <div key={col} className="grid grid-cols-2 items-center gap-2 border-t border-[#E7EAEE] py-2">
                <span className="text-sm">{col}</span>
                <Select value={mapping[col] ?? ''} onChange={(v) => setMapping({ ...mapping, [col]: v })} options={[{ value: '', label: '—' }, ...targetFields.map((f) => ({ value: f, label: f }))]} />
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="text-sm font-bold mb-3">预览与转换</div>
          <div className="rounded-card border border-line bg-surface p-4">
            {plcDetected.length ? (
              <div className="mb-3 rounded-ctl bg-[#FDF3E7] px-3 py-2 text-xs text-warn">
                检测到 PLC 风格地址
                <div className="mono mt-1">{plcDetected.join('　')}</div>
              </div>
            ) : null}
            <div className="flex flex-col gap-1.5">
              {parsed.slice(0, 6).map((p, i) => (
                <div key={i} className="grid grid-cols-5 gap-2 text-xs">
                  <span className="mono">{p.address}</span>
                  <span className="col-span-2">{p.name}</span>
                  <span>{p.type}</span>
                  <span>{p.access}</span>
                </div>
              ))}
            </div>
            <div className="mt-3 text-xs text-ok">✓ {parsed.length} 行可导入 · {errors} 行需要确认 · 0 行错误</div>
            <div className="mt-1 text-xs text-ink2">✓ 已转换为 0-based</div>
          </div>
        </div>
      </div>
      <div className="text-sm font-bold mt-6 mb-3">数据块策略</div>
      <InfoBand>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" checked={blockStrategy === 'auto'} onChange={() => setBlockStrategy('auto')} className="accent-[#0078D4]" />
          根据地址区 + 连续范围自动建议数据块
        </label>
        <label className="flex items-center gap-2 text-sm mt-2">
          <input type="radio" checked={blockStrategy === 'single'} onChange={() => setBlockStrategy('single')} className="accent-[#0078D4]" />
          全部放入单个数据块
        </label>
        <div className="text-xs mt-3">
          建议：{blockStrategy === 'auto' ? 'Holding 0–31 「控制寄存器」 · Holding 40–55 「状态寄存器」 · Input 0–23 「遥测数据」' : 'Holding 0–N 单块'}
          <br />
          导入目标：{snapshot?.workspace.templates.find((t) => t.id === props.templateId)?.name} · 同地址区数据块重叠时阻止导入 · 点位重叠允许
        </div>
      </InfoBand>
      <div className="mt-6 flex items-center justify-between">
        <span className="text-xs text-ink2">支持：.xlsx / .csv / .json / 从剪贴板粘贴</span>
        <Button variant="primary" disabled={!parsed.length} onClick={() => void doImport()}>导入 {parsed.length} 个点位</Button>
      </div>
    </>
  );
}

function makePoint(blockId: string, p: ImportRow & { area?: 1 | 2 | 3 | 4 }): PointDef {
  const rawType = /float/i.test(p.type) ? 'Float32' : /int16/i.test(p.type) ? 'Int16' : /uint16/i.test(p.type) ? 'UInt16' : /bool/i.test(p.type) ? 'Bool' : /string/i.test(p.type) ? 'String' : 'UInt16';
  return {
    id: `pt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    blockId,
    name: p.name,
    mapping: {
      rawType,
      offset: p.address,
      registerCount: registersForType(rawType, 8),
      wordOrder: 'ABCD',
      byteSelector: 'low',
      bitOffset: 0,
      bitWidth: 16,
      stringLength: rawType === 'String' ? 8 : 0,
      stringEncoding: 'ascii',
    },
    scale: Number(p.scale) || 1,
    offset: Number(p.offset) || 0,
    unit: p.unit,
    access: /rw|w/i.test(p.access) ? 'rw' : 'ro',
    displayFormat: 'auto',
    enumMap: {},
    highRisk: false,
    description: '',
  };
}

export { toPlcReference };