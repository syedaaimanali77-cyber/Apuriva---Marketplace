'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/app/requests/api-client';
import type { LocaleDto, LocalesDto } from '@/lib/types/i18n';

export interface LocalesState {
  status: 'loading' | 'ready' | 'error';
  locales: LocaleDto[];
  resolvedLocale: string | null;
  /** Spec 042 §3.9 — the configured market default (`PLATFORM_CURRENCY_CODE`), or `null` until known. */
  platformCurrencyCode: string | null;
}

const ISO_4217 = /^[A-Z]{3}$/;

function isLocalesDto(value: unknown): value is LocalesDto {
  if (!value || typeof value !== 'object') return false;
  const dto = value as Partial<LocalesDto>;
  return Array.isArray(dto.locales) && typeof dto.resolvedLocale === 'string' && typeof dto.platformCurrencyCode === 'string';
}

/**
 * Spec 042 §3.11 L1 — `GET /api/v1/locales` for client screens: the available locales (the switcher),
 * and the market default currency (the request form's budget, the admin filters). There is deliberately
 * NO client-side currency fallback (AC-3): until the server answers, `platformCurrencyCode` is `null`.
 */
export function useLocales(): LocalesState {
  const [state, setState] = useState<LocalesState>({ status: 'loading', locales: [], resolvedLocale: null, platformCurrencyCode: null });

  useEffect(() => {
    let cancelled = false;
    void apiFetch<LocalesDto>('/api/v1/locales').then((result) => {
      if (cancelled) return;
      if (result.ok && isLocalesDto(result.data)) {
        setState({
          status: 'ready',
          locales: result.data.locales,
          resolvedLocale: result.data.resolvedLocale,
          platformCurrencyCode: ISO_4217.test(result.data.platformCurrencyCode) ? result.data.platformCurrencyCode : null,
        });
      } else {
        setState({ status: 'error', locales: [], resolvedLocale: null, platformCurrencyCode: null });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
