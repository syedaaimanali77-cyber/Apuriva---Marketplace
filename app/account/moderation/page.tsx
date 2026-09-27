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
import { useLocale } from '@/app/_components/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/dictionaries/en';
import { formatDateTime } from '@/lib/i18n/format';
import type { ModerationActionType, MyModerationActionDto } from '@/lib/types/moderation';
import styles from '@/app/_components/ai-account.module.css';

const EXPLANATIONS: Record<ModerationActionType, MessageKey> = {
  warning: 'moderation.explanation.warning',
  restriction: 'moderation.explanation.restriction',
  suspension: 'moderation.explanation.suspension',
  ban: 'moderation.explanation.ban',
  booking_intervention: 'moderation.explanation.booking_intervention',
  payout_freeze: 'moderation.explanation.payout_freeze',
};

const STATUS_LABEL: Record<MyModerationActionDto['status'], MessageKey> = {
  active: 'moderation.status.active',
  executed: 'moderation.status.executed',
  superseded: 'moderation.status.superseded',
  reversed: 'moderation.status.reversed',
};

const APPEAL_STATUS_LABEL: Record<string, MessageKey> = {
  pending: 'moderation.appealStatus.pending',
  upheld: 'moderation.appealStatus.upheld',
  denied: 'moderation.appealStatus.denied',
};

function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

export default function AccountModerationPage() {
  const { locale, t, errorText } = useLocale();
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
      setPageError(errorText(response.error?.code, response.error?.message, t('moderation.loadFailed')));
      setActions([]);
      return;
    }
    setActions(response.data ?? []);
  }, [errorText, t]);

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
      setFormError(errorText(response.error?.code, response.error?.message, t('moderation.appealFailed')));
      return;
    }
    setAppealing(null);
    setStatement('');
    setIdempotencyKey(newKey());
    setNotice(t('moderation.appealSent'));
    await load();
  }, [appealing, errorText, idempotencyKey, load, statement, t]);

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
        <ErrorState title={t('moderation.unavailableTitle')} description={pageError} />
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>{t('moderation.title')}</h1>

      {notice ? (
        <Alert tone="success" onDismiss={() => setNotice(null)}>
          {notice}
        </Alert>
      ) : null}

      {actions.length === 0 ? (
        <EmptyState icon="shield-check" title={t('moderation.emptyTitle')} description={t('moderation.emptyDescription')} />
      ) : (
        <ul className={styles.list}>
          {actions.map((action) => (
            <li key={action.id} className={styles.row}>
              <Card>
                <div className={styles.rowBody}>
                  <p className={styles.rowTitle}>
                    <Badge tone={action.status === 'active' ? 'warning' : 'neutral'}>{t(STATUS_LABEL[action.status])}</Badge>
                  </p>
                  <p>{t(EXPLANATIONS[action.actionType])}</p>
                  {action.userMessage ? <p>{t('moderation.messageFromTeam', { message: action.userMessage })}</p> : null}
                  <p className={styles.rowMeta}>{t('moderation.since', { when: formatDateTime(action.activatedAt, locale) })}</p>
                  {action.appeal ? (
                    <p className={styles.rowMeta}>
                      {t('moderation.appealLabel', {
                        status: APPEAL_STATUS_LABEL[action.appeal.status] ? t(APPEAL_STATUS_LABEL[action.appeal.status]!) : action.appeal.status,
                      })}
                    </p>
                  ) : null}
                  {action.appealable ? (
                    <div className={styles.actions}>
                      <Button variant="secondary" onClick={() => setAppealing(action)}>
                        {t('moderation.appealButton')}
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
              {t('moderation.appealTitle')}
            </h2>
            <FormField label={t('moderation.appealPrompt')} htmlFor="appeal-statement" required>
              <Textarea
                id="appeal-statement"
                value={statement}
                maxLength={2000}
                onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setStatement(event.target.value)}
                disabled={busy}
              />
            </FormField>
            {formError ? (
              <Alert tone="error" title={t('moderation.notSent')}>
                {formError}
              </Alert>
            ) : null}
            <div className={styles.actions}>
              <Button onClick={() => void fileAppeal()} disabled={busy || statement.trim().length === 0}>
                {t('moderation.sendAppeal')}
              </Button>
              <Button variant="secondary" onClick={() => setAppealing(null)} disabled={busy}>
                {t('moderation.cancel')}
              </Button>
            </div>
          </section>
        </Card>
      ) : null}
    </main>
  );
}
