'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { DEFAULT_LOCALE, isSupportedLocale, localeDirection, type Locale } from '@/lib/i18n/config';
import type { Dictionary } from '@/lib/i18n/dictionaries/en';
import { createTranslator, translateApiErrorWith, type Translator } from '@/lib/i18n/translator';
import type { LocaleDirection } from '@/lib/types/i18n';

export interface LocaleContextValue {
  locale: Locale;
  direction: LocaleDirection;
  /** `t(key, params?)` — the resolved locale's string, else English, never the raw key (AC-6). */
  t: Translator;
  /** Spec 042 §3.7 — an API error's text by stable `code`, else the server's message, else `fallback`. */
  errorText: (code: string | null | undefined, serverMessage?: string | null, fallback?: string) => string;
}

function contextValue(locale: Locale, messages: Dictionary | undefined): LocaleContextValue {
  const t = createTranslator(locale, messages);
  return {
    locale,
    direction: localeDirection(locale),
    t,
    errorText: (code, serverMessage, fallback) => translateApiErrorWith(t, code, serverMessage, fallback),
  };
}

/** Outside a provider (isolated component tests, `global-error` before it resolves) the UI is English. */
const LocaleContext = createContext<LocaleContextValue>(contextValue(DEFAULT_LOCALE, undefined));

/**
 * Spec 042 §3.5 — the client locale context. The root layout resolves the locale on the SERVER and passes
 * only that locale's dictionary here; English (the fallback) is the one dictionary every bundle carries.
 */
export function LocaleProvider({ locale, messages, children }: { locale: string; messages?: Dictionary; children: ReactNode }) {
  const resolved: Locale = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE;
  const value = useMemo(() => contextValue(resolved, resolved === DEFAULT_LOCALE ? undefined : messages), [resolved, messages]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}
