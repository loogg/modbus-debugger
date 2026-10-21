import { useMemo, useState } from 'react';
import { useApp, useBlocks, useWorkspace } from '../../store/app';
import { Button, EmptyState, Field, InfoBand, PageHeader, Select, TextInput } from '../../components/ui';
import { AREAS } from '../../../domain/address';
import { useTranslation } from '../../i18n';

const PAGE_SIZE = 32;

function MemoryRow(props: { address: number; value: number | undefined; bits: boolean; disabled: boolean; onApply(value: number): Promise<boolean> }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const apply = async () => {
    if (busy || props.disabled) return;
    const value = Number(draft);
    if (!/^(?:\d+|0x[\da-f]+)$/i.test(draft.trim()) || !Number.isInteger(value) || value < 0 || value > (props.bits ? 1 : 65535)) { setError(true); return; }
    setBusy(true);
    if (await props.onApply(value)) setDraft('');
    setBusy(false);
  };
  return <tr className="border-t border-line">
    <td className="sticky left-0 bg-surface px-4 py-2 mono text-xs">{props.address}</td>
    <td className="px-4 py-2 mono text-sm" data-testid={`slave-value-${props.address}`}>{props.value ?? '—'}</td>
    <td className="px-4 py-2 mono text-xs text-ink2">{props.value === undefined ? '—' : `0x${props.value.toString(16).toUpperCase().padStart(props.bits ? 1 : 4, '0')}`}</td>
    <td className="px-4 py-2"><TextInput aria-label={t('slave.valueLabel', { address: props.address })} aria-invalid={error} title={error ? t('slave.invalidValue') : undefined} className={`h-8 w-36 ${error ? 'border-err' : ''}`} placeholder={props.bits ? '0 / 1' : '0–65535 / 0xFFFF'} disabled={props.disabled || busy} value={draft} onChange={event => { setDraft(event.target.value); setError(false); }} onKeyDown={event => { if (event.key === 'Enter') void apply(); }} />{error ? <div role="alert" className="mt-1 max-w-60 text-xs text-err">{t('slave.invalidValue')}</div> : null}</td>
    <td className="px-4 py-2"><Button size="sm" disabled={props.disabled || busy || !draft.trim()} onClick={() => void apply()}>{t('slave.apply')}</Button></td>
  </tr>;
}

export function SlaveMemoryView(props: { slaveId: string }) {
  const { t } = useTranslation();
  const workspace = useWorkspace();
  const blocks = useBlocks();
  const command = useApp(state => state.command);
  const select = useApp(state => state.select);
  const toast = useApp(state => state.toast);
  const slave = workspace?.slaves.find(item => item.id === props.slaveId);
  const template = workspace?.templates.find(item => item.id === slave?.templateId);
  const [blockId, setBlockId] = useState(template?.blocks[0]?.id ?? '');
  const [page, setPage] = useState(0);
  const [saving, setSaving] = useState(false);
  const block = template?.blocks.find(item => item.id === blockId) ?? template?.blocks[0];
  const state = slave && block ? blocks[`${slave.id}::${block.id}`] : undefined;
  const values = state?.registers ?? state?.bits?.map(Number);
  const currentPage = block ? Math.min(page, Math.max(0, Math.ceil(block.length / PAGE_SIZE) - 1)) : 0;
  const offsets = useMemo(() => Array.from({ length: Math.min(PAGE_SIZE, (block?.length ?? 0) - currentPage * PAGE_SIZE) }, (_, index) => currentPage * PAGE_SIZE + index), [block?.length, currentPage]);
  if (!slave) return null;
  return <>
    <PageHeader title={t('slave.memoryTitle')} subtitle={t('slave.memorySubtitle', { unit: slave.unitId, name: slave.name })} actions={<>
      <Button onClick={() => select({ deviceView: 'topology' })}>{t('slave.backDevice')}</Button>
      <Button variant="primary" disabled={!block || saving} onClick={async () => { setSaving(true); const result = await command({ type: 'slave.saveInitialValues', slaveId: slave.id }); setSaving(false); if (result.ok) toast({ kind: 'success', title: t('slave.savedInitial'), message: t('slave.savedInitialMessage') }); }}>{t('slave.saveInitial')}</Button>
    </>} />
    <InfoBand tone="blue"><p>{t('slave.memoryHint')}</p><p className="mt-1 text-xs text-ink2">{t('slave.memoryLifecycle')}</p></InfoBand>
    {!block ? <EmptyState title={t('slave.empty')} message={t('slave.emptyHint')} /> : <>
      <div className="my-4 max-w-xl"><Field label={t('slave.area')}><Select value={block.id} onChange={value => { setBlockId(value); setPage(0); }} options={template!.blocks.map(item => ({ value: item.id, label: `${item.name} · ${AREAS[item.area]} · ${item.start}–${item.start + item.length - 1}` }))} /></Field></div>
      <div className="overflow-auto rounded-card border border-line bg-surface" style={{ maxHeight: 'calc(100vh - 410px)', minHeight: 180 }}>
        <table className="w-full min-w-[620px] text-left"><thead className="sticky top-0 z-20 bg-surface2 text-xs text-ink2"><tr>
          <th className="sticky left-0 bg-surface2 px-4 py-3 font-medium">{t('slave.address')}</th><th className="px-4 py-3 font-medium">{t('slave.confirmed')}</th><th className="px-4 py-3 font-medium">Hex</th><th className="px-4 py-3 font-medium">{t('slave.editValue')}</th><th className="px-4 py-3 font-medium">{t('devices.colActions')}</th>
        </tr></thead><tbody>{offsets.map(offset => <MemoryRow key={`${slave.id}:${block.id}:${offset}`} address={block.start + offset} value={values?.[offset]} bits={block.area <= 2} disabled={!slave.enabled} onApply={async value => {
          const result = await command({ type: 'slave.setValues', slaveId: slave.id, blockId: block.id, offset, values: [value] });
          if (result.ok) toast({ kind: 'success', title: t('slave.applied') });
          return result.ok;
        }} />)}</tbody></table>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3"><span className="text-xs text-ink2">{t('slave.page', { start: currentPage * PAGE_SIZE + 1, end: Math.min((currentPage + 1) * PAGE_SIZE, block.length), total: block.length })}</span><div className="flex gap-2"><Button size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t('slave.previous')}</Button><Button size="sm" disabled={(currentPage + 1) * PAGE_SIZE >= block.length} onClick={() => setPage(currentPage + 1)}>{t('slave.next')}</Button></div></div>
    </>}
  </>;
}
