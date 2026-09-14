import React from 'react';
import { useApp, useHistoryDbPath, usePrefs, useSnapshotReady, useWorkspace, useWorkspacePath } from '../store/app';
import { Button, Checkbox, InfoBand, PageHeader, SectionTitle, Select, StatusDot, TextInput } from '../components/ui';
import { TIMEZONE_OPTIONS, fmtDateTime } from '../time';
import { LANGUAGE_OPTIONS, useTranslation } from '../i18n';

export function SettingsScreen() {
  const { t } = useTranslation();
  const ready = useSnapshotReady();
  const workspace = useWorkspace();
  const prefsSlice = usePrefs();
  const workspacePath = useWorkspacePath();
  const historyDbPath = useHistoryDbPath();
  const command = useApp((s) => s.command);
  const toast = useApp((s) => s.toast);
  const openOverlay = useApp((s) => s.openOverlay);
  if (!ready || !workspace || !prefsSlice) return null;
  const prefs = prefsSlice;

  return (
    <>
      <PageHeader title={t('settings.title')} subtitle={t('settings.subtitle')} />
      <SectionTitle id="settings-workspace">{t('settings.workspaceFile')}</SectionTitle>
      <InfoBand className="flex items-center justify-between">
        <div>
          <div className="text-xs text-ink2 mb-1">{t('settings.currentWorkspace')}</div>
          <div className="text-sm">{workspacePath ? workspacePath.split(/[\\/]/).slice(-1)[0] : t('settings.unsaved', { name: workspace.name })}</div>
        </div>
        <StatusDot tone="ok" label={t('settings.autosaveOn')} />
        <Button size="sm" onClick={async () => {
          const res = await command<string>({ type: 'dialog.saveFile', defaultName: 'workspace.workspace.json' });
          if (res.ok) await command({ type: 'workspace.saveAs', path: res.value });
        }}>{t('settings.saveAs')}</Button>
      </InfoBand>
      <SectionTitle>{t('settings.importExport')}</SectionTitle>
      <div className="flex gap-3">
        <Button onClick={async () => {
          const res = await command<string>({ type: 'dialog.openFile', accept: ['json'] });
          if (!res.ok) return;
          await command({ type: 'workspace.open', path: res.value });
        }}>{t('settings.importWorkspace')}</Button>
        <Button onClick={async () => {
          const res = await command<string>({ type: 'workspace.export' });
          if (res.ok) {
            await navigator.clipboard.writeText(res.value);
            toast({ kind: 'success', title: t('settings.exportedToast') });
          }
        }}>{t('settings.exportWorkspace')}</Button>
      </div>
      <div className="text-xs text-ink2 mt-3">{t('settings.importExportHint')}</div>

      <SectionTitle id="settings-importCompat">{t('settings.addressRules')}</SectionTitle>
      <InfoBand tone="blue">
        <div className="text-sm font-bold text-accent mb-1">{t('settings.addressZeroBased')}</div>
        <div className="text-sm">{t('settings.addressHint')}</div>
        <div className="text-xs mt-1"><Checkbox checked onCheckedChange={() => undefined} disabled label={t('settings.importCompat')} /></div>
      </InfoBand>

      <SectionTitle id="settings-recordingStorage">{t('settings.recording')}</SectionTitle>
      <InfoBand>
        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          <div>
            <div className="text-xs text-ink2 mb-1">{t('settings.historyDb')}</div>
            <div className="text-sm mono break-all">{historyDbPath}</div>
          </div>
          <div>
            <div className="text-xs text-ink2 mb-1">{t('settings.recordingMode')}</div>
            <div className="text-sm">{t('settings.recordingModeHint')}</div>
            <div className="mt-2"><Checkbox checked={prefs.persistRawComm} onCheckedChange={(v) => void command({ type: 'prefs.set', patch: { persistRawComm: v } })} label={t('settings.persistRaw')} /></div>
          </div>
          <div>
            <div className="text-xs text-ink2 mb-1">{t('settings.retention')}</div>
            <div className="text-sm">{t('settings.retentionHint')}</div>
          </div>
        </div>
      </InfoBand>

      <SectionTitle id="settings-writeSafety">{t('settings.writeSafety')}</SectionTitle>
      <InfoBand className="flex items-start justify-between gap-8">
        <div className="flex flex-col gap-2">
          <Checkbox checked onCheckedChange={() => undefined} disabled label={t('settings.rmwLimit')} />
          <Checkbox checked onCheckedChange={() => undefined} disabled label={t('settings.readBack')} />
        </div>
        <div className="text-xs text-ink2 max-w-md">{t('settings.writeSafetyHint')}</div>
      </InfoBand>

      <SectionTitle id="settings-display">{t('settings.display')}</SectionTitle>
      <InfoBand>
        <div className="grid grid-cols-1 gap-6 md:grid-cols-3 text-sm">
          <div><div className="text-xs text-ink2 mb-1">{t('settings.sidebarWidth')}</div>{prefs.sidebarWidth} {t('settings.sidebarWidthHint')}</div>
          <div><div className="text-xs text-ink2 mb-1">{t('settings.windowMode')}</div>{t('settings.windowModeHint')}</div>
          <div><div className="text-xs text-ink2 mb-1">{t('settings.zoom')}</div>{t('settings.zoomHint')}</div>
        </div>
      </InfoBand>
      <InfoBand>
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 text-sm">
          <div>
            <div className="text-xs text-ink2 mb-1.5">{t('settings.timezone')}</div>
            <Select
              value={prefs.timezone}
              onChange={(v) => void command({ type: 'prefs.set', patch: { timezone: v } })}
              options={TIMEZONE_OPTIONS}
            />
            <div className="text-xs text-ink2 mt-1.5">{t('settings.timezoneHint', { sample: fmtDateTime(new Date().toISOString()) })}</div>
          </div>
          <div>
            <div className="text-xs text-ink2 mb-1.5">{t('settings.language')}</div>
            <Select
              value={prefs.language}
              onChange={(v) => void command({ type: 'prefs.set', patch: { language: v } })}
              options={LANGUAGE_OPTIONS}
            />
            <div className="text-xs text-ink2 mt-1.5">{t('settings.languageHint')}</div>
          </div>
        </div>
      </InfoBand>

      <SectionTitle id="settings-log">{t('settings.log')}</SectionTitle>
      <InfoBand>
        <div className="text-sm">{t('settings.logHint')}</div>
        <Button size="sm" className="mt-3" onClick={() => openOverlay({ kind: 'dialog', id: 'confirm', title: t('settings.clearDiag'), message: t('settings.clearDiagMessage'), confirmLabel: t('settings.clear'), danger: true, onConfirm: () => void command({ type: 'diagnostics.clear' }) })}>{t('settings.clearDiag')}</Button>
      </InfoBand>
      <div className="mt-6">
        <TextInput readOnly value={`workspace schemaVersion=${workspace.schemaVersion}`} className="mono text-xs" />
      </div>
    </>
  );
}
