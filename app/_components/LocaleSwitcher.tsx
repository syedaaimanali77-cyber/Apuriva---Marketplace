'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, FormField, Select } from '@/components';
import { apiFetch, mutateHeaders } from '@/app/requests/api-client';
import { LOCALE_COOKIE_MAX_AGE_SECONDS, LOCALE_COOKIE_NAME } from '@/lib/i18n/config';
import type { LocaleDto, UserLocaleDto } from '@/lib/types/i18n';
import { useLocale } from './LocaleProvider';
import { useLocales } from './useLocales';

/**
 * Spec 042 §5.2 — the UI-language switcher, on the existing DS `Select`, offering only the locales
 * `GET /api/v1/locales` returns (so never `ur` while `urdu-locale` is off).
 *
 *   - `account` (signed in, on `/account`): `PATCH /api/v1/users/me/locale`, which persists `users.locale`
 *     and sets the cookie. Disabled while in flight; on failure the `Select` returns to its previous value
 *     and a translated `Alert` explains why.
 *   - `guest` (the header, signed out): writes the `apuriva_locale` cookie; nothing is persisted server-side.
 *
 * Either way it then calls `router.refresh()`, so the server re-renders `<html lang dir>` — a soft refresh.
 * With only one locale available (the flag off) it renders nothing (§5.2 "Empty").
 */
export function LocaleSwitcher({ mode }: { mode: 'account' | 'guest' }) {
  const { status, locales } = useLocales();
  if (status !== 'ready' || locales.length < 2) return null;
  return <LocaleSelect mode={mode} locales={locales} />;
}

/** Mounted only once there is a choice to make, so the hidden (flag-off) switcher needs no router. */
function LocaleSelect({ mode, locales }: { mode: 'account' | 'guest'; locales: LocaleDto[] }) {
  const router = useRouter();
  const { locale, t, errorText } = useLocale();
  const [value, setValue] = useState<string>(locale);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(next: string) {
    if (next === value) return;
    const previous = value;
    setError(null);
    setValue(next);
    if (mode === 'guest') {
      document.cookie = `${LOCALE_COOKIE_NAME}=${encodeURIComponent(next)}; Path=/; SameSite=Lax; Max-Age=${LOCALE_COOKIE_MAX_AGE_SECONDS}`;
      router.refresh();
      return;
    }
    setPending(true);
    const result = await apiFetch<UserLocaleDto>('/api/v1/users/me/locale', {
      method: 'PATCH',
      headers: mutateHeaders(),
      body: JSON.stringify({ locale: next }),
    });
    setPending(false);
    if (!result.ok) {
      setValue(previous);
      setError(errorText(result.error?.code, result.error?.message, t('locale.changeFailed')));
      return;
    }
    router.refresh();
  }

  const id = `locale-switcher-${mode}`;
  return (
    <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
      <FormField label={t('locale.label')} htmlFor={id}>
        <Select
          id={id}
          size="sm"
          value={value}
          disabled={pending}
          onChange={(e) => void choose(e.target.value)}
          options={locales.map((l) => ({ value: l.code, label: l.nativeLabel }))}
        />
      </FormField>
      {error ? (
        <Alert tone="error">{error}</Alert>
      ) : null}
    </div>
  );
}
