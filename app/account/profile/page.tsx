'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { Badge, Button, Card, ErrorState, FormField, Input, Skeleton } from '@/components';
import { useLocale } from '@/app/_components/LocaleProvider';
import { apiFetch, mutateHeaders, type ApiErrorBody, type ApiResult } from '@/app/requests/api-client';
import { useAccountUser } from '@/app/account/_components/useAccountUser';
import type { ProviderProfileDto, UserProfileDto } from '@/lib/types/profile';
import styles from './profile.module.css';

/** The API's limit (lib/account/profile.ts); the input enforces it too. */
const NAME_MAX_LENGTH = 60;

type LoadStatus = 'loading' | 'error' | 'ready';

const fetchProfile = () => apiFetch<UserProfileDto>('/api/v1/users/me/profile');
const fetchBusiness = () => apiFetch<ProviderProfileDto>('/api/v1/providers/me/profile');

/**
 * Account → Profile. The customer's display name (editable), the account's email and phone (read-only, with
 * verified state — changing them needs verification flows that do not exist), and, for a provider in provider
 * mode, the business name (editable, published immediately). Nothing is shown as saved before the server
 * confirms it; a stale version reloads the latest values instead of overwriting them.
 */
export default function ProfilePage() {
  const { t, errorText } = useLocale();
  const account = useAccountUser();
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [profile, setProfile] = useState<UserProfileDto | null>(null);
  const [business, setBusiness] = useState<ProviderProfileDto | null>(null);
  // The outcome of the last save, carried across the form's remount (it is keyed by the saved version).
  const [flash, setFlash] = useState<{ field: NameField; outcome: SaveOutcome } | null>(null);

  const providerMode = account.user?.activeMode === 'provider';

  const applyProfile = useCallback(
    (res: ApiResult<UserProfileDto>) => {
      if (!res.ok || !res.data) {
        setLoadError(errorText(res.error?.code, res.error?.message, t('accountProfile.loadFailed')));
        setStatus('error');
        return;
      }
      setProfile(res.data);
      setStatus('ready');
    },
    [errorText, t],
  );

  const load = useCallback(async () => {
    setStatus('loading');
    setLoadError(null);
    applyProfile(await fetchProfile());
  }, [applyProfile]);

  const loadBusiness = useCallback(async () => {
    const res = await fetchBusiness();
    setBusiness(res.ok && res.data ? res.data : null);
  }, []);

  useEffect(() => {
    let current = true;
    void fetchProfile().then((res) => current && applyProfile(res));
    return () => {
      current = false;
    };
  }, [applyProfile]);

  useEffect(() => {
    if (!providerMode) return;
    let current = true;
    void fetchBusiness().then((res) => current && setBusiness(res.ok && res.data ? res.data : null));
    return () => {
      current = false;
    };
  }, [providerMode]);

  if (status === 'loading') {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>{t('accountProfile.title')}</h1>
        <Card>
          <Skeleton lines={4} />
        </Card>
      </main>
    );
  }

  if (status === 'error' || !profile) {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>{t('accountProfile.title')}</h1>
        <ErrorState description={loadError ?? undefined} onRetry={() => void load()} />
      </main>
    );
  }

  const contact = (label: string, value: string | null, verified: boolean) => (
    <div className={styles.readOnlyRow}>
      <dt className={styles.readOnlyLabel}>{label}</dt>
      <dd className={styles.readOnlyValue}>
        {value ?? t('accountProfile.notSet')}
        {value ? <Badge tone={verified ? 'success' : 'neutral'}>{verified ? t('accountProfile.verified') : t('accountProfile.notVerified')}</Badge> : null}
      </dd>
    </div>
  );

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>{t('accountProfile.title')}</h1>

      <Card>
        <section className={styles.section} aria-labelledby="profile-personal">
          <h2 id="profile-personal" className={styles.sectionTitle}>
            {t('accountProfile.personalHeading')}
          </h2>
          <NameForm
            key={`displayName-${profile.version}`}
            label={t('accountProfile.displayName')}
            help={t('accountProfile.displayNameHelp')}
            field="displayName"
            url="/api/v1/users/me/profile"
            value={profile.displayName}
            version={profile.version}
            flash={flash?.field === 'displayName' ? flash.outcome : undefined}
            onSaved={(next) => {
              setFlash({ field: 'displayName', outcome: 'saved' });
              setProfile(next as UserProfileDto);
            }}
            onStale={async () => {
              setFlash({ field: 'displayName', outcome: 'stale' });
              applyProfile(await fetchProfile());
            }}
          />
          <dl className={styles.readOnlyList}>
            {contact(t('accountProfile.email'), profile.email, profile.emailVerified)}
            {contact(t('accountProfile.phone'), profile.phoneNumber, profile.phoneVerified)}
          </dl>
          <p className={styles.status}>{t('accountProfile.contactReadOnly')}</p>
        </section>
      </Card>

      {account.user?.hasProviderProfile ? (
        <Card>
          <section className={styles.section} aria-labelledby="profile-business">
            <h2 id="profile-business" className={styles.sectionTitle}>
              {t('accountProfile.businessHeading')}
            </h2>
            {providerMode && business ? (
              <NameForm
                key={`businessName-${business.version}`}
                label={t('accountProfile.businessName')}
                help={t('accountProfile.businessNameHelp')}
                field="businessName"
                url="/api/v1/providers/me/profile"
                value={business.businessName}
                version={business.version}
                flash={flash?.field === 'businessName' ? flash.outcome : undefined}
                onSaved={(next) => {
                  setFlash({ field: 'businessName', outcome: 'saved' });
                  setBusiness(next as ProviderProfileDto);
                }}
                onStale={async () => {
                  setFlash({ field: 'businessName', outcome: 'stale' });
                  await loadBusiness();
                }}
              />
            ) : (
              <p className={styles.status}>{t('accountProfile.businessProviderModeOnly')}</p>
            )}
          </section>
        </Card>
      ) : null}
    </main>
  );
}

type NameField = 'displayName' | 'businessName';
type SaveOutcome = 'saved' | 'stale';

interface NameFormProps {
  label: string;
  help: string;
  field: NameField;
  /** The last save's outcome for this field, shown after the remount that follows it. */
  flash?: SaveOutcome;
  url: string;
  value: string | null;
  version: number;
  onSaved: (next: UserProfileDto | ProviderProfileDto) => void;
  onStale: () => Promise<void>;
}

/**
 * One editable name: trimmed on save (empty clears it), ≤ 60 characters, saved only on a 2xx. The parent keys it
 * by the saved version, so a save or a stale-version reload starts it again from the server's value.
 */
function NameForm({ label, help, field, flash, url, value, version, onSaved, onStale }: NameFormProps) {
  const { t, errorText } = useLocale();
  const id = useId();
  const [draft, setDraft] = useState(value ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(flash === 'stale' ? t('accountProfile.staleVersion') : null);
  const [notice, setNotice] = useState<string | null>(flash === 'saved' ? t('accountProfile.saved') : null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    const trimmed = draft.trim();
    if (trimmed.length > NAME_MAX_LENGTH) {
      setError(t('accountProfile.tooLong'));
      return;
    }
    setSaving(true);
    const res = await apiFetch<UserProfileDto | ProviderProfileDto>(url, {
      method: 'PATCH',
      headers: mutateHeaders(),
      body: JSON.stringify({ [field]: trimmed === '' ? null : trimmed, expectedVersion: version }),
    });
    setSaving(false);
    if (res.ok && res.data) {
      onSaved(res.data);
      return;
    }
    const failure: ApiErrorBody | undefined = res.error;
    if (failure?.code === 'CONFLICT') {
      await onStale();
      return;
    }
    // The API's only field rules are the length and control characters: say so in the user's language.
    setError(failure?.code === 'VALIDATION_ERROR' ? t('accountProfile.invalidName') : errorText(failure?.code, failure?.message));
  }

  const dirty = draft.trim() !== (value ?? '');
  return (
    <form className={styles.form} onSubmit={(e) => void save(e)} noValidate>
      <FormField label={label} htmlFor={id} help={help} error={error ?? undefined}>
        <Input id={id} value={draft} maxLength={NAME_MAX_LENGTH} invalid={Boolean(error)} onChange={(e) => setDraft(e.target.value)} autoComplete="off" />
      </FormField>
      <div className={styles.actions}>
        <Button type="submit" variant="primary" loading={saving} disabled={!dirty}>
          {saving ? t('accountProfile.saving') : t('accountProfile.save')}
        </Button>
        {notice ? (
          <p className={styles.status} role="status">
            {notice}
          </p>
        ) : null}
      </div>
    </form>
  );
}
