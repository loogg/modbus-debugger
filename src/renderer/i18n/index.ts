import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { zhCN } from './locales/zh-CN';

/**
 * i18n stack: i18next (core: interpolation, plural rules, locale fallback, lazy resources)
 * + react-i18next (bindings: useTranslation, suspense-free). Dictionaries are plain typed
 * TS modules so a missing key is a compile error once a second locale exists.
 */
void i18n.use(initReactI18next).init({
  resources: { 'zh-CN': { translation: zhCN } },
  lng: 'zh-CN',
  fallbackLng: 'zh-CN',
  interpolation: { escapeValue: false },
  returnNull: false,
});

export const LANGUAGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'zh-CN', label: '简体中文' },
];

/** Applies the persisted language preference; unknown tags fall back to zh-CN. */
export function applyLanguage(pref: string | null | undefined): void {
  const lng = LANGUAGE_OPTIONS.some((o) => o.value === pref) ? (pref as string) : 'zh-CN';
  if (i18n.language !== lng) void i18n.changeLanguage(lng);
}

export { i18n };
export { useTranslation } from 'react-i18next';

declare module 'i18next' {
  interface CustomTypeOptions {
    resources: { translation: typeof zhCN };
  }
}
