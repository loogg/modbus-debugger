import React from 'react';
import { useApp, useHistoryDbPath, usePrefs, useSnapshotReady, useWorkspace, useWorkspacePath } from '../store/app';
import { Button, Checkbox, InfoBand, PageHeader, SectionTitle, Select, StatusDot } from '../components/ui';
import { TIMEZONE_OPTIONS, fmtDateTime } from '../time';
import { useTranslation } from '../i18n';

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
  const showError = (title: string, error?: string) => toast({ kind: 'error', title, message: error ?? t('settings.operationFailed') });

  return (
    <>
      <PageHeader title={t('settings.title')} subtitle={t('settings.subtitle')} />
      <SectionTitle id="settings-workspace">{t('settings.workspaceFile')}</SectionTitle>
      <InfoBand className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-ink2 mb-1">{t('settings.currentWorkspace')}</div>
          <div className="break-all text-sm">{workspacePath ? workspacePath.split(/[\\/]/).slice(-1)[0] : t('settings.unsaved', { name: workspace.name })}</div>
        </div>
        <StatusDot tone={workspacePath ? 'ok' : 'idle'} label={workspacePath ? t('settings.autosaveOn') : t('settings.autosavePending')} />
        <Button size="sm" onClick={async () => {
          const res = await command<string>({ type: 'dialog.saveFile', defaultName: 'workspace.workspace.json' });
          if (!res.ok) { if (res.error !== 'cancelled') showError(t('settings.saveAsFailed'), res.error); return; }
          const saved = await command({ type: 'workspace.saveAs', path: res.value });
          if (!saved.ok) { showError(t('settings.saveAsFailed'), saved.error); return; }
          toast({ kind: 'success', title: t('settings.saveAsSuccess') });
        }}>{t('settings.saveAs')}</Button>
      </InfoBand>
      <SectionTitle>{t('settings.importExport')}</SectionTitle>
      <div className="flex gap-3">
        <Button onClick={async () => {
          const res = await command<string>({ type: 'dialog.openFile', accept: ['json'] });
          if (!res.ok) { if (res.error !== 'cancelled') showError(t('settings.importFailed'), res.error); return; }
          const opened = await command({ type: 'workspace.open', path: res.value });
          if (!opened.ok) { showError(t('settings.importFailed'), opened.error); return; }
          toast({ kind: 'success', title: t('settings.importSuccess') });
        }}>{t('settings.importWorkspace')}</Button>
        <Button onClick={async () => {
          const res = await command<string>({ type: 'dialog.saveFile', defaultName: 'workspace.workspace.json' });
          if (!res.ok) { if (res.error !== 'cancelled') showError(t('settings.exportFailed'), res.error); return; }
          const exported = await command({ type: 'workspace.exportFile', path: res.value });
          if (!exported.ok) { showError(t('settings.exportFailed'), exported.error); return; }
          toast({ kind: 'success', title: t('settings.exportSuccess') });
        }}>{t('settings.exportWorkspace')}</Button>
      </div>
      <div className="text-xs text-ink2 mt-3">{t('settings.importExportHint')}</div>

      <SectionTitle id="settings-importCompat">{t('settings.addressRules')}</SectionTitle>
      <InfoBand tone="blue">
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <div className="text-sm font-bold text-accent">{t('settings.addressZeroBased')}</div>
          <StatusDot tone="accent" label={t('settings.builtInRule')} />
        </div>
        <div className="text-sm">{t('settings.addressHint')}</div>
        <div className="mt-2 text-sm">{t('settings.importCompat')}</div>
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
            <div className="mt-2"><Checkbox checked={prefs.persistRawComm} onCheckedChange={(v) => void (async () => {
              const result = await command({ type: 'prefs.set', patch: { persistRawComm: v } });
              if (!result.ok) showError(t('settings.preferenceFailed'), result.error);
            })()} label={t('settings.persistRaw')} /></div>
          </div>
          <div>
            <div className="text-xs text-ink2 mb-1">{t('settings.retention')}</div>
            <div className="text-sm">{t('settings.retentionHint')}</div>
          </div>
        </div>
      </InfoBand>

      <SectionTitle id="settings-writeSafety">{t('settings.writeSafety')}</SectionTitle>
      <InfoBand>
        <div className="mb-3"><StatusDot tone="ok" label={t('settings.builtInFlow')} /></div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <div className="text-sm font-medium">{t('settings.rmwLimit')}</div>
            <div className="mt-1 text-xs text-ink2">{t('settings.rmwDetail')}</div>
          </div>
          <div>
            <div className="text-sm font-medium">{t('settings.readBack')}</div>
            <div className="mt-1 text-xs text-ink2">{t('settings.readBackDetail')}</div>
          </div>
        </div>
        <div className="mt-3 border-t border-line pt-3 text-xs text-ink2">{t('settings.writeSafetyHint')}</div>
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
              onChange={(v) => void (async () => {
                const result = await command({ type: 'prefs.set', patch: { timezone: v } });
                if (!result.ok) showError(t('settings.preferenceFailed'), result.error);
              })()}
              options={TIMEZONE_OPTIONS}
            />
            <div className="text-xs text-ink2 mt-1.5">{t('settings.timezoneHint', { sample: fmtDateTime(new Date().toISOString()) })}</div>
          </div>
          <div>
            <div className="text-xs text-ink2 mb-1.5">{t('settings.language')}</div>
            <div className="text-sm">{t('settings.currentLanguage')}</div>
            <div className="text-xs text-ink2 mt-1.5">{t('settings.languageHint')}</div>
          </div>
        </div>
      </InfoBand>

      <SectionTitle id="settings-log">{t('settings.log')}</SectionTitle>
      <InfoBand>
        <div className="text-sm">{t('settings.logHint')}</div>
        <Button size="sm" className="mt-3" onClick={() => openOverlay({ kind: 'dialog', id: 'confirm', title: t('settings.clearDiag'), message: t('settings.clearDiagMessage'), confirmLabel: t('settings.clear'), danger: true, onConfirm: () => void (async () => {
          const result = await command({ type: 'diagnostics.clear' });
          if (!result.ok) { showError(t('settings.clearDiagFailed'), result.error); return; }
          toast({ kind: 'success', title: t('settings.clearDiagSuccess') });
        })() })}>{t('settings.clearDiag')}</Button>
      </InfoBand>
      <div className="mt-6 text-xs text-ink2">{t('settings.schemaVersion', { version: workspace.schemaVersion })}</div>
    </>
  );
}
