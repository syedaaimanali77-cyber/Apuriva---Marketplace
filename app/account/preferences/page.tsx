'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert, Card, Skeleton, Switch } from '@/components';
import { LocaleSwitcher } from '@/app/_components/LocaleSwitcher';
import { useLocale } from '@/app/_components/LocaleProvider';
import { useLocales } from '@/app/_components/useLocales';
import { apiFetch, mutateHeaders } from '@/app/requests/api-client';
import type { MessageKey } from '@/lib/i18n/dictionaries/en';
import type { AiPreferencesDto } from '@/lib/types/ai-assistant';
import type { PersonalizationSettingsDto } from '@/lib/types/home';
import type { NotificationPreferencesDto } from '@/lib/types/notifications';
import styles from '../profile/profile.module.css';

/**
 * Account → Preferences — one place for the preferences that already live across the app. It adds NO
 * preference logic: every control reads and writes through its owning system's existing API, so a change here
 * is the same change made elsewhere, and vice versa.
 *
 * - Language: spec 042's `LocaleSwitcher` (it also stays on `/account`).
 * - Notifications: spec 026's marketing consent (`POST /users/me/marketing-consent`), plus the full channel
 *   settings on `/account/notifications`.
 * - Ask Apuriva: spec 034's proactive suggestions (`PATCH /users/me/ai-preferences`), plus `/account/ai-memory`.
 * - Home page: spec 014's personalization (`PATCH /users/me/personalization-settings`), also on the home page.
 */
export default function PreferencesPage() {
  const { t } = useLocale();
  const { status: localeStatus, locales } = useLocales();

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>{t('accountPreferences.title')}</h1>
      <p className={styles.intro}>{t('accountPreferences.intro')}</p>

      <Card>
        <section className={styles.section} aria-labelledby="pref-language">
          <h2 id="pref-language" className={styles.sectionTitle}>
            {t('accountPreferences.languageHeading')}
          </h2>
          {localeStatus === 'ready' && locales.length < 2 ? <p className={styles.status}>{t('accountPreferences.languageOnlyOne')}</p> : null}
          <LocaleSwitcher mode="account" />
        </section>
      </Card>

      <Card>
        <section className={styles.section} aria-labelledby="pref-notifications">
          <h2 id="pref-notifications" className={styles.sectionTitle}>
            {t('accountPreferences.notificationsHeading')}
          </h2>
          <PreferenceSwitch
            id="pref-marketing"
            label="accountPreferences.marketing"
            description="accountPreferences.marketingDescription"
            load={async () => {
              const res = await apiFetch<NotificationPreferencesDto>('/api/v1/users/me/notification-preferences');
              return res.ok && res.data ? res.data.marketingConsentAt !== null : null;
            }}
            save={async (next) => {
              const res = await apiFetch<{ marketingConsentAt: string | null }>('/api/v1/users/me/marketing-consent', {
                method: 'POST',
                headers: mutateHeaders(),
                body: JSON.stringify({ consent: next }),
              });
              return res.ok && res.data ? res.data.marketingConsentAt !== null : null;
            }}
          />
          <Link className={styles.link} href="/account/notifications">
            {t('accountPreferences.manageNotifications')}
          </Link>
        </section>
      </Card>

      <Card>
        <section className={styles.section} aria-labelledby="pref-ai">
          <h2 id="pref-ai" className={styles.sectionTitle}>
            {t('accountPreferences.aiHeading')}
          </h2>
          <PreferenceSwitch
            id="pref-ai-proactive"
            label="accountPreferences.proactive"
            description="accountPreferences.proactiveDescription"
            load={async () => {
              const res = await apiFetch<AiPreferencesDto>('/api/v1/users/me/ai-preferences');
              return res.ok && res.data ? res.data.proactiveSuggestionsEnabled : null;
            }}
            save={async (next) => {
              const res = await apiFetch<AiPreferencesDto>('/api/v1/users/me/ai-preferences', {
                method: 'PATCH',
                headers: mutateHeaders(),
                body: JSON.stringify({ proactiveSuggestionsEnabled: next }),
              });
              return res.ok && res.data ? res.data.proactiveSuggestionsEnabled : null;
            }}
          />
          <Link className={styles.link} href="/account/ai-memory">
            {t('accountPreferences.manageAiMemory')}
          </Link>
        </section>
      </Card>

      <Card>
        <section className={styles.section} aria-labelledby="pref-home">
          <h2 id="pref-home" className={styles.sectionTitle}>
            {t('accountPreferences.homeHeading')}
          </h2>
          <PreferenceSwitch
            id="pref-personalization"
            label="accountPreferences.personalization"
            description="accountPreferences.personalizationDescription"
            load={async () => {
              const res = await apiFetch<PersonalizationSettingsDto>('/api/v1/users/me/personalization-settings');
              return res.ok && res.data ? res.data.personalizationEnabled : null;
            }}
            save={async (next) => {
              const res = await apiFetch<PersonalizationSettingsDto>('/api/v1/users/me/personalization-settings', {
                method: 'PATCH',
                headers: mutateHeaders(),
                body: JSON.stringify({ personalizationEnabled: next }),
              });
              return res.ok && res.data ? res.data.personalizationEnabled : null;
            }}
          />
        </section>
      </Card>
    </main>
  );
}

interface PreferenceSwitchProps {
  id: string;
  label: MessageKey;
  description: MessageKey;
  /** The current value from the owning API, or `null` when it could not be read. */
  load: () => Promise<boolean | null>;
  /** Writes through the owning API; resolves to the server-confirmed value, or `null` on failure. */
  save: (next: boolean) => Promise<boolean | null>;
}

/** One preference, shown only as the server reports it: never flipped before a 2xx confirms the change. */
function PreferenceSwitch({ id, label, description, load, save }: PreferenceSwitchProps) {
  const { t } = useLocale();
  const [value, setValue] = useState<boolean | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const [initialLoad] = useState(() => load);

  useEffect(() => {
    let current = true;
    void initialLoad().then((result) => {
      if (!current) return;
      setValue(result);
      setState(result === null ? 'error' : 'ready');
    });
    return () => {
      current = false;
    };
  }, [initialLoad]);

  if (state === 'loading') return <Skeleton lines={1} />;
  if (state === 'error' || value === null) return <Alert tone="error">{t('accountPreferences.loadFailed')}</Alert>;

  return (
    <>
      <Switch
        id={id}
        label={t(label)}
        description={t(description)}
        checked={value}
        disabled={saving}
        onChange={async (next) => {
          setSaving(true);
          setSaveFailed(false);
          const confirmed = await save(next);
          setSaving(false);
          if (confirmed === null) setSaveFailed(true);
          else setValue(confirmed);
        }}
      />
      {saveFailed ? <Alert tone="error">{t('accountPreferences.saveFailed')}</Alert> : null}
    </>
  );
}
