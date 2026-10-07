'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { DEFAULT_LOCALE, isSupportedLocale, localeDirection, type Locale } from '@/lib/i18n/config';
import type { Dictionary, MessageKey } from '@/lib/i18n/dictionaries/en';
import { lookup, translateApiErrorFrom, translateFrom, type Translator } from '@/lib/i18n/translator-core';
import type { LocaleDirection } from '@/lib/types/i18n';

export interface LocaleContextValue {
  locale: Locale;
  direction: LocaleDirection;
  /** `t(key, params?)` — the resolved locale's string, else English, never the raw key (AC-6). */
  t: Translator;
  /** Spec 042 §3.7 — an API error's text by stable `code`, else the server's message, else `fallback`. */
  errorText: (code: string | null | undefined, serverMessage?: string | null, fallback?: string) => string;
}

/**
 * The dictionary used where the server passed none: a render outside any provider, or a provider given no
 * dictionary. Production never registers one — the root layout passes every dictionary down (§3.5), so no
 * dictionary is bundled into client JS. `test/setup.ts` registers English, so isolated component tests
 * render English exactly as before.
 */
let defaultMessages: Dictionary | undefined;

function contextValue(locale: Locale, messages: Dictionary | undefined, fallbackMessages: Dictionary | undefined): LocaleContextValue {
  const own = messages ?? defaultMessages;
  const fallback = fallbackMessages ?? defaultMessages;
  const t: Translator = (key, params) => translateFrom(locale, own, fallback, key, params);
  const isKnownKey = (key: string): key is MessageKey => lookup(own, key) !== undefined || lookup(fallback, key) !== undefined;
  return {
    locale,
    direction: localeDirection(locale),
    t,
    errorText: (code, serverMessage, fallbackText) => translateApiErrorFrom(t, isKnownKey, code, serverMessage, fallbackText),
  };
}

/** Outside any provider: `defaultMessages` (English in tests; none in production, where every render is provided). */
let outsideProvider = contextValue(DEFAULT_LOCALE, undefined, undefined);
const LocaleContext = createContext<LocaleContextValue | null>(null);

/** Test support only (see `defaultMessages`). */
export function setDefaultMessages(messages: Dictionary | undefined): void {
  defaultMessages = messages;
  outsideProvider = contextValue(DEFAULT_LOCALE, undefined, undefined);
}

/**
 * Spec 042 §3.5 — the client locale context. The root layout resolves the locale on the SERVER and passes
 * that locale's dictionary as `messages`, plus — for a locale other than English — the English entries it
 * lacks as `fallbackMessages` (AC-6). Nothing else of any dictionary reaches the browser.
 */
export function LocaleProvider({
  locale,
  messages,
  fallbackMessages,
  children,
}: {
  locale: string;
  messages?: Dictionary;
  fallbackMessages?: Dictionary;
  children: ReactNode;
}) {
  const resolved: Locale = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE;
  const value = useMemo(() => contextValue(resolved, messages, fallbackMessages), [resolved, messages, fallbackMessages]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext) ?? outsideProvider;
}
