import { StatusDot } from './ui';
import { useWarnings } from '../store/app';
import { useTranslation } from '../i18n';

export function RuntimeWarnings() {
  const warnings = useWarnings();
  const { t } = useTranslation();
  if (!warnings.length) return null;

  return (
    <div role="alert" className="mb-5 rounded-card border border-line bg-surface2 px-5 py-3 text-sm text-ink">
      <StatusDot tone="warn" label={t('shell.warningsTitle')} />
      <ul className="mt-1 space-y-1">
        {warnings.map((warning) => <li key={warning}>{warning}</li>)}
      </ul>
    </div>
  );
}
