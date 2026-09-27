'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { Skeleton } from '@/components/Skeleton';
import { Switch } from '@/components/Switch';
import type { AiMemoryItemDto, AiPreferencesDto } from '@/lib/types/ai-assistant';
import { aiFetch, aiMutation, formatAiInstant } from '@/app/_components/ask-apuriva-client';
import { useLocale } from '@/app/_components/LocaleProvider';
import styles from '@/app/_components/ai-account.module.css';

type Status = 'loading' | 'error' | 'ready';

/**
 * Spec 034 §5 — view, delete and reset AI memory (master spec §81, AC-3), plus the proactive
 * suggestions toggle next to the other AI controls. Memory holds only preferences the user
 * explicitly confirmed; nothing on this page can add one. Resetting never touches conversations.
 */
export default function AiMemoryPage() {
  const { locale, t } = useLocale();
  // Spec 042: the memory KEY names are platform text; the stored value summary is shown as provided.
  const keyLabel = (key: AiMemoryItemDto['key']) => t(`aiAccount.memoryKeys.${key}`);
  const [status, setStatus] = useState<Status>('loading');
  const [items, setItems] = useState<AiMemoryItemDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  const [prefs, setPrefs] = useState<AiPreferencesDto | null>(null);
  const [prefsStatus, setPrefsStatus] = useState<Status>('loading');
  const [prefsError, setPrefsError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus('loading');
    const res = await aiFetch<AiMemoryItemDto[]>('/api/v1/ai/memory');
    if (!res.ok) {
      setStatus('error');
      return;
    }
    setItems(res.data ?? []);
    setStatus('ready');
  }, []);

  const loadPrefs = useCallback(async () => {
    setPrefsStatus('loading');
    const res = await aiFetch<AiPreferencesDto>('/api/v1/users/me/ai-preferences');
    if (!res.ok || !res.data) {
      setPrefsStatus('error');
      return;
    }
    setPrefs(res.data);
    setPrefsStatus('ready');
  }, []);

  useEffect(() => {
    void load();
    void loadPrefs();
  }, [load, loadPrefs]);

  async function remove(item: AiMemoryItemDto) {
    setDeletingId(item.id);
    setError(null);
    const res = await aiFetch(`/api/v1/ai/memory/${encodeURIComponent(item.id)}`, aiMutation('DELETE'));
    setDeletingId(null);
    if (!res.ok) {
      setError(t('aiAccount.memory.forgetFailed'));
      return;
    }
    setItems((current) => current.filter((m) => m.id !== item.id));
    setAnnouncement(t('aiAccount.memory.forgotten', { label: keyLabel(item.key) }));
  }

  async function reset() {
    setResetting(true);
    setError(null);
    const res = await aiFetch('/api/v1/ai/memory', aiMutation('DELETE'));
    setResetting(false);
    setConfirmReset(false);
    if (!res.ok) {
      setError(t('aiAccount.memory.resetFailed'));
      return;
    }
    setItems([]);
    setAnnouncement(t('aiAccount.memory.resetDone'));
  }

  async function toggleSuggestions(next: boolean) {
    if (!prefs) return;
    const previous = prefs;
    setPrefsError(null);
    setPrefs({ proactiveSuggestionsEnabled: next });
    const res = await aiFetch<AiPreferencesDto>('/api/v1/users/me/ai-preferences', aiMutation('PATCH', { proactiveSuggestionsEnabled: next }));
    if (!res.ok || !res.data) {
      setPrefs(previous);
      setPrefsError(t('aiAccount.memory.saveFailed'));
      return;
    }
    setPrefs(res.data);
    setAnnouncement(next ? t('aiAccount.memory.suggestionsOn') : t('aiAccount.memory.suggestionsOff'));
  }

  return (
    <main className={styles.page}>
      <p role="status" aria-live="polite" className="apr-visually-hidden">
        {announcement}
      </p>

      <section className={styles.section} aria-labelledby="ai-memory-heading" aria-busy={status === 'loading'}>
        <div className={styles.header}>
          <h1 id="ai-memory-heading" className={styles.title}>
            {t('aiAccount.memory.title')}
          </h1>
          {status === 'ready' && items.length > 0 ? (
            <Button variant="secondary" size="sm" onClick={() => setConfirmReset(true)}>
              {t('aiAccount.memory.reset')}
            </Button>
          ) : null}
        </div>
        <p className={styles.hint}>{t('aiAccount.memory.hint')}</p>

        {error ? <Alert tone="error">{error}</Alert> : null}

        {status === 'loading' ? (
          <div className={styles.list} data-testid="ai-memory-loading">
            <Skeleton height={64} radius="var(--radius-lg)" />
            <Skeleton height={64} radius="var(--radius-lg)" />
          </div>
        ) : status === 'error' ? (
          <ErrorState
            title={t('aiAccount.memory.loadFailedTitle')}
            description={t('aiAccount.memory.loadFailedDescription')}
            onRetry={() => void load()}
          />
        ) : items.length === 0 ? (
          <EmptyState icon="sparkles" title={t('aiAccount.memory.emptyTitle')} description={t('aiAccount.memory.emptyDescription')} />
        ) : (
          <ul className={styles.list}>
            {items.map((item) => (
              <li key={item.id}>
                <Card elevation="flat">
                  <div className={styles.row}>
                    <div className={styles.rowBody}>
                      <p className={styles.rowTitle}>
                        {t('aiAccount.memory.item', { label: keyLabel(item.key), value: item.valueSummary })}
                      </p>
                      <p className={styles.rowMeta}>{t('aiAccount.memory.saved', { when: formatAiInstant(item.updatedAt, locale) })}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={deletingId === item.id}
                      aria-label={t('aiAccount.memory.forgetLabel', { label: keyLabel(item.key) })}
                      onClick={() => void remove(item)}
                    >
                      {t('aiAccount.memory.delete')}
                    </Button>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section} aria-labelledby="ai-suggestions-heading" aria-busy={prefsStatus === 'loading'}>
        <h2 id="ai-suggestions-heading" className={styles.sectionTitle}>
          {t('aiAccount.memory.suggestions')}
        </h2>
        {prefsError ? <Alert tone="error">{prefsError}</Alert> : null}
        {prefsStatus === 'loading' ? (
          <Skeleton height={56} radius="var(--radius-lg)" />
        ) : prefsStatus === 'error' || !prefs ? (
          <ErrorState compact title={t('aiAccount.memory.settingFailed')} onRetry={() => void loadPrefs()} />
        ) : (
          <Card elevation="flat">
            <Switch
              id="ai-proactive-suggestions"
              label={t('aiAccount.memory.suggestionsLabel')}
              description={t('aiAccount.memory.suggestionsHint')}
              checked={prefs.proactiveSuggestionsEnabled}
              onChange={(next) => void toggleSuggestions(next)}
            />
          </Card>
        )}
      </section>

      <ConfirmDialog
        open={confirmReset}
        title={t('aiAccount.memory.resetTitle')}
        description={t('aiAccount.memory.resetDescription')}
        confirmLabel={t('aiAccount.memory.reset')}
        pending={resetting}
        onConfirm={() => void reset()}
        onCancel={() => setConfirmReset(false)}
      />
    </main>
  );
}
