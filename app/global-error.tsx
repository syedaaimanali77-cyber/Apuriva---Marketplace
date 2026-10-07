'use client';

import { useEffect, useState } from 'react';
import { ErrorState } from '@/components/ErrorState';
import { DEFAULT_LOCALE, LOCALE_COOKIE_NAME, isSupportedLocale, localeDefinition, localeDirection, type Locale } from '@/lib/i18n/config';
import type { Dictionary } from '@/lib/i18n/dictionaries/en';
import { LocaleProvider } from './_components/LocaleProvider';
import { brandFontVariables } from './fonts';
import './styles/apuriva-tokens.css';
import './globals.css';

function readLocaleCookie(): string | null {
  const row = document.cookie.split('; ').find((part) => part.startsWith(`${LOCALE_COOKIE_NAME}=`));
  return row ? decodeURIComponent(row.slice(LOCALE_COOKIE_NAME.length + 1)) : null;
}

/**
 * Spec 042 §3.4 / R-5: `global-error` has no request context, so it reads the `apuriva_locale` cookie.
 * A missing or unusable value — unsupported, or a locale whose availability flag is off (AC-8, checked
 * through spec 041's client-readable flags) — renders `en`/`ltr`, which is also what shows until then.
 */
function useCookieLocale(): Locale {
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);
  useEffect(() => {
    const candidate = readLocaleCookie();
    if (!isSupportedLocale(candidate) || candidate === DEFAULT_LOCALE) return;
    const flag = localeDefinition(candidate).availabilityFlag;
    if (flag === null) {
      setLocale(candidate);
      return;
    }
    let cancelled = false;
    fetch('/api/v1/feature-flags/effective', { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { data?: { flags?: Record<string, boolean> } } | null) => {
        if (!cancelled && body?.data?.flags?.[flag] === true) setLocale(candidate);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return locale;
}

/**
 * Spec 042 §3.5 — `global-error` has no server to pass it a dictionary, and its chunk loads on EVERY route,
 * so it fetches the dictionaries only when it actually renders. Until they arrive (or if they cannot load)
 * `ErrorState` shows the design system's own English defaults, so the page is never blank.
 */
function useLazyMessages(locale: Locale): { messages?: Dictionary; fallbackMessages?: Dictionary } {
  const [loaded, setLoaded] = useState<{ locale: Locale; messages: Dictionary; fallbackMessages: Dictionary } | null>(null);
  useEffect(() => {
    let cancelled = false;
    import('@/lib/i18n/dictionaries')
      .then(({ dictionaryFor }) => {
        if (!cancelled) setLoaded({ locale, messages: dictionaryFor(locale), fallbackMessages: dictionaryFor(DEFAULT_LOCALE) });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [locale]);
  return loaded?.locale === locale ? loaded : {};
}

/**
 * Root-layout error fallback. `global-error` replaces the root layout and doesn't inherit its
 * global styles or fonts, so it loads the DS tokens, base styles and brand fonts itself before
 * rendering the DS `ErrorState`.
 */
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const locale = useCookieLocale();
  const { messages, fallbackMessages } = useLazyMessages(locale);
  return (
    <html lang={locale} dir={localeDirection(locale)} className={brandFontVariables}>
      <body>
        <LocaleProvider locale={locale} messages={messages} fallbackMessages={fallbackMessages}>
          <main style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 'var(--space-6)' }}>
            <ErrorState onRetry={() => reset()} />
          </main>
        </LocaleProvider>
      </body>
    </html>
  );
}
