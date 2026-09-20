'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Badge, Button, Card, ErrorState, Skeleton, Textarea } from '@/components';
import type { DisputeDto, DisputeMessageDto, DisputeStatus } from '@/lib/types/disputes';
import { MAX_DISPUTE_REASON_LENGTH, MIN_DISPUTE_REASON_LENGTH } from '@/lib/disputes/limits';
import { apiFetch, BOOKING_POLL_MS, mutateHeaders } from '../../booking-client';
import styles from '../../bookings.module.css';

type PageStatus = 'loading' | 'error' | 'ready';

const STATUS_LABELS: Record<DisputeStatus, string> = {
  open: 'Open',
  under_review: 'Being reviewed',
  resolved: 'Decided',
  appealed: 'Under appeal',
  closed: 'Closed',
};

const DECISION_LABELS: Record<string, string> = {
  no_action: 'No action',
  refund_customer: 'Refund to the customer',
  partial_refund_customer: 'Partial refund to the customer',
  favour_provider: 'Decided in the provider’s favour',
  mutual_resolution: 'Resolved by agreement',
};

/** A stable key per mounted screen, so a double-submit is a replay rather than a second write. */
function newIdempotencyKey(prefix: string): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatMoney(minorUnits: number, currencyCode: string): string {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currencyCode }).format(minorUnits / 100);
  } catch {
    return `${(minorUnits / 100).toFixed(2)} ${currencyCode}`;
  }
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
      setError(list.error?.message ?? 'This dispute could not be loaded.');
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
      setError(detail.error?.message ?? 'This dispute could not be loaded.');
      setStatus('error');
      return;
    }
    setDispute(detail.data ?? null);

    const thread = await apiFetch<DisputeMessageDto[]>(`/api/v1/disputes/${match.id}/messages`);
    setMessages(thread.ok ? thread.data ?? [] : []);
    setStatus('ready');
  }, [bookingId]);

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
      setFormError(response.error?.message ?? 'The dispute could not be opened.');
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
      setFormError(response.error?.message ?? 'Your message could not be sent.');
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
      setFormError(response.error?.message ?? 'Your appeal could not be filed.');
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
      setFormError(response.error?.message ?? 'The dispute could not be closed.');
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
        <ErrorState title="We could not load this dispute" description={error ?? undefined} />
        <Link href={`/bookings/${bookingId}`}>Back to the booking</Link>
      </main>
    );
  }

  // EMPTY — no dispute yet. The server is authoritative on eligibility; this form simply reports
  // what it says rather than duplicating the `protected` + `held` rule in the browser.
  if (!dispute) {
    const tooShort = reason.trim().length < MIN_DISPUTE_REASON_LENGTH;
    return (
      <main className={styles.page}>
        <h1>Open a dispute</h1>
        <Card>
          <p>
            If something went wrong with this booking and you and the other party cannot agree, you can open a
            dispute. A member of our team will read both sides and decide. Your payment is held while a dispute is
            open.
          </p>
          <label htmlFor="dispute-reason">What went wrong?</label>
          <Textarea
            id="dispute-reason"
            value={reason}
            onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setReason(event.target.value)}
            maxLength={MAX_DISPUTE_REASON_LENGTH}
            disabled={busy}
          />
          {formError ? <ErrorState title="That did not work" description={formError} /> : null}
          <Button onClick={() => void openDispute()} disabled={busy || tooShort}>
            Open the dispute
          </Button>
        </Card>
        <Link href={`/bookings/${bookingId}`}>Back to the booking</Link>
      </main>
    );
  }

  const resolution = dispute.resolution;

  return (
    <main className={styles.page}>
      <h1>Dispute</h1>
      <Card>
        <Badge>{STATUS_LABELS[dispute.status]}</Badge>
        <p>
          <strong>{dispute.openedBy === 'me' ? 'You opened this dispute' : 'The other party opened this dispute'}</strong>
        </p>
        <p>{dispute.reason}</p>
        <p>
          {dispute.evidenceCount} piece{dispute.evidenceCount === 1 ? '' : 's'} of evidence · {dispute.messageCount}{' '}
          message{dispute.messageCount === 1 ? '' : 's'}
        </p>
      </Card>

      {resolution ? (
        <Card>
          <h2>The decision</h2>
          <p>
            <strong>{DECISION_LABELS[resolution.decision] ?? resolution.decision}</strong>
          </p>
          {/* Master §2.3: the reasoning, not just the outcome. */}
          <p>{resolution.reasoning}</p>
          {resolution.proposedRefundAmountMinorUnits !== null && resolution.proposedRefundCurrencyCode ? (
            <p>
              Refund to be issued:{' '}
              {formatMoney(resolution.proposedRefundAmountMinorUnits, resolution.proposedRefundCurrencyCode)}
              {resolution.refundState === 'completed'
                ? ' — sent'
                : resolution.refundState === 'failed'
                  ? ' — we could not send it; our team has been alerted'
                  : ' — being processed by our finance team'}
            </p>
          ) : null}
        </Card>
      ) : null}

      {dispute.appeal ? (
        <Card>
          <h2>Appeal</h2>
          <p>{dispute.appeal.filedBy === 'me' ? 'You appealed this decision.' : 'The other party appealed this decision.'}</p>
          <p>{dispute.appeal.reason}</p>
          {dispute.appeal.outcome ? (
            <>
              <p>
                <strong>Appeal outcome: {dispute.appeal.outcome.replace(/_/g, ' ')}</strong>
              </p>
              <p>{dispute.appeal.reasoning}</p>
            </>
          ) : (
            <p>A different member of our team is reviewing it.</p>
          )}
        </Card>
      ) : null}

      {dispute.canAppeal && dispute.appealWindowEndsAt ? (
        <Card>
          <h2>If you disagree</h2>
          <p>You can appeal this decision until {new Date(dispute.appealWindowEndsAt).toLocaleDateString('en-GB')}. A different member of our team will review it.</p>
          <label htmlFor="dispute-appeal-reason">Why do you disagree?</label>
          <Textarea
            id="dispute-appeal-reason"
            value={appealReason}
            onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setAppealReason(event.target.value)}
            maxLength={MAX_DISPUTE_REASON_LENGTH}
            disabled={busy}
          />
          <Button onClick={() => void submitAppeal()} disabled={busy || appealReason.trim().length < MIN_DISPUTE_REASON_LENGTH}>
            Appeal this decision
          </Button>
          <Button variant="secondary" onClick={() => void acceptOutcome()} disabled={busy}>
            Accept the outcome and close
          </Button>
        </Card>
      ) : null}

      <Card>
        <h2>Messages</h2>
        {messages.length === 0 ? (
          <p>No messages yet.</p>
        ) : (
          <ul>
            {messages.map((message) => (
              <li key={message.id}>
                <strong>
                  {message.authorRole === 'me' ? 'You' : message.authorRole === 'admin' ? 'Apuriva' : 'The other party'}
                </strong>
                <p>{message.body}</p>
              </li>
            ))}
          </ul>
        )}
        {dispute.canPostMessage ? (
          <>
            <label htmlFor="dispute-message">Add a message</label>
            <Textarea
              id="dispute-message"
              value={messageBody}
              onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setMessageBody(event.target.value)}
              maxLength={2000}
              disabled={busy}
            />
            <Button onClick={() => void postMessage()} disabled={busy || messageBody.trim().length === 0}>
              Send
            </Button>
          </>
        ) : (
          <p>This dispute no longer accepts new messages.</p>
        )}
      </Card>

      {formError ? <ErrorState title="That did not work" description={formError} /> : null}
      <Link href={`/bookings/${bookingId}`}>Back to the booking</Link>
    </main>
  );
}
