'use client';

/**
 * Spec 038 §5 — the affected user's view of moderation on their account, and the appeal form.
 *
 * Reachable while suspended or banned: both of its API calls (U1, U2) are on the §3.5 allow-list.
 * It shows the standard explanation for each action type and any message the admin chose to share —
 * never the internal reason, the evidence, who acted, or where the case came from.
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, FormField, Skeleton, Textarea } from '@/components';
import { apiFetch, mutateHeaders } from '@/app/requests/api-client';
import type { ModerationActionType, MyModerationActionDto } from '@/lib/types/moderation';
import styles from '@/app/_components/ai-account.module.css';

const EXPLANATIONS: Record<ModerationActionType, string> = {
  warning: 'Your account received a warning. Nothing about your account has changed.',
  restriction: 'Your account is restricted. You can keep working on existing bookings, but you cannot start new requests, offers or bookings.',
  suspension: 'Your account is suspended. You can view this page, manage your privacy settings and appeal, but you cannot use the marketplace.',
  ban: 'Your account is banned. You can view this page, manage your privacy settings and appeal, but you cannot use the marketplace.',
  booking_intervention: 'One of your bookings was cancelled by our Trust & Safety team. Any refund follows the booking’s cancellation terms.',
  payout_freeze: 'Your payouts are on hold. Nothing you have earned is lost; payouts resume when the hold is lifted.',
};

const STATUS_LABEL: Record<MyModerationActionDto['status'], string> = {
  active: 'In effect',
  executed: 'Completed',
  superseded: 'Replaced by a later action',
  reversed: 'Reversed',
};

function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

export default function AccountModerationPage() {
  const [actions, setActions] = useState<MyModerationActionDto[] | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [appealing, setAppealing] = useState<MyModerationActionDto | null>(null);
  const [statement, setStatement] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await apiFetch<MyModerationActionDto[]>('/api/v1/moderation-actions');
    if (!response.ok) {
      setPageError(response.error?.message ?? 'This page could not be loaded.');
      setActions([]);
      return;
    }
    setActions(response.data ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const fileAppeal = useCallback(async () => {
    if (!appealing) return;
    setBusy(true);
    setFormError(null);
    const response = await apiFetch(`/api/v1/moderation-actions/${appealing.id}/appeals`, {
      method: 'POST',
      headers: mutateHeaders({ 'Idempotency-Key': idempotencyKey }),
      body: JSON.stringify({ statement: statement.trim() }),
    });
    setBusy(false);
    if (!response.ok) {
      setFormError(response.error?.message ?? 'Your appeal could not be sent. Please try again.');
      return;
    }
    setAppealing(null);
    setStatement('');
    setIdempotencyKey(newKey());
    setNotice('Your appeal was sent. A different member of our team will review it.');
    await load();
  }, [appealing, idempotencyKey, load, statement]);

  if (actions === null) {
    return (
      <main className={styles.page}>
        <Skeleton />
      </main>
    );
  }

  if (pageError) {
    return (
      <main className={styles.page}>
        <ErrorState title="Moderation unavailable" description={pageError} />
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Account moderation</h1>

      {notice ? (
        <Alert tone="success" onDismiss={() => setNotice(null)}>
          {notice}
        </Alert>
      ) : null}

      {actions.length === 0 ? (
        <EmptyState icon="shield-check" title="Your account is in good standing" description="There are no moderation actions on your account." />
      ) : (
        <ul className={styles.list}>
          {actions.map((action) => (
            <li key={action.id} className={styles.row}>
              <Card>
                <div className={styles.rowBody}>
                  <p className={styles.rowTitle}>
                    <Badge tone={action.status === 'active' ? 'warning' : 'neutral'}>{STATUS_LABEL[action.status]}</Badge>
                  </p>
                  <p>{EXPLANATIONS[action.actionType]}</p>
                  {action.userMessage ? <p>Message from our team: {action.userMessage}</p> : null}
                  <p className={styles.rowMeta}>Since {new Date(action.activatedAt).toLocaleString()}</p>
                  {action.appeal ? <p className={styles.rowMeta}>Appeal: {action.appeal.status}</p> : null}
                  {action.appealable ? (
                    <div className={styles.actions}>
                      <Button variant="secondary" onClick={() => setAppealing(action)}>
                        Appeal this decision
                      </Button>
                    </div>
                  ) : null}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {appealing ? (
        <Card>
          <section aria-labelledby="appeal-heading" className={styles.section}>
            <h2 id="appeal-heading" className={styles.sectionTitle}>
              Appeal
            </h2>
            <FormField label="Tell us why this decision should be reviewed" htmlFor="appeal-statement" required>
              <Textarea
                id="appeal-statement"
                value={statement}
                maxLength={2000}
                onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setStatement(event.target.value)}
                disabled={busy}
              />
            </FormField>
            {formError ? (
              <Alert tone="error" title="Not sent">
                {formError}
              </Alert>
            ) : null}
            <div className={styles.actions}>
              <Button onClick={() => void fileAppeal()} disabled={busy || statement.trim().length === 0}>
                Send appeal
              </Button>
              <Button variant="secondary" onClick={() => setAppealing(null)} disabled={busy}>
                Cancel
              </Button>
            </div>
          </section>
        </Card>
      ) : null}
    </main>
  );
}
