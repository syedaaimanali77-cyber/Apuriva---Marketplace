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
import styles from './safety-report.module.css';

const CATEGORY_LABELS: Record<SafetyCategory, string> = {
  harassment: 'Harassment or abusive behaviour',
  threat: 'Threats or intimidation',
  unsafe_behaviour: 'Unsafe behaviour during a job',
  impersonation: 'Someone pretending to be another person',
  property_damage: 'Damage to property',
  other: 'Something else',
};

export default function SafetyReportPage() {
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
      setError(response.error?.message ?? 'We could not send your report. Please try again.');
      setFieldErrors(fieldErrorMap(response.error));
      return;
    }
    setCreated(response.data ?? null);
  }, [category, description, targetUserId]);

  if (created) {
    return (
      <main className={styles.page}>
        <Card>
          <h1 className={styles.title}>Your report has been sent</h1>
          {/* No timeline, no outcome, no false promise of resolution. */}
          <p className={styles.body}>
            Our Trust &amp; Safety team reviews every report. We cannot share what happens next, and we will
            not tell the other person that you reported them.
          </p>
          <p className={styles.body}>
            If you have anything else that would help — a screenshot, a photo, a document — you can add it below.
          </p>
          <FileUpload contextType="safety_evidence" contextId={created.id} label="Add evidence" />
        </Card>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Report a safety concern</h1>
      <p className={styles.body}>
        Use this form to tell our Trust &amp; Safety team about someone&apos;s behaviour. If someone is in
        immediate danger, contact your local emergency services first — Apuriva is a marketplace and cannot
        respond to emergencies.
      </p>

      {error ? <ErrorState title="We could not send your report" description={error} /> : null}

      <Card>
        <label className={styles.label} htmlFor="targetUserId">
          Who is this about?
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
          What happened?
        </label>
        <Select
            id="category"
            value={category}
            options={SAFETY_CATEGORIES.map((value) => ({ value, label: CATEGORY_LABELS[value] }))}
            onChange={(event: React.ChangeEvent<HTMLSelectElement>) =>
              setCategory(event.target.value as SafetyCategory)
            }
          disabled={busy}
        />
        {fieldErrors.category ? <p className={styles.fieldError}>{fieldErrors.category}</p> : null}

        <label className={styles.label} htmlFor="description">
          Tell us in your own words
        </label>
        <p className={styles.help}>Include when it happened and anything a reviewer would need to understand it.</p>
        <Textarea
            id="description"
            value={description}
            maxLength={MAX_DESCRIPTION_LENGTH}
          onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(event.target.value)}
          disabled={busy}
        />
        {fieldErrors.description ? <p className={styles.fieldError}>{fieldErrors.description}</p> : null}

        <Button onClick={submit} disabled={busy}>
          {busy ? 'Sending…' : 'Send report'}
        </Button>
      </Card>
    </main>
  );
}
