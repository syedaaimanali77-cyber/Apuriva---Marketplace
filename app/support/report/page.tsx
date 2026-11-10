'use client';

/**
 * Spec 030 §5 — the reporter's safety report form.
 *
 * THE ERROR STATE IS THE ONE THAT MATTERS MOST HERE. §5 requires that a failed submission preserve
 * the entered text and the selected evidence: someone describing something distressing must never
 * be made to type it a second time because a request failed. So the draft lives in component state
 * and is re-rendered on failure — nothing is cleared until the server has accepted it.
 *
 * THE SUCCESS STATE PROMISES NOTHING IT CANNOT KEEP. Master §64's workflow is restricted, so we
 * cannot honestly promise a timeline or an outcome. The confirmation says the report reached a
 * human and stops there.
 *
 * EVIDENCE IS ATTACHED AFTER CREATION, by design: a safety report has no pre-existing parent to
 * hang files from when there is no booking, so the report is created first and its id becomes the
 * spec 027 `contextId`. Both steps sit behind one submit.
 */
import { useCallback, useState } from 'react';
import { Button, Card, ErrorState, Select, Textarea } from '@/components';
import { FileUpload } from '@/app/_components/FileUpload';
import { apiFetch, fieldErrorMap, mutateHeaders } from '@/app/requests/api-client';
import { SAFETY_CATEGORIES, type SafetyCategory, type SafetyReportDto } from '@/lib/types/safety';
import { MAX_DESCRIPTION_LENGTH } from '@/lib/safety/limits';
import { useLocale } from '@/app/_components/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/dictionaries/en';
import styles from './safety-report.module.css';

const CATEGORY_LABELS: Record<SafetyCategory, MessageKey> = {
  harassment: 'support.report.category.harassment',
  threat: 'support.report.category.threat',
  unsafe_behaviour: 'support.report.category.unsafe_behaviour',
  impersonation: 'support.report.category.impersonation',
  property_damage: 'support.report.category.property_damage',
  other: 'support.report.category.other',
};

export default function SafetyReportPage() {
  const { t, errorText } = useLocale();
  const [targetUserId, setTargetUserId] = useState('');
  const [category, setCategory] = useState<SafetyCategory>('harassment');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<SafetyReportDto | null>(null);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    setFieldErrors({});

    const response = await apiFetch<SafetyReportDto>('/api/v1/safety-reports', {
      method: 'POST',
      headers: mutateHeaders({ 'idempotency-key': crypto.randomUUID() }),
      body: JSON.stringify({ targetUserId, category, description }),
    });
    setBusy(false);

    if (!response.ok) {
      // Nothing is cleared: the draft and any chosen evidence survive the failure.
      setError(errorText(response.error?.code, response.error?.message, t('support.report.sendFailed')));
      setFieldErrors(fieldErrorMap(response.error));
      return;
    }
    setCreated(response.data ?? null);
  }, [category, description, errorText, t, targetUserId]);

  if (created) {
    return (
      <main className={styles.page}>
        <Card>
          <h1 className={styles.title}>{t('support.report.sentTitle')}</h1>
          {/* No timeline, no outcome, no false promise of resolution. */}
          <p className={styles.body}>{t('support.report.sentBody')}</p>
          <p className={styles.body}>{t('support.report.evidenceBody')}</p>
          <FileUpload contextType="safety_evidence" contextId={created.id} label={t('support.report.addEvidence')} />
        </Card>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>{t('support.report.title')}</h1>
      <p className={styles.body}>{t('support.report.intro')}</p>

      {error ? <ErrorState title={t('support.report.failedTitle')} description={error} /> : null}

      <Card>
        <label className={styles.label} htmlFor="targetUserId">
          {t('support.report.who')}
        </label>
        <input
          id="targetUserId"
          className={styles.input}
          value={targetUserId}
          onChange={(event) => setTargetUserId(event.target.value)}
          disabled={busy}
        />
        {fieldErrors.targetUserId ? <p className={styles.fieldError}>{fieldErrors.targetUserId}</p> : null}

        <label className={styles.label} htmlFor="category">
          {t('support.report.whatHappened')}
        </label>
        <Select
            id="category"
            value={category}
            options={SAFETY_CATEGORIES.map((value) => ({ value, label: t(CATEGORY_LABELS[value]) }))}
            onChange={(event: React.ChangeEvent<HTMLSelectElement>) =>
              setCategory(event.target.value as SafetyCategory)
            }
          disabled={busy}
        />
        {fieldErrors.category ? <p className={styles.fieldError}>{fieldErrors.category}</p> : null}

        <label className={styles.label} htmlFor="description">
          {t('support.report.ownWords')}
        </label>
        <p className={styles.help}>{t('support.report.ownWordsHint')}</p>
        <Textarea
            id="description"
            value={description}
            maxLength={MAX_DESCRIPTION_LENGTH}
          onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(event.target.value)}
          disabled={busy}
        />
        {fieldErrors.description ? <p className={styles.fieldError}>{fieldErrors.description}</p> : null}

        <Button onClick={submit} disabled={busy}>
          {busy ? t('support.report.sending') : t('support.report.send')}
        </Button>
      </Card>
    </main>
  );
}
