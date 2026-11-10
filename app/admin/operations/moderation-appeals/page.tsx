'use client';

/**
 * Spec 038 §5 — the moderation appeal queue (AC-5).
 *
 * The server refuses a decision by the admin who initiated or approved the appealed action
 * (`403 APPEAL_REQUIRES_DIFFERENT_ADMIN`); this screen shows that refusal plainly. "Uphold" reverses
 * the action immediately, so it goes through a structured confirmation with a mandatory reason.
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, FormField, Select, Skeleton, Textarea } from '@/components';
import { apiFetch, mutateHeaders } from '@/app/requests/api-client';
import type { ModerationAppealDto } from '@/lib/types/moderation';
import styles from '../../admin.module.css';

export default function AdminModerationAppealsPage() {
  const [appeals, setAppeals] = useState<ModerationAppealDto[] | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ModerationAppealDto | null>(null);
  const [decision, setDecision] = useState<'upheld' | 'denied'>('denied');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await apiFetch<ModerationAppealDto[]>('/api/v1/admin/moderation-appeals?status=pending');
    if (!response.ok) {
      setPageError(response.error?.message ?? 'The appeal queue could not be loaded.');
      setAppeals([]);
      return;
    }
    setAppeals(response.data ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    setFormError(null);
    const response = await apiFetch<ModerationAppealDto>(`/api/v1/admin/moderation-appeals/${selected.id}/decide`, {
      method: 'POST',
      headers: mutateHeaders({ 'Idempotency-Key': `${selected.id}:${decision}` }),
      body: JSON.stringify({ decision, reason: reason.trim() }),
    });
    setBusy(false);
    setConfirming(false);
    if (!response.ok) {
      setFormError(response.error?.message ?? 'Something went wrong. Please try again.');
      return;
    }
    setSelected(null);
    setReason('');
    await load();
  }, [decision, load, reason, selected]);

  if (appeals === null) {
    return (
      <main className={styles.page} data-density="dense">
        <Skeleton />
      </main>
    );
  }

  if (pageError) {
    return (
      <main className={styles.page} data-density="dense">
        <ErrorState title="Appeal queue unavailable" description={pageError} />
      </main>
    );
  }

  return (
    <main className={styles.page} data-density="dense">
      <h1 className={styles.title}>Moderation appeals</h1>
      <p className={styles.sectionDescription}>
        Oldest first. You cannot decide an appeal against an action you initiated or approved.
      </p>

      {appeals.length === 0 ? (
        <EmptyState icon="inbox" title="No appeals waiting" description="Appeals filed by users appear here." />
      ) : (
        <div className={styles.section}>
          {appeals.map((appeal) => (
            <Card key={appeal.id}>
              <div className={styles.section}>
                <div className={styles.sectionHeader}>
                  <Badge tone="warning">{appeal.status}</Badge>
                  <span className={styles.sectionDescription}>Action {appeal.moderationActionId}</span>
                </div>
                <p>{appeal.statement}</p>
                <div className={styles.actions}>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setSelected(appeal);
                      setDecision('denied');
                      setReason('');
                      setFormError(null);
                    }}
                  >
                    Decide
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {selected ? (
        <Card>
          <section aria-labelledby="decide-heading" className={styles.section}>
            <h2 id="decide-heading" className={styles.sectionTitle}>
              Decide this appeal
            </h2>
            <FormField label="Decision" htmlFor="appeal-decision">
              <Select
                id="appeal-decision"
                value={decision}
                options={[
                  { value: 'denied', label: 'Deny — the action stays in effect' },
                  { value: 'upheld', label: 'Uphold — reverse the action' },
                ]}
                onChange={(event: React.ChangeEvent<HTMLSelectElement>) => setDecision(event.target.value as 'upheld' | 'denied')}
                disabled={busy}
              />
            </FormField>
            <FormField label="Reason (recorded in the audit log)" htmlFor="appeal-reason" required>
              <Textarea
                id="appeal-reason"
                value={reason}
                maxLength={500}
                onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setReason(event.target.value)}
                disabled={busy}
              />
            </FormField>
            {formError ? (
              <Alert tone="error" title="Not saved">
                {formError}
              </Alert>
            ) : null}
            <div className={styles.actions}>
              <Button onClick={() => setConfirming(true)} disabled={busy || reason.trim().length === 0}>
                Review and confirm
              </Button>
              <Button variant="secondary" onClick={() => setSelected(null)} disabled={busy}>
                Cancel
              </Button>
            </div>
          </section>
        </Card>
      ) : null}

      <ConfirmDialog
        open={confirming}
        title={decision === 'upheld' ? 'Uphold and reverse the action?' : 'Deny the appeal?'}
        description={
          decision === 'upheld'
            ? 'The action is reversed immediately and the user regains the standing they had before it.'
            : 'The action stays in effect. The user is told a decision was made.'
        }
        confirmLabel="Confirm decision"
        tone={decision === 'upheld' ? 'primary' : 'danger'}
        pending={busy}
        onConfirm={() => void decide()}
        onCancel={() => setConfirming(false)}
      />
    </main>
  );
}
