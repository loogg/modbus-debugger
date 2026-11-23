import { Select } from './ui';
import { useTranslation } from '../i18n';

const PERIODS = [0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];

export function PollPeriodSelect(props: { value: string; onChange(value: string): void }) {
  const { t } = useTranslation();
  const values = [...new Set([...PERIODS, Number(props.value)])].sort((a, b) => a - b);
  return (
    <div>
      <Select value={props.value} onChange={props.onChange} options={values.map(value => ({
        value: String(value), label: value === 0 ? t('templates.periodZero') : `${value} ms`,
      }))} />
      <div className="mt-1 text-xs text-ink2">{t('templates.periodHint')}</div>
    </div>
  );
}
