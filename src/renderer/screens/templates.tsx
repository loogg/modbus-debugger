import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp, useConnectionStates, useWorkspace } from '../store/app';
import { BlockMemoryLayout } from '../components/block-memory-layout';
import { TemplateProperties } from '../components/template-properties';
import { PointPropertyInspector } from '../components/point-property-inspector';
import { Button, EmptyState, InfoBand, InfoColumns, PageHeader, SectionTitle, Select, StatusDot, TextInput } from '../components/ui';
import { DataTable, type Column } from '../components/table';
import { AREAS, parsePlcReference, toPlcReference } from '../../domain/address';
import { findBlockOverlaps } from '../../domain/overlap';
import type { BlockDef, PointDef } from '../../domain/model';
import { buildImportPlan } from '../../domain/import-plan';
import { useTranslation } from '../i18n';

export function TemplatesScreen() {
  const { t } = useTranslation();
  const workspace = useWorkspace();
  const connStates = useConnectionStates();
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const command = useApp((s) => s.command);
  const overlay = useApp((s) => s.overlay);
  const setModule = useApp((s) => s.setModule);
  const openOverlay = useApp(s => s.openOverlay);
  const toast = useApp(s => s.toast);

  const template = workspace?.templates.find((t) => t.id === selection.templateId) ?? workspace?.templates[0];
  if (!workspace) return null;
  if (overlay?.kind === 'screen' && overlay.id === 'import-registers') return <ImportRegisters templateId={overlay.templateId} />;
  if (!template) {
    return <EmptyState title={t('templates.emptyTitle')} message={t('templates.emptyMessage')} />;
  }
  if (selection.templateEditing) return <TemplateEdit key={`${template.id}:${selection.editBlockId}`} templateId={template.id} />;

  const bound = workspace.slaves.filter((s) => s.templateId === template.id);
  return (
    <>
      <PageHeader
        title={template.name}
        subtitle={t('templates.subtitle')}
        actions={
          <>
            <Button
              onClick={async () => {
                const newId = `tpl-${Date.now().toString(36)}`;
                const res = await command({ type: 'template.copy', sourceTemplateId: template.id, newId, name: t('templates.duplicateName', { name: template.name }) });
                if (res.ok) select({ templateId: newId, templateEditing: false });
              }}
            >
              {t('templates.duplicate')}
            </Button>
            <Button variant="primary" onClick={() => openOverlay({kind:'dialog',id:'edit-block',templateId:template.id})}>{t('templates.addBlock')}</Button>
          </>
        }
      />
      <TemplateProperties key={`${template.id}:${template.name}`} templateId={template.id} name={template.name}/>
      <InfoColumns
        items={[
          { label: t('templates.blocks'), value: String(template.blocks.length) },
          { label: t('templates.points'), value: String(template.points.length) },
          { label: t('templates.boundSlaves'), value: String(bound.length) },
          { label: t('templates.version'), value: template.version },
          { label: t('templates.lastModified'), value: '—' },
        ]}
      />
      <SectionTitle>{t('templates.blocks')}</SectionTitle>
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
        {template.blocks.map((b) => (
          <div key={b.id} className="rounded-card border border-line bg-surface p-5">
            <div className="text-sm font-bold">{b.name}</div>
            <div className="text-xs text-accent mt-1">{AREAS[b.area]}</div>
            <div className="mt-4 flex flex-col gap-2 text-xs">
              <div className="flex"><span className="w-16 text-ink2">{t('templates.addressRange')}</span><span className="mono">{b.start}–{b.start + b.length - 1}</span></div>
              <div className="flex"><span className="w-16 text-ink2">{t('templates.length')}</span><span>{t('templates.registersUnit', { n: b.length })}</span></div>
              <div className="flex"><span className="w-16 text-ink2">{t('templates.points')}</span><span>{t('templates.pointsUnit', { n: template.points.filter((p) => p.blockId === b.id).length })}</span></div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" onClick={()=>select({templateId:template.id,templateEditing:true,editBlockId:b.id})}>打开数据块</Button>
              <Button size="sm" variant="danger" onClick={()=>openOverlay({kind:'dialog',id:'confirm',title:'删除数据块',confirmLabel:'删除数据块',danger:true,
                message:`删除“${b.name}”将同时删除其中 ${template.points.filter(p=>p.blockId===b.id).length} 个点位及相关趋势引用，影响 ${bound.length} 个绑定从站。历史记录保留。`,
                onConfirm:()=>{void(async()=>{if(!(await command({type:'template.deleteBlock',templateId:template.id,blockId:b.id})).ok)return;select({templateId:template.id,templateEditing:false,editBlockId:null});if((await command({type:'template.save',templateId:template.id})).ok)toast({kind:'success',title:'数据块已删除'});})();}})}>删除数据块</Button>
            </div>
          </div>
        ))}
      </div>
      <SectionTitle>{t('templates.boundSection')}</SectionTitle>
      <div className="rounded-card border border-line bg-surface px-5">
        {bound.length === 0 ? <div className="py-6 text-center text-sm text-ink2">{t('templates.noBoundSlaves')}</div> : null}
        {bound.map((s) => {
          const conn = workspace.connections.find((c) => c.id === s.connectionId);
          const online = connStates[s.connectionId]?.state === 'online';
          return (
            <div key={s.id} className="flex items-center justify-between border-b border-[#E7EAEE] py-3 last:border-0 text-sm">
              <span>{conn?.name} / {s.name}</span>
              <span className="text-xs text-ink2">{t('templates.slaveUnit', { n: s.unitId })}</span>
              <StatusDot tone={online ? 'ok' : 'idle'} label={online ? t('templates.online') : t('templates.offline')} />
              <button className="focus-ring cursor-pointer text-xs text-accent hover:underline" onClick={() => { select({ slaveId: s.id, connectionId: s.connectionId, deviceView: 'topology' }); setModule('devices'); }}>{t('templates.openDevice')}</button>
            </div>
          );
        })}
      </div>
      <InfoBand tone="blue" className="mt-6">
        <div className="text-sm font-bold text-accent mb-1">{t('templates.editImpactTitle')}</div>
        <div className="text-sm">{t('templates.editImpactBody')}</div>
      </InfoBand>
    </>
  );
}

function TemplateEdit(props: { templateId: string }) {
  const { t } = useTranslation();
  const workspace = useWorkspace();
  const selection = useApp((s) => s.selection);
  const select = useApp(s => s.select);
  const openOverlay = useApp((s) => s.openOverlay);
  const command = useApp((s) => s.command);
  const toast = useApp((s) => s.toast);
  const [tab, setTab] = useState<'map' | 'memory' | 'block'>('map');
  const [search, setSearch] = useState('');
  const [selectedPoint, setSelectedPoint] = useState<string | null>(null);
  const template = workspace?.templates.find((t) => t.id === props.templateId);
  const block = template?.blocks.find((b) => b.id === selection.editBlockId) ?? template?.blocks[0];

  const deletePoint = useCallback((point: PointDef) => {
    if (!template) return;
    openOverlay({
      kind: 'dialog',
      id: 'confirm',
      title: t('templates.deletePointConfirmTitle'),
      confirmLabel: t('templates.deletePoint'),
      danger: true,
      message: t('templates.deletePointConfirmMessage', { name: point.name }),
      onConfirm: () => {
        void (async () => {
          const res = await command({ type: 'template.deletePoint', templateId: template.id, pointId: point.id });
          if (res.ok) {
            toast({ kind: 'success', title: t('templates.pointDeletedToast') });
            if (selectedPoint === point.id) {
              setSelectedPoint(null);
            }
          }
        })();
      },
    });
  }, [command, openOverlay, selectedPoint, t, template, toast]);

  useEffect(() => {
    if (!template || !block) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const target = e.target as HTMLElement | null;
        const isInput = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
        if (isInput) return;
        const currentPoints = template.points.filter((p) => p.blockId === block.id && (!search || p.name.includes(search)));
        const pt = currentPoints.find((p) => p.id === (selectedPoint ?? currentPoints[0]?.id));
        if (pt) {
          e.preventDefault();
          deletePoint(pt);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [block, deletePoint, search, selectedPoint, template]);

  const save = async () => {
    const res = await command({ type: 'template.save', templateId:props.templateId,blockId:block?.id });
    if (res.ok) toast({ kind: 'success', title: '数据块已保存' });
  };

  const back=()=>select({templateId:props.templateId,templateEditing:false,editBlockId:null});
  if (!workspace || !template || !block) return <EmptyState title={t('templates.noBlocksTitle')} actions={<><Button onClick={back}>返回设备模板</Button><Button variant="primary" onClick={() => openOverlay({ kind: 'dialog', id: 'edit-block', templateId: props.templateId })}>{t('templates.addBlock')}</Button></>} />;

  const points = template.points.filter((p) => p.blockId === block.id && (!search || p.name.includes(search)));
  const detail = points.find((p) => p.id === selectedPoint) ?? points[0];

  const handleSavePoint = async (updated: PointDef): Promise<boolean> => {
    const res = await command({ type: 'template.upsertPoint', templateId: template.id, point: updated });
    if (res.ok) {
      toast({ kind: 'success', title: t('templates.pointSavedToast') });
      return true;
    }
    toast({ kind: 'error', title: res.error ?? '保存点位失败' });
    return false;
  };

  const cols: Array<Column<PointDef>> = [
    { id: 'offset', header: t('templates.colOffset'), width: 80, render: (p) => <span className="mono text-xs">+{p.mapping.offset}{p.mapping.bitOffset ? `.${p.mapping.bitOffset}:${p.mapping.bitOffset + p.mapping.bitWidth - 1}` : ''}</span> },
    { id: 'name', header: t('templates.name'), width: 160, render: (p) => <span className="text-sm font-medium">{p.name}</span> },
    { id: 'type', header: t('templates.colType'), width: 100, render: (p) => <span className="text-xs text-ink2">{p.mapping.rawType}</span> },
    { id: 'map', header: t('templates.colMap'), width: 120, render: (p) => <span className="text-xs">{p.mapping.rawType === 'Bool' ? `bit ${p.mapping.bitOffset}` : p.mapping.rawType === 'BitField' ? `bits ${p.mapping.bitOffset}..${p.mapping.bitOffset + p.mapping.bitWidth - 1}` : t('templates.registers', { n: p.mapping.registerCount })}</span> },
    { id: 'unit', header: t('templates.colUnit'), width: 70, render: (p) => <span className="text-xs">{p.unit || '—'}</span> },
    { id: 'access', header: t('templates.colAccess'), width: 90, render: (p) => <span className={`text-xs ${p.access === 'rw' ? 'text-accent font-medium' : 'text-ink2'}`}>{p.access === 'rw' ? t('templates.accessRw') : t('templates.accessRo')}</span> },
    { id: 'desc', header: t('templates.colDesc'), width: 140, render: (p) => <span className="text-xs text-ink2">{p.mapping.wordOrder !== 'ABCD' ? p.mapping.wordOrder : p.enumMap && Object.keys(p.enumMap).length ? 'Enum' : p.mapping.rawType === 'String' ? p.mapping.stringEncoding.toUpperCase() : ''}</span> },
    {
      id: 'actions',
      header: t('templates.colAction'),
      width: 70,
      render: (p) => (
        <button
          type="button"
          className="focus-ring cursor-pointer text-xs text-err hover:underline"
          title={t('templates.deletePoint')}
          onClick={(e) => {
            e.stopPropagation();
            deletePoint(p);
          }}
        >
          {t('templates.deletePointShort')}
        </button>
      ),
    },
  ];

  return (
    <>
      <button onClick={back} className="focus-ring mb-4 rounded-ctl text-sm text-accent hover:underline">← 返回设备模板：{template.name}</button>
      <PageHeader
        title={block.name}
        subtitle={t('templates.blockSubtitle', { area: AREAS[block.area], start: block.start, end: block.start + block.length - 1, length: block.length, period: block.periodMs })}
        actions={
          <>
            <Button onClick={() => openOverlay({ kind: 'dialog', id: 'edit-block', templateId: template.id, blockId: block.id })}>{t('templates.editBlock')}</Button>
            <Button variant="primary" onClick={() => void save()}>{t('templates.save')}</Button>
          </>
        }
      />
      <div className="flex items-center gap-6 border-b border-line mb-4">
        {([['map', t('templates.tabMap')], ['memory', t('templates.tabMemory')], ['block', t('templates.tabBlock')]] as const).map(([id, label]) => (
          <button key={id} className={`focus-ring -mb-px cursor-pointer border-b-2 px-1 pb-2 text-sm ${tab === id ? 'border-accent text-accent font-medium' : 'border-transparent text-ink2'}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'map' && (
        <div className="flex gap-6">
          <div className="min-w-0 flex-1">
            <div className="mb-3 flex items-center gap-4">
              <button className="focus-ring cursor-pointer text-sm text-accent hover:underline" onClick={() => openOverlay({ kind: 'drawer', id: 'edit-point', templateId: template.id, blockId: block.id })}>{t('templates.addPoint')}</button>
              <button className="focus-ring cursor-pointer text-sm text-ink2 hover:underline" onClick={() => openOverlay({ kind: 'screen', id: 'import-registers', templateId: template.id })}>{t('templates.importCsv')}</button>
              <div className="flex-1" />
              <div className="w-48"><TextInput className="h-8" placeholder={t('templates.search')} value={search} onChange={(e) => setSearch(e.target.value)} /></div>
            </div>
            <DataTable columns={cols} rows={points} rowKey={(p) => p.id} onRowClick={(p) => setSelectedPoint(p.id)} selectedKey={detail?.id ?? null} maxHeight={460} />
          </div>
          {detail ? (
            <PointPropertyInspector
              key={detail.id}
              point={detail}
              template={template}
              block={block}
              onSave={handleSavePoint}
              onDelete={deletePoint}
              onOpenDrawer={() =>
                openOverlay({
                  kind: 'drawer',
                  id: 'edit-point',
                  templateId: template.id,
                  blockId: block.id,
                  pointId: detail.id,
                })
              }
            />
          ) : (
            <aside className="w-[330px] shrink-0 rounded-card bg-surface2 p-5 self-start">
              <div className="text-sm font-bold mb-2">{t('templates.mappingDetail')}</div>
              <div className="text-xs text-ink2">{t('templates.selectPointHint')}</div>
            </aside>
          )}
        </div>
      )}
      {tab === 'memory' && <BlockMemoryLayout key={block.id} block={block} points={template.points} onSelect={id=>{setSelectedPoint(id);setTab('map');}}/>}
      {tab === 'block' && (
        <div className="max-w-xl flex flex-col gap-4">
          <label className="block"><div className="text-xs text-ink2 mb-1.5">{t('templates.name')}</div><TextInput value={block.name} onChange={(e) => void command({ type: 'template.patchBlock', templateId: template.id, blockId: block.id, patch: { name: e.target.value } })} /></label>
          <div className="grid grid-cols-3 gap-4">
            <label className="block"><div className="text-xs text-ink2 mb-1.5">{t('templates.startAddress')}</div><TextInput type="number" value={String(block.start)} onChange={(e) => void command({ type: 'template.patchBlock', templateId: template.id, blockId: block.id, patch: { start: Number(e.target.value) } })} /></label>
            <label className="block"><div className="text-xs text-ink2 mb-1.5">{t('templates.length')}</div><TextInput type="number" value={String(block.length)} onChange={(e) => void command({ type: 'template.patchBlock', templateId: template.id, blockId: block.id, patch: { length: Number(e.target.value) } })} /></label>
            <label className="block"><div className="text-xs text-ink2 mb-1.5">{t('templates.period')}</div><Select value={String(block.periodMs)} onChange={(v) => void command({ type: 'template.patchBlock', templateId: template.id, blockId: block.id, patch: { periodMs: Number(v) } })} options={[{ value: '50', label: '50 ms' }, { value: '100', label: '100 ms' }, { value: '200', label: '200 ms' }, { value: '500', label: '500 ms' }, { value: '1000', label: '1000 ms' }]} /></label>
          </div>
          <InfoBand tone="blue">{t('templates.calcRange', { start: block.start, end: block.start + block.length - 1, n: block.length })}</InfoBand>
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
  const { t } = useTranslation();
  const workspace = useWorkspace();
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
          address: plc ? plc.address : rawAddr.trim() === '' ? NaN : Number(rawAddr),
          area: plc?.area,
          name: idx('name') >= 0 ? (r[idx('name')] ?? '') : rawAddr,
          type: idx('type') >= 0 ? (r[idx('type')] ?? '') : 'UInt16',
          access: idx('access') >= 0 ? (r[idx('access')] ?? '') : 'R',
          unit: idx('unit') >= 0 ? (r[idx('unit')] ?? '') : '',
          scale: idx('scale') >= 0 ? (r[idx('scale')] ?? '') : '1',
          offset: idx('offset') >= 0 ? (r[idx('offset')] ?? '') : '0',
        } as ImportRow & { area?: 1 | 2 | 3 | 4 };
      })
      ;
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

  const preview = useMemo(() => {
    try { return { plan: buildImportPlan(parsed, blockStrategy, 'preview'), error: '' }; }
    catch (error) { return { plan: null, error: String(error) }; }
  }, [parsed, blockStrategy]);

  const doImport = async () => {
    if (!workspace) return;
    const template = workspace.templates.find((t) => t.id === props.templateId);
    if (!template) return;
    let blocks: BlockDef[];
    let points: PointDef[];
    try {
      ({ blocks, points } = buildImportPlan(parsed, blockStrategy, `import-${Date.now().toString(36)}`));
    } catch (error) {
      toast({ kind: 'error', title: t('templates.importBlockedTitle'), message: String(error) });
      return;
    }
    const nextBlocks = [...template.blocks, ...blocks];
    if (findBlockOverlaps(nextBlocks).length) {
      toast({ kind: 'error', title: t('templates.importBlockedTitle'), message: t('templates.importBlockedMessage') });
      return;
    }
    if (!(await command({ type: 'template.importContent', templateId: template.id, blocks, points })).ok) return;
    toast({ kind: 'success', title: t('templates.importedToast', { n: points.length }) });
    closeOverlay();
  };

  return (
    <>
      <PageHeader title={t('templates.importTitle')} subtitle={t('templates.importSubtitle')} actions={<Button onClick={() => closeOverlay()}>{t('templates.cancel')}</Button>} />
      <div className="flex items-center gap-8 border-b border-line mb-5 text-sm">
        <span className={table ? 'text-ink2' : 'text-accent font-medium'}>{t('templates.stepSource')}</span>
        <span className={table ? 'text-accent font-medium' : 'text-ink2'}>{t('templates.stepMapping')}</span>
        <span className="text-ink2">{t('templates.stepPreview')}</span>
      </div>
      <InfoBand className="mb-5 flex items-center justify-between">
        <div>
          <div className="text-xs text-ink2 mb-1">{t('templates.source')}</div>
          <div className="text-sm mono">{table?.sourceLabel ?? t('templates.noFileSelected')}</div>
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
            {t('templates.changeFile')}
          </Button>
          <Button
            size="sm"
            onClick={async () => {
              const text = await navigator.clipboard.readText();
              const parse = await command<{ columns: string[]; rows: string[][]; sourceLabel: string }>({ type: 'import.parse', source: { kind: 'text', text, format: 'clipboard' } });
              if (parse.ok) setTable(parse.value);
            }}
          >
            {t('templates.pasteTable')}
          </Button>
        </div>
      </InfoBand>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <div>
          <div className="text-sm font-bold mb-3">{t('templates.fieldMapping')}</div>
          <div className="rounded-card border border-line bg-surface p-4">
            <div className="grid grid-cols-2 gap-2 pb-2 text-xs text-ink2"><span>{t('templates.sourceColumn')}</span><span>{t('templates.targetField')}</span></div>
            {(table?.columns ?? ['Address', 'Name', 'Type', 'Access', 'Unit', 'Scale', 'Offset']).map((col) => (
              <div key={col} className="grid grid-cols-2 items-center gap-2 border-t border-[#E7EAEE] py-2">
                <span className="text-sm">{col}</span>
                <Select value={mapping[col] ?? ''} onChange={(v) => setMapping({ ...mapping, [col]: v })} options={[{ value: '', label: '—' }, ...targetFields.map((f) => ({ value: f, label: f }))]} />
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="text-sm font-bold mb-3">{t('templates.previewTitle')}</div>
          <div className="rounded-card border border-line bg-surface p-4">
            {plcDetected.length ? (
              <div className="mb-3 rounded-ctl bg-[#FDF3E7] px-3 py-2 text-xs text-warn">
                {t('templates.plcDetected')}
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
            <div className="mt-3 text-xs text-ok">{preview.error || `✓ ${preview.plan?.points.length ?? 0} 行可导入`}</div>
            <div className="mt-1 text-xs text-ink2">{t('templates.convertedZeroBased')}</div>
          </div>
        </div>
      </div>
      <div className="text-sm font-bold mt-6 mb-3">{t('templates.blockStrategy')}</div>
      <InfoBand>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" checked={blockStrategy === 'auto'} onChange={() => setBlockStrategy('auto')} className="accent-[#0078D4]" />
          {t('templates.strategyAuto')}
        </label>
        <label className="flex items-center gap-2 text-sm mt-2">
          <input type="radio" checked={blockStrategy === 'single'} onChange={() => setBlockStrategy('single')} className="accent-[#0078D4]" />
          {t('templates.strategySingle')}
        </label>
        <div className="text-xs mt-3">
          {t('templates.suggestLabel')}{preview.plan?.blocks.map(b => `${AREAS[b.area]} ${b.start}–${b.start + b.length - 1}`).join(' · ') || '—'}
          <br />
          {t('templates.importTargetLabel')}{workspace?.templates.find((tpl) => tpl.id === props.templateId)?.name}{t('templates.importTargetSuffix')}
        </div>
      </InfoBand>
      <div className="sticky bottom-0 z-20 mt-6 flex items-center justify-between border-t border-line bg-surface py-3">
        <span className="text-xs text-ink2">{t('templates.supportedFormats')}</span>
        <Button variant="primary" disabled={!preview.plan} onClick={() => void doImport()}>{t('templates.importPoints', { n: parsed.length })}</Button>
      </div>
    </>
  );
}

export { toPlcReference };
