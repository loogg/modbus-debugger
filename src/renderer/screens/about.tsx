import React, { useState } from 'react';
import { ArrowDownload20Regular, Info24Regular } from '@fluentui/react-icons';
import { useApp } from '../store/app';
import { Button, InfoBand, PageHeader } from '../components/ui';
import { useTranslation } from '../i18n';
import { fmtDateTime } from '../time';

export function AboutScreen() {
  const {t} = useTranslation();
  const update = useApp(s => s.snapshot?.update);
  const command = useApp(s => s.command);
  const [confirmInstall, setConfirmInstall] = useState(false);
  if (!update) return <InfoBand>{t('about.loading')}</InfoBand>;
  const busy = ['checking','downloading','verifying','preparing','installing'].includes(update.phase);
  const downloaded = update.phase === 'downloaded';
  const canDownload = update.available && Boolean(update.latest?.asset);
  const percent = update.totalBytes ? Math.min(100, Math.floor(update.receivedBytes / update.totalBytes * 100)) : 0;
  const systemName = update.platform === 'win32' ? 'Windows' : update.platform === 'darwin' ? 'macOS' : update.platform === 'linux' ? 'Linux' : update.platform;
  const packageLabels = { zip: t('about.zip'), portable: t('about.portable'), setup: t('about.setup') };
  const instructions = { zip: t('about.zipHelp'), portable: t('about.portableHelp'), setup: t('about.setupHelp') };
  const primaryText = update.phase === 'preparing' ? t('about.preparing') : update.phase === 'installing' ? t('about.installing') : update.phase === 'checking' ? t('about.checking') : update.phase === 'downloading' ? t('about.downloading') : update.phase === 'verifying' ? t('about.verifying') : downloaded ? update.canInstall ? t('about.install') : t('about.reveal') : canDownload ? t('about.download',{version:update.latest!.version}) : t('about.check');
  const status = update.phase === 'error' ? t('about.failed') : downloaded ? t('about.downloaded') : update.phase === 'checking' ? t('about.checking') : update.available ? t('about.available',{version:update.latest!.version}) : update.phase === 'current' ? update.latest ? t('about.current') : t('about.noRelease') : t('about.idle');
  return <div className="mx-auto max-w-[1160px]" data-testid="about-screen">
    <PageHeader title={t('about.title')} subtitle={t('about.subtitle')} />
    <section className="rounded-card border border-line bg-surface p-6">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div>
          <div className="flex items-center gap-3"><Info24Regular className="text-accent" /><h2 className="text-xl font-bold">{t('about.app')}</h2></div>
          <div className="mt-3 inline-flex gap-2 rounded-full border border-line px-3 py-1 text-sm"><span className="text-ink2">{t('about.version')}</span><strong data-testid="app-version">v{update.currentVersion}</strong></div>
          <p className="mt-3 text-xs text-ink2">{t('about.packageLabel')}：{packageLabels[update.packageKind]} · {systemName} / {update.arch}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void command({type:'update.openLink',target:'repository'})}>{t('about.repository')}</Button>
          <Button onClick={() => void command({type:'update.openLink',target:'releases'})}>{t('about.releases')}</Button>
          <Button variant="primary" disabled={busy || confirmInstall} onClick={() => { if (downloaded && update.canInstall) setConfirmInstall(true); else void command({type:downloaded ? 'update.reveal' : canDownload ? 'update.download' : 'update.check'}); }}>
            {canDownload && !downloaded ? <ArrowDownload20Regular /> : null}{primaryText}
          </Button>
          {busy ? update.phase !== 'installing' ? <Button onClick={() => void command({type:'update.cancel'})}>{t('about.cancel')}</Button> : null : (canDownload || downloaded) ? <Button disabled={confirmInstall} onClick={() => void command({type:'update.check'})}>{t('about.checkAgain')}</Button> : null}
          {downloaded && update.canInstall ? <Button onClick={() => void command({type:'update.reveal'})}>{t('about.reveal')}</Button> : null}
        </div>
      </div>
      {confirmInstall && !busy ? <div role="alertdialog" aria-label={t('about.install')} className="mt-5 rounded-ctl border border-line p-4"><p className="text-sm">{t('about.confirmHint')}</p><div className="mt-3 flex gap-3"><Button variant="primary" onClick={() => {setConfirmInstall(false); void command({type:'update.install'});}}>{t('about.confirmInstall')}</Button><Button onClick={() => setConfirmInstall(false)}>{t('about.cancel')}</Button></div></div> : null}
      {update.installMessage ? <p role="status" className="mt-4 text-sm text-accent">{update.installMessage}</p> : null}
      <InfoBand tone="blue" className="mt-6">
        <div role={update.phase === 'error' ? 'alert' : 'status'} aria-live="polite" className={update.phase === 'error' ? 'text-err' : 'text-accent'}>{update.phase === 'preparing' || update.phase === 'installing' ? primaryText : status}</div>
        {update.error ? <div className="mt-2 break-words text-sm text-err">{update.error}</div> : null}
        {update.available && !update.latest?.asset ? <p className="mt-2 text-sm">{t('about.unavailable')}</p> : null}
        {update.phase === 'downloading' || update.phase === 'verifying' ? <div className="mt-3">
          <progress aria-label={t('about.progress')} max={100} value={percent} className="h-2 w-full accent-[#0078D4]" />
          <div className="mt-1 text-xs mono">{percent}% · {(update.receivedBytes/1048576).toFixed(1)} / {(update.totalBytes/1048576).toFixed(1)} MB</div>
        </div> : null}
        {update.downloadPath ? <p className="mt-2 break-all text-xs mono" data-testid="update-file">{update.downloadPath}</p> : null}
      </InfoBand>
      <div className="mt-3 flex flex-wrap justify-between gap-2 text-xs text-ink2"><span>{t('about.source')}</span>{update.checkedAt ? <span>{t('about.lastChecked',{time:fmtDateTime(update.checkedAt)})}</span> : null}</div>
    </section>
    {update.latest ? <section className="mt-6 rounded-card border border-line bg-surface p-6"><h2 className="text-sm font-bold">{t('about.notes')} · v{update.latest.version}</h2><p className="mt-3 max-h-80 overflow-y-auto whitespace-pre-wrap break-words text-sm text-ink2">{update.latest.notes || t('about.noNotes')}</p></section> : null}
    <InfoBand className="mt-6"><h2 className="text-sm font-bold">{t('about.upgradeTitle')}</h2><p className="mt-2 text-sm">{instructions[update.packageKind]}</p><p className="mt-2 text-sm">{t('about.saveHint')}</p><p className="mt-3 text-xs text-ink2">{t('about.downloadHint')}</p></InfoBand>
  </div>;
}
