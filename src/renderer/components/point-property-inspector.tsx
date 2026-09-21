import React, { useEffect, useState } from 'react';
import type { BlockDef, DeviceTemplate, PointDef } from '../../domain/model';
import { registersForType, type RawType } from '../../domain/mapping';
import { useTranslation } from '../i18n';
import { Button, Checkbox, Field, InfoBand, Select, TextInput } from './ui';

export interface PointPropertyInspectorProps {
  point: PointDef;
  template: DeviceTemplate;
  block: BlockDef;
  onSave: (updated: PointDef) => Promise<boolean>;
  onDelete: (point: PointDef) => void;
  onOpenDrawer: () => void;
}

export function PointPropertyInspector({
  point,
  template,
  block,
  onSave,
  onDelete,
  onOpenDrawer,
}: PointPropertyInspectorProps) {
  const { t } = useTranslation();

  const [name, setName] = useState(point.name);
  const [rawType, setRawType] = useState<RawType>(point.mapping.rawType);
  const [offset, setOffset] = useState(String(point.mapping.offset));
  const [bitOffset, setBitOffset] = useState(String(point.mapping.bitOffset ?? 0));
  const [bitWidth, setBitWidth] = useState(String(point.mapping.bitWidth ?? 1));
  const [access, setAccess] = useState<'ro' | 'rw'>(point.access);
  const [unit, setUnit] = useState(point.unit ?? '');
  const [format, setFormat] = useState(point.displayFormat ?? 'auto');
  const [scale, setScale] = useState(String(point.scale ?? 1));
  const [offsetEng, setOffsetEng] = useState(String(point.offset ?? 0));
  const [wordOrder, setWordOrder] = useState(point.mapping.wordOrder ?? 'ABCD');
  const [encoding, setEncoding] = useState(point.mapping.stringEncoding ?? 'ascii');
  const [strLen, setStrLen] = useState(String(point.mapping.stringLength ?? 8));
  const [enumText, setEnumText] = useState(
    Object.entries(point.enumMap ?? {}).map(([k, v]) => `${k}=${v}`).join(', ')
  );
  const [highRisk, setHighRisk] = useState(point.highRisk ?? false);
  const [description, setDescription] = useState(point.description ?? '');
  const [showAdvanced, setShowAdvanced] = useState(
    point.mapping.wordOrder !== 'ABCD' ||
    Boolean(point.enumMap && Object.keys(point.enumMap).length) ||
    point.mapping.rawType === 'String' ||
    Boolean(point.highRisk)
  );
  const [saving, setSaving] = useState(false);

  // Sync draft when selected point changes
  useEffect(() => {
    setName(point.name);
    setRawType(point.mapping.rawType);
    setOffset(String(point.mapping.offset));
    setBitOffset(String(point.mapping.bitOffset ?? 0));
    setBitWidth(String(point.mapping.bitWidth ?? 1));
    setAccess(point.access);
    setUnit(point.unit ?? '');
    setFormat(point.displayFormat ?? 'auto');
    setScale(String(point.scale ?? 1));
    setOffsetEng(String(point.offset ?? 0));
    setWordOrder(point.mapping.wordOrder ?? 'ABCD');
    setEncoding(point.mapping.stringEncoding ?? 'ascii');
    setStrLen(String(point.mapping.stringLength ?? 8));
    setEnumText(Object.entries(point.enumMap ?? {}).map(([k, v]) => `${k}=${v}`).join(', '));
    setHighRisk(point.highRisk ?? false);
    setDescription(point.description ?? '');
    setShowAdvanced(
      point.mapping.wordOrder !== 'ABCD' ||
      Boolean(point.enumMap && Object.keys(point.enumMap).length) ||
      point.mapping.rawType === 'String' ||
      Boolean(point.highRisk)
    );
  }, [point]);

  const offsetNum = Math.max(0, parseInt(offset, 10) || 0);
  const strLenNum = Math.max(1, parseInt(strLen, 10) || 1);
  const regCount = rawType === 'String' ? Math.max(1, Math.ceil(strLenNum / 2)) : registersForType(rawType, strLenNum);

  const isNumeric = !['Bool', 'String'].includes(rawType);
  const showScale = isNumeric && !enumText.trim();
  const scaleNum = Number(scale) || 1;
  const offsetEngNum = Number(offsetEng) || 0;

  const isDirty =
    name !== point.name ||
    rawType !== point.mapping.rawType ||
    offset !== String(point.mapping.offset) ||
    bitOffset !== String(point.mapping.bitOffset ?? 0) ||
    bitWidth !== String(point.mapping.bitWidth ?? 1) ||
    access !== point.access ||
    unit !== (point.unit ?? '') ||
    format !== (point.displayFormat ?? 'auto') ||
    scale !== String(point.scale ?? 1) ||
    offsetEng !== String(point.offset ?? 0) ||
    wordOrder !== (point.mapping.wordOrder ?? 'ABCD') ||
    encoding !== (point.mapping.stringEncoding ?? 'ascii') ||
    strLen !== String(point.mapping.stringLength ?? 8) ||
    highRisk !== (point.highRisk ?? false) ||
    description !== (point.description ?? '') ||
    enumText !== Object.entries(point.enumMap ?? {}).map(([k, v]) => `${k}=${v}`).join(', ');

  const shared = template.points.filter(
    (p) =>
      p.id !== point.id &&
      p.blockId === block.id &&
      p.mapping.offset < offsetNum + regCount &&
      offsetNum < p.mapping.offset + p.mapping.registerCount
  );

  const exceedsBlock = offsetNum + regCount > block.length;

  const handleSave = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (saving) return;

    const parsedEnum: Record<string, string> = Object.fromEntries(
      enumText
        .split(/[,;\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((pair) => {
          const [k, v] = pair.split('=');
          return [k?.trim() ?? '', v?.trim() ?? ''] as [string, string];
        })
        .filter(([k]) => k.length > 0)
    );

    const updated: PointDef = {
      ...point,
      name: name.trim() || point.name,
      mapping: {
        rawType,
        offset: offsetNum,
        registerCount: regCount,
        wordOrder,
        byteSelector: point.mapping.byteSelector ?? 'low',
        bitOffset: Math.max(0, Math.min(15, parseInt(bitOffset, 10) || 0)),
        bitWidth: Math.max(1, Math.min(16, parseInt(bitWidth, 10) || 1)),
        stringLength: strLenNum,
        stringEncoding: encoding,
      },
      scale: scaleNum,
      offset: offsetEngNum,
      unit: unit.trim(),
      access: (block.area === 2 || block.area === 4) ? 'ro' : access,
      displayFormat: format,
      enumMap: parsedEnum,
      highRisk,
      description: description.trim(),
    };

    setSaving(true);
    try {
      await onSave(updated);
    } finally {
      setSaving(false);
    }
  };

  return (
    <aside className="w-[330px] shrink-0 rounded-card bg-surface2 p-4 self-start max-h-[calc(100vh-200px)] overflow-y-auto">
      <div className="flex items-center justify-between mb-3 border-b border-line pb-2.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-ink">{t('templates.pointInspectorTitle')}</span>
          <span className="text-[11px] font-normal text-ink2 bg-surface px-1.5 py-0.5 rounded border border-line">
            {t('templates.mappingDetail')}
          </span>
        </div>
        {isDirty ? (
          <span className="text-xs text-accent font-medium">• {t('templates.unsavedTag')}</span>
        ) : (
          <span className="text-xs text-ink2 mono">ID: {point.id.slice(-6)}</span>
        )}
      </div>

      <form onSubmit={handleSave} className="space-y-3 text-xs">
        {/* Basic Information */}
        <Field label={t('templates.name')}>
          <TextInput
            className="h-8 text-xs"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如: 母线电压"
          />
        </Field>

        {/* Memory Mapping Row 1 */}
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('overlays.registerOffset')}>
            <TextInput
              className="h-8 text-xs font-mono"
              type="number"
              min={0}
              value={offset}
              onChange={(e) => setOffset(e.target.value)}
            />
          </Field>
          <Field label={t('overlays.dataType')}>
            <Select
              value={rawType}
              onChange={(v) => setRawType(v as RawType)}
              options={['Bool', 'BitField', 'Int8', 'UInt8', 'Int16', 'UInt16', 'Int32', 'UInt32', 'Float32', 'Float64', 'String'].map((t) => ({ value: t, label: t }))}
            />
          </Field>
        </div>

        {/* Memory Footprint Badge & Alert */}
        <div className="rounded border border-line bg-surface p-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-ink2">{t('templates.detailMemory')}</span>
            <span className="mono font-semibold text-accent">
              +{offsetNum}{regCount > 1 ? `..+${offsetNum + regCount - 1}` : ''} ({t('templates.registersUnit', { n: regCount })})
            </span>
          </div>
          {exceedsBlock ? (
            <div className="mt-1 text-[11px] text-err font-medium">
              ⚠️ 偏移超出数据块长度（块长度: {block.length}）
            </div>
          ) : null}
          {shared.length > 0 ? (
            <div className="mt-1 text-[11px] text-ink2">
              💡 {t('templates.sharedRegistersCount', { count: shared.length })}
            </div>
          ) : (
            <div className="mt-1 text-[11px] text-ink2/70">
              ✓ {t('templates.exclusiveRegisters')}
            </div>
          )}
        </div>

        {/* Bit Offset & Width for Bool/BitField */}
        {(rawType === 'Bool' || rawType === 'BitField') && (
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('overlays.bitOffset')}>
              <TextInput
                className="h-8 text-xs font-mono"
                type="number"
                min={0}
                max={15}
                value={bitOffset}
                onChange={(e) => setBitOffset(e.target.value)}
              />
            </Field>
            <Field label={t('overlays.bitWidth')}>
              <TextInput
                className="h-8 text-xs font-mono"
                type="number"
                min={1}
                max={16}
                value={bitWidth}
                onChange={(e) => setBitWidth(e.target.value)}
                disabled={rawType !== 'BitField'}
              />
            </Field>
          </div>
        )}

        {/* Access and Unit */}
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('templates.colAccess')}>
            <Select
              value={access}
              onChange={(v) => setAccess(v as 'ro' | 'rw')}
              options={[
                { value: 'ro', label: t('templates.accessRo') },
                { value: 'rw', label: t('templates.accessRw') },
              ]}
              disabled={block.area === 2 || block.area === 4}
            />
          </Field>
          <Field label={t('templates.colUnit')}>
            <TextInput
              className="h-8 text-xs"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              placeholder="℃, V, A, %"
            />
          </Field>
        </div>

        {/* Scaling and Display Section */}
        <div className="border-t border-line pt-2">
          <div className="text-xs font-medium text-ink mb-1.5">{t('templates.scalingAndDisplay')}</div>
          <div className="grid grid-cols-2 gap-2 mb-2">
            <Field label={t('overlays.format')}>
              <Select
                value={format}
                onChange={(v) => setFormat(v as typeof format)}
                options={[
                  { value: 'auto', label: t('overlays.formatDec') },
                  { value: 'hex', label: t('overlays.formatHex') },
                  { value: 'binary', label: t('overlays.formatBin') },
                ]}
              />
            </Field>
            {showScale && (
              <Field label={t('overlays.scaleFactor')}>
                <TextInput
                  className="h-8 text-xs font-mono"
                  type="number"
                  step="any"
                  value={scale}
                  onChange={(e) => setScale(e.target.value)}
                />
              </Field>
            )}
          </div>

          {showScale && (
            <>
              <div className="mb-2">
                <Field label={t('overlays.offsetAmount')}>
                  <TextInput
                    className="h-8 text-xs font-mono"
                    type="number"
                    step="any"
                    value={offsetEng}
                    onChange={(e) => setOffsetEng(e.target.value)}
                  />
                </Field>
              </div>
              <InfoBand tone="blue" className="py-2 px-3 text-[11px]">
                <div className="text-accent font-mono font-medium">
                  {t('templates.formulaDisplay', { scale: String(scaleNum), offset: String(offsetEngNum) })}
                </div>
              </InfoBand>
            </>
          )}
        </div>

        {/* Advanced Settings (Collapsible) */}
        <div className="border-t border-line pt-2">
          <button
            type="button"
            className="flex items-center justify-between w-full text-xs font-medium text-ink2 hover:text-ink cursor-pointer py-1"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            <span>{t('templates.advancedSettings')}</span>
            <span className="mono">{showAdvanced ? '▼' : '▶'}</span>
          </button>

          {showAdvanced && (
            <div className="space-y-2 mt-2">
              <div className="grid grid-cols-2 gap-2">
                <Field label={t('overlays.wordOrder')}>
                  <Select
                    value={wordOrder}
                    onChange={(v) => setWordOrder(v as typeof wordOrder)}
                    options={['ABCD', 'CDAB', 'BADC', 'DCBA'].map((w) => ({ value: w, label: w }))}
                  />
                </Field>
                {rawType === 'String' ? (
                  <Field label={t('overlays.encoding')}>
                    <Select
                      value={encoding}
                      onChange={(v) => setEncoding(v as typeof encoding)}
                      options={[
                        { value: 'ascii', label: 'ASCII' },
                        { value: 'utf8', label: 'UTF-8' },
                      ]}
                    />
                  </Field>
                ) : (
                  <Field label={t('templates.colDesc')}>
                    <TextInput
                      className="h-8 text-xs"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="备注说明"
                    />
                  </Field>
                )}
              </div>

              {rawType === 'String' && (
                <Field label={t('overlays.stringLength')}>
                  <TextInput
                    className="h-8 text-xs font-mono"
                    type="number"
                    min={1}
                    value={strLen}
                    onChange={(e) => setStrLen(e.target.value)}
                  />
                </Field>
              )}

              <Field label={t('overlays.enumTable')}>
                <TextInput
                  className="h-8 text-xs"
                  value={enumText}
                  onChange={(e) => setEnumText(e.target.value)}
                  placeholder="0=关, 1=开, 2=报警"
                />
              </Field>

              <div className="pt-1">
                <Checkbox
                  checked={highRisk}
                  onCheckedChange={setHighRisk}
                  label={t('overlays.highRiskConfirm')}
                />
              </div>
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="pt-3 border-t border-line flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              className="flex-1"
              disabled={saving}
            >
              {saving ? '保存中...' : t('templates.savePoint')}
            </Button>
            <Button
              type="button"
              variant="danger"
              size="sm"
              onClick={() => onDelete(point)}
              disabled={saving}
            >
              {t('templates.deletePoint')}
            </Button>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="w-full"
            onClick={onOpenDrawer}
          >
            {t('templates.editPoint')}
          </Button>
        </div>
      </form>
    </aside>
  );
}
