import { useState } from 'react';
import { useApp, useWorkspace } from '../../store/app';
import { Button, Checkbox, Dialog, Field, InfoBand, Select, TextInput } from '../../components/ui';
import { useTranslation } from '../../i18n';
import { uid } from '../../uid';
import { templateSchema } from '../../../domain/model';

export function AddSlaveDialog(props: { connectionId: string; slaveId?: string; unitId?: number }) {
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
  const [name, setName] = useState(existing?.name ?? t('overlays.slaveDefaultName', { unit: String(props.unitId ?? nextUnit) }));
  const [unit, setUnit] = useState(String(existing?.unitId ?? props.unitId ?? nextUnit));
  const [templateId, setTemplateId] = useState(existing?.templateId ?? workspace?.templates[0]?.id ?? '');
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const conn = workspace?.connections.find((c) => c.id === props.connectionId);
  const template = workspace?.templates.find((t) => t.id === templateId);
  const local = conn?.role === 'slave';
  const conflict = workspace?.slaves.some((s) => s.connectionId === props.connectionId && s.unitId === Number(unit) && s.id !== props.slaveId);
  const validUnit = unit.trim() !== '' && Number.isInteger(Number(unit)) && Number(unit) >= 1 && Number(unit) <= 247;

  const save = async () => {
    if (!workspace || !validUnit || conflict || !name.trim()) return;
    if (existing) {
      if (!(await command({ type: 'slave.upsert', slave: { ...existing, name, unitId: Number(unit), templateId, enabled } })).ok) return;
    } else {
      if (!(await command({ type: 'slave.upsert', slave: { id: uid('slave'), connectionId: props.connectionId, unitId: Number(unit), name, templateId, enabled } })).ok) return;
    }
    close();
  };

  return (
    <Dialog title={existing ? t('overlays.editSlaveTitle') : t('overlays.addSlaveTitle')} subtitle={conn?.name ?? ''} width={660} onClose={close} footer={<><Button onClick={close}>{t('overlays.cancel')}</Button><Button variant="primary" disabled={conflict || !validUnit || !name.trim()} onClick={() => void save()}>{existing ? t('overlays.saveSlave') : t('overlays.addSlaveTitle')}</Button></>}>
      <Field label={t('overlays.fieldOwnerConn')}><TextInput readOnly value={`${conn?.name ?? ''} · ${conn?.transport === 'rtu' ? `${conn.rtu?.baudRate} ${conn.rtu?.dataBits}${conn.rtu?.parity.charAt(0).toUpperCase()}${conn.rtu?.stopBits}` : conn?.tcp?.host}`} /></Field>
      <div className="mt-4 grid grid-cols-2 gap-4">
        <Field label={t('overlays.fieldDeviceName')}><TextInput value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={t('overlays.fieldSlaveAddr')}><TextInput type="number" min={1} max={247} step={1} aria-invalid={!validUnit || conflict} value={unit} onChange={(e) => setUnit(e.target.value)} /></Field>
      </div>
      <div className="mt-4">
        <div className="text-xs text-ink2 mb-1.5">{t('overlays.deviceTemplate')}</div>
        <Select value={templateId} onChange={setTemplateId} options={[{ value: '', label: t('overlays.noTemplateOption') }, ...(workspace?.templates.map((t) => ({ value: t.id, label: t.name })) ?? [])]} />
        {local ? <div className="mt-3"><Button size="sm" onClick={async () => {
          const id = uid('tpl');
          const names = [t('slave.coil'), t('slave.discrete'), t('slave.holding'), t('slave.input')];
          const created = templateSchema.parse({ id, name: t('slave.basicTemplateName', { name }),
            blocks: names.map((label, index) => ({ id: `${id}-b${index}`, name: label, area: index + 1, start: 0, length: 16, periodMs: 500 })),
            points: names.flatMap((label, index) => Array.from({ length: 16 }, (_, offset) => ({ id: `${id}-p${index}-${offset}`, blockId: `${id}-b${index}`, name: `${label} ${offset}`,
              mapping: { rawType: index <= 1 ? 'Bool' : 'UInt16', offset, registerCount: 1, wordOrder: 'ABCD', byteSelector: 'low', bitOffset: 0, bitWidth: 1, stringLength: 0, stringEncoding: 'ascii' }, access: index === 0 || index === 2 ? 'rw' : 'ro' }))) });
          if ((await command({ type: 'template.add', template: created })).ok) setTemplateId(id);
        }}>{t('slave.basicTemplate')}</Button><p className="mt-1 text-xs text-ink2">{t('slave.basicTemplateHint')}</p></div> : null}
      </div>
      {templateId === '' ? (
        <InfoBand tone="blue" className="mt-3">{local ? t('slave.noTemplate') : t('overlays.noTemplateHint')}</InfoBand>
      ) : template ? (
        <div className="mt-3 rounded-card bg-surface2 p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-bold">{template.name}</span>
            <span className="flex gap-4 text-xs text-accent">
              <button className="focus-ring cursor-pointer hover:underline" onClick={() => { select({ templateId: template.id }); setModule('templates'); close(); }}>{t('overlays.viewTemplate')}</button>
              <button className="focus-ring cursor-pointer hover:underline" onClick={async () => {
                if (!workspace) return;
                const newId = uid('tpl');
                if (!(await command({ type: 'template.copy', sourceTemplateId: template.id, newId, name: t('overlays.templateCopyName', { name: template.name }) })).ok) return;
                setTemplateId(newId);
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
          <Checkbox checked={enabled} onCheckedChange={setEnabled} label={local ? t('slave.enabled') : t('overlays.enableSlave')} />
        </div>
        <div>
          <div className="text-xs text-ink2 mb-1.5">{t('overlays.addrConflictCheck')}</div>
          <div role={!validUnit || conflict ? 'alert' : undefined} className={`rounded-ctl border px-3 py-2 text-xs ${!validUnit || conflict ? 'border-err text-err' : 'border-line text-ok'}`}>{!validUnit ? t('slave.invalidUnit') : conflict ? t('overlays.unitTaken', { unit }) : t('overlays.unitFree', { unit })}</div>
        </div>
      </div>
      <InfoBand tone="blue" className="mt-4">{local ? t('slave.addHint') : t('overlays.copyTemplateHint')}</InfoBand>
    </Dialog>
  );
}
