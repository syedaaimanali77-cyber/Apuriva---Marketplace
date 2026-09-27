'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Badge, Button, Card, ErrorState, Skeleton, Textarea } from '@/components';
import type { DisputeDto, DisputeMessageDto, DisputeStatus } from '@/lib/types/disputes';
import { MAX_DISPUTE_REASON_LENGTH, MIN_DISPUTE_REASON_LENGTH } from '@/lib/disputes/limits';
import { apiFetch, BOOKING_POLL_MS, mutateHeaders } from '../../booking-client';
import { useLocale } from '@/app/_components/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/dictionaries/en';
import { formatDate, formatMoney } from '@/lib/i18n/format';
import styles from '../../bookings.module.css';

type PageStatus = 'loading' | 'error' | 'ready';

const STATUS_LABELS: Record<DisputeStatus, MessageKey> = {
  open: 'dispute.status.open',
  under_review: 'dispute.status.under_review',
  resolved: 'dispute.status.resolved',
  appealed: 'dispute.status.appealed',
  closed: 'dispute.status.closed',
};

const DECISION_LABELS: Record<string, MessageKey> = {
  no_action: 'dispute.decision.no_action',
  refund_customer: 'dispute.decision.refund_customer',
  partial_refund_customer: 'dispute.decision.partial_refund_customer',
  favour_provider: 'dispute.decision.favour_provider',
  mutual_resolution: 'dispute.decision.mutual_resolution',
};

const APPEAL_OUTCOME_LABELS: Record<string, MessageKey> = {
  upheld: 'dispute.appealOutcome.upheld',
  overturned: 'dispute.appealOutcome.overturned',
  partially_upheld: 'dispute.appealOutcome.partially_upheld',
};

/** A stable key per mounted screen, so a double-submit is a replay rather than a second write. */
function newIdempotencyKey(prefix: string): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Spec 031 §5 — the participant's dispute screen.
 *
 * ONE SCREEN, TWO PHASES: the open form while no dispute exists, and the live view once it does.
 * Both are built entirely from existing primitives (`Card`, `Button`, `Badge`, `Textarea`,
 * `ErrorState`, `Skeleton`) and the booking screens' existing module CSS. No new design-system
 * primitive, no raw colour, size, radius or spacing value, and no brand mark — `NavShell` carries
 * the single brand placement for the app.
 *
 * WHAT IT SHOWS THAT MATTERS: the resolution's REASONING, not just its outcome (master §2.3), and
 * both sides' evidence counts and messages. What it cannot show, because the DTO has no field for
 * it, is the counterparty's identity, any admin's identity, the advisory AI summary, the refund
 * approval chain or the legal-hold flag.
 *
 * Live updates are POLLING on spec 018's cadence, stopping once the dispute is `closed` — the
 * identical approach `app/bookings/[id]/page.tsx` already takes. There is no WebSocket layer in
 * this repository.
 */
export default function BookingDisputePage() {
  const { locale, t, errorText } = useLocale();
  const params = useParams<{ id: string }>();
  const bookingId = params.id;

  const [status, setStatus] = useState<PageStatus>('loading');
  const [dispute, setDispute] = useState<DisputeDto | null>(null);
  const [messages, setMessages] = useState<DisputeMessageDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [reason, setReason] = useState('');
  const [messageBody, setMessageBody] = useState('');
  const [appealReason, setAppealReason] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    // The caller's own disputes, filtered to this booking. There is no "dispute for booking X"
    // route: a participant reaches their dispute through their own list, which is scoped by join.
    const list = await apiFetch<{ id: string; bookingId: string }[]>('/api/v1/disputes');
    if (!list.ok) {
      setError(errorText(list.error?.code, list.error?.message, t('dispute.loadFailed')));
      setStatus('error');
      return;
    }
    const match = (list.data ?? []).find((row) => row.bookingId === bookingId);
    if (!match) {
      setDispute(null);
      setStatus('ready');
      return;
    }

    const detail = await apiFetch<DisputeDto>(`/api/v1/disputes/${match.id}`);
    if (!detail.ok) {
      setError(errorText(detail.error?.code, detail.error?.message, t('dispute.loadFailed')));
      setStatus('error');
      return;
    }
    setDispute(detail.data ?? null);

    const thread = await apiFetch<DisputeMessageDto[]>(`/api/v1/disputes/${match.id}/messages`);
    setMessages(thread.ok ? thread.data ?? [] : []);
    setStatus('ready');
  }, [bookingId, errorText, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!dispute || dispute.status === 'closed') return undefined;
    const timer = setInterval(() => void load(), BOOKING_POLL_MS);
    return () => clearInterval(timer);
  }, [dispute, load]);

  async function openDispute() {
    setBusy(true);
    setFormError(null);
    const response = await apiFetch<DisputeDto>(`/api/v1/bookings/${bookingId}/disputes`, {
      method: 'POST',
      headers: { ...mutateHeaders(), 'Idempotency-Key': newIdempotencyKey('dispute') },
      body: JSON.stringify({ reason }),
    });
    setBusy(false);
    if (!response.ok) {
      setFormError(errorText(response.error?.code, response.error?.message, t('dispute.openFailed')));
      return;
    }
    setReason('');
    await load();
  }

  async function postMessage() {
    if (!dispute) return;
    setBusy(true);
    setFormError(null);
    const response = await apiFetch<DisputeMessageDto>(`/api/v1/disputes/${dispute.id}/messages`, {
      method: 'POST',
      headers: { ...mutateHeaders(), 'Idempotency-Key': newIdempotencyKey('msg') },
      body: JSON.stringify({ body: messageBody }),
    });
    setBusy(false);
    if (!response.ok) {
      // The draft is deliberately preserved on failure — §5 "Error".
      setFormError(errorText(response.error?.code, response.error?.message, t('dispute.messageFailed')));
      return;
    }
    setMessageBody('');
    await load();
  }

  async function submitAppeal() {
    if (!dispute) return;
    setBusy(true);
    setFormError(null);
    const response = await apiFetch(`/api/v1/disputes/${dispute.id}/appeal`, {
      method: 'POST',
      headers: { ...mutateHeaders(), 'Idempotency-Key': newIdempotencyKey('appeal') },
      body: JSON.stringify({ reason: appealReason }),
    });
    setBusy(false);
    if (!response.ok) {
      setFormError(errorText(response.error?.code, response.error?.message, t('dispute.appealFailed')));
      return;
    }
    setAppealReason('');
    await load();
  }

  async function acceptOutcome() {
    if (!dispute) return;
    setBusy(true);
    setFormError(null);
    const response = await apiFetch(`/api/v1/disputes/${dispute.id}/waive-appeal`, {
      method: 'POST',
      headers: { ...mutateHeaders(), 'Idempotency-Key': newIdempotencyKey('waive') },
      body: JSON.stringify({}),
    });
    setBusy(false);
    if (!response.ok) {
      setFormError(errorText(response.error?.code, response.error?.message, t('dispute.closeFailed')));
      return;
    }
    await load();
  }

  if (status === 'loading') {
    return (
      <main className={styles.page}>
        <Skeleton height={40} />
        <Skeleton height={140} />
        <Skeleton height={200} />
      </main>
    );
  }

  if (status === 'error') {
    return (
      <main className={styles.page}>
        <ErrorState title={t('dispute.errorTitle')} description={error ?? undefined} />
        <Link href={`/bookings/${bookingId}`}>{t('dispute.back')}</Link>
      </main>
    );
  }

  // EMPTY — no dispute yet. The server is authoritative on eligibility; this form simply reports
  // what it says rather than duplicating the `protected` + `held` rule in the browser.
  if (!dispute) {
    const tooShort = reason.trim().length < MIN_DISPUTE_REASON_LENGTH;
    return (
      <main className={styles.page}>
        <h1>{t('dispute.openTitle')}</h1>
        <Card>
          <p>{t('dispute.openIntro')}</p>
          <label htmlFor="dispute-reason">{t('dispute.whatWentWrong')}</label>
          <Textarea
            id="dispute-reason"
            value={reason}
            onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setReason(event.target.value)}
            maxLength={MAX_DISPUTE_REASON_LENGTH}
            disabled={busy}
          />
          {formError ? <ErrorState title={t('dispute.didNotWork')} description={formError} /> : null}
          <Button onClick={() => void openDispute()} disabled={busy || tooShort}>
            {t('dispute.open')}
          </Button>
        </Card>
        <Link href={`/bookings/${bookingId}`}>{t('dispute.back')}</Link>
      </main>
    );
  }

  const resolution = dispute.resolution;

  return (
    <main className={styles.page}>
      <h1>{t('dispute.title')}</h1>
      <Card>
        <Badge>{t(STATUS_LABELS[dispute.status])}</Badge>
        <p>
          <strong>{dispute.openedBy === 'me' ? t('dispute.openedByMe') : t('dispute.openedByOther')}</strong>
        </p>
        <p>{dispute.reason}</p>
        <p>
          {t(dispute.evidenceCount === 1 ? 'dispute.evidenceOne' : 'dispute.evidenceMany', { count: dispute.evidenceCount })} ·{' '}
          {t(dispute.messageCount === 1 ? 'dispute.messageOne' : 'dispute.messageMany', { count: dispute.messageCount })}
        </p>
      </Card>

      {resolution ? (
        <Card>
          <h2>{t('dispute.decisionTitle')}</h2>
          <p>
            <strong>{DECISION_LABELS[resolution.decision] ? t(DECISION_LABELS[resolution.decision]!) : resolution.decision}</strong>
          </p>
          {/* Master §2.3: the reasoning, not just the outcome. */}
          <p>{resolution.reasoning}</p>
          {resolution.proposedRefundAmountMinorUnits !== null && resolution.proposedRefundCurrencyCode ? (
            <p>
              {t('dispute.refundToIssue')}{' '}
              {formatMoney(resolution.proposedRefundAmountMinorUnits, resolution.proposedRefundCurrencyCode, locale)}
              {resolution.refundState === 'completed'
                ? t('dispute.refundSent')
                : resolution.refundState === 'failed'
                  ? t('dispute.refundFailed')
                  : t('dispute.refundProcessing')}
            </p>
          ) : null}
        </Card>
      ) : null}

      {dispute.appeal ? (
        <Card>
          <h2>{t('dispute.appeal')}</h2>
          <p>{dispute.appeal.filedBy === 'me' ? t('dispute.appealedByMe') : t('dispute.appealedByOther')}</p>
          <p>{dispute.appeal.reason}</p>
          {dispute.appeal.outcome ? (
            <>
              <p>
                <strong>
                  {t('dispute.appealOutcomeLabel', {
                    outcome: APPEAL_OUTCOME_LABELS[dispute.appeal.outcome]
                      ? t(APPEAL_OUTCOME_LABELS[dispute.appeal.outcome]!)
                      : dispute.appeal.outcome.replace(/_/g, ' '),
                  })}
                </strong>
              </p>
              <p>{dispute.appeal.reasoning}</p>
            </>
          ) : (
            <p>{t('dispute.reviewing')}</p>
          )}
        </Card>
      ) : null}

      {dispute.canAppeal && dispute.appealWindowEndsAt ? (
        <Card>
          <h2>{t('dispute.disagreeTitle')}</h2>
          <p>{t('dispute.appealUntil', { date: formatDate(dispute.appealWindowEndsAt, locale) })}</p>
          <label htmlFor="dispute-appeal-reason">{t('dispute.whyDisagree')}</label>
          <Textarea
            id="dispute-appeal-reason"
            value={appealReason}
            onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setAppealReason(event.target.value)}
            maxLength={MAX_DISPUTE_REASON_LENGTH}
            disabled={busy}
          />
          <Button onClick={() => void submitAppeal()} disabled={busy || appealReason.trim().length < MIN_DISPUTE_REASON_LENGTH}>
            {t('dispute.appealButton')}
          </Button>
          <Button variant="secondary" onClick={() => void acceptOutcome()} disabled={busy}>
            {t('dispute.accept')}
          </Button>
        </Card>
      ) : null}

      <Card>
        <h2>{t('dispute.messages')}</h2>
        {messages.length === 0 ? (
          <p>{t('dispute.noMessages')}</p>
        ) : (
          <ul>
            {messages.map((message) => (
              <li key={message.id}>
                <strong>
                  {message.authorRole === 'me' ? t('dispute.you') : message.authorRole === 'admin' ? t('dispute.apuriva') : t('dispute.otherParty')}
                </strong>
                <p>{message.body}</p>
              </li>
            ))}
          </ul>
        )}
        {dispute.canPostMessage ? (
          <>
            <label htmlFor="dispute-message">{t('dispute.addMessage')}</label>
            <Textarea
              id="dispute-message"
              value={messageBody}
              onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setMessageBody(event.target.value)}
              maxLength={2000}
              disabled={busy}
            />
            <Button onClick={() => void postMessage()} disabled={busy || messageBody.trim().length === 0}>
              {t('dispute.send')}
            </Button>
          </>
        ) : (
          <p>{t('dispute.noNewMessages')}</p>
        )}
      </Card>

      {formError ? <ErrorState title={t('dispute.didNotWork')} description={formError} /> : null}
      <Link href={`/bookings/${bookingId}`}>{t('dispute.back')}</Link>
    </main>
  );
}
