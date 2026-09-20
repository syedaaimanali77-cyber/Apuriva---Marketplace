'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Badge, Button, Card, ErrorState, Select, Skeleton, Textarea } from '@/components';
import { apiFetch, mutateHeaders } from '@/app/requests/api-client';
import type { AdminDisputeDto, DisputeDecision, DisputeMessageDto } from '@/lib/types/disputes';
import { MAX_DISPUTE_REASONING_LENGTH, MIN_DISPUTE_REASONING_LENGTH } from '@/lib/disputes/limits';
import styles from '../../../admin.module.css';

const DECISIONS: { value: DisputeDecision; label: string }[] = [
  { value: 'no_action', label: 'No action' },
  { value: 'favour_provider', label: 'Decide in the provider’s favour' },
  { value: 'mutual_resolution', label: 'Resolved by agreement' },
  { value: 'partial_refund_customer', label: 'Propose a partial refund to the customer' },
  { value: 'refund_customer', label: 'Propose a full refund to the customer' },
];

const REFUND_DECISIONS: DisputeDecision[] = ['refund_customer', 'partial_refund_customer'];

function newIdempotencyKey(prefix: string): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Spec 031 §5 — one dispute in full, for a Trust & Safety admin.
 *
 * THE AI SUMMARY IS PRESENTED AS A SUGGESTION, NEVER A VERDICT (AC-6). It sits under an explicit
 * "AI suggestion — not a decision" heading BELOW the parties' own words, for the reason spec 030's
 * queue gives: a screen that led with a machine's paraphrase is the easiest way for a tired admin
 * to stop reading what a person actually wrote. Nothing on this screen sends it back to the server,
 * and no server path would accept it if it did.
 *
 * THERE IS NO REFUND CONTROL HERE (DECIDED-5). Choosing a refund decision records a PROPOSED
 * amount; the money is moved by a Finance Admin through spec 022's existing override, approved by a
 * second admin. This screen says so in as many words rather than implying a refund has been sent.
 *
 * THERE IS NO SANCTION CONTROL either. "Escalate to Trust & Safety" files a spec 030 report; it
 * restricts nobody, and enforcement is spec 038's.
 */
export default function AdminDisputeDetailPage() {
  const params = useParams<{ id: string }>();
  const disputeId = params.id;

  const [dispute, setDispute] = useState<AdminDisputeDto | null>(null);
  const [messages, setMessages] = useState<DisputeMessageDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [decision, setDecision] = useState<DisputeDecision>('no_action');
  const [reasoning, setReasoning] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('');
  const [appealOutcome, setAppealOutcome] = useState<'upheld' | 'overturned' | 'partially_upheld'>('upheld');
  const [appealReasoning, setAppealReasoning] = useState('');

  const load = useCallback(async () => {
    const response = await apiFetch<AdminDisputeDto>(`/api/v1/admin/disputes/${disputeId}`);
    if (!response.ok) {
      setError(response.error?.message ?? 'This dispute could not be loaded.');
      return;
    }
    setDispute(response.data ?? null);
    const thread = await apiFetch<DisputeMessageDto[]>(`/api/v1/disputes/${disputeId}/messages`);
    setMessages(thread.ok ? thread.data ?? [] : []);
  }, [disputeId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function claim() {
    setBusy(true);
    setFormError(null);
    const response = await apiFetch(`/api/v1/admin/disputes/${disputeId}/claim`, {
      method: 'POST',
      headers: { ...mutateHeaders(), 'Idempotency-Key': newIdempotencyKey('claim') },
      body: JSON.stringify({}),
    });
    setBusy(false);
    if (!response.ok) setFormError(response.error?.message ?? 'This dispute could not be claimed.');
    await load();
  }

  async function resolve() {
    setBusy(true);
    setFormError(null);
    const wantsRefund = REFUND_DECISIONS.includes(decision);
    const response = await apiFetch(`/api/v1/admin/disputes/${disputeId}/resolve`, {
      method: 'POST',
      headers: { ...mutateHeaders(), 'Idempotency-Key': newIdempotencyKey('resolve') },
      body: JSON.stringify({
        decision,
        reasoning,
        ...(wantsRefund
          ? { proposedRefundAmountMinorUnits: Number(amount), proposedRefundCurrencyCode: currency.toUpperCase() }
          : {}),
      }),
    });
    setBusy(false);
    if (!response.ok) {
      setFormError(response.error?.message ?? 'This dispute could not be resolved.');
      return;
    }
    setReasoning('');
    setAmount('');
    await load();
  }

  async function decideTheAppeal() {
    setBusy(true);
    setFormError(null);
    const response = await apiFetch(`/api/v1/admin/disputes/${disputeId}/appeal-decision`, {
      method: 'POST',
      headers: { ...mutateHeaders(), 'Idempotency-Key': newIdempotencyKey('appeal-decision') },
      body: JSON.stringify({ outcome: appealOutcome, reasoning: appealReasoning }),
    });
    setBusy(false);
    if (!response.ok) {
      setFormError(response.error?.message ?? 'The appeal decision could not be recorded.');
      return;
    }
    setAppealReasoning('');
    await load();
  }

  if (error) {
    return (
      <main className={styles.page}>
        <ErrorState title="We could not load this dispute" description={error} />
        <Link href="/admin/operations/disputes">Back to the queue</Link>
      </main>
    );
  }

  if (!dispute) {
    return (
      <main className={styles.page}>
        <Skeleton height={48} />
        <Skeleton height={160} />
        <Skeleton height={200} />
      </main>
    );
  }

  const canResolve = dispute.status === 'open' || dispute.status === 'under_review';

  return (
    <main className={styles.page}>
      <h1>Dispute</h1>

      <Card>
        <Badge>{dispute.status.replace(/_/g, ' ')}</Badge>
        {dispute.legalHold ? <Badge>Legal hold</Badge> : null}
        <p>
          <strong>What the opener said</strong>
        </p>
        <p>{dispute.reason}</p>
        <p>
          {dispute.evidenceCount} piece{dispute.evidenceCount === 1 ? '' : 's'} of evidence · {dispute.messageCount}{' '}
          message{dispute.messageCount === 1 ? '' : 's'}
        </p>
        <Link href={`/bookings/${dispute.bookingId}`}>View the booking</Link>
      </Card>

      <Card>
        <h2>Messages</h2>
        {messages.length === 0 ? (
          <p>No messages.</p>
        ) : (
          <ul>
            {messages.map((message) => (
              <li key={message.id}>
                <strong>{message.isAdmin ? 'Apuriva' : 'A party'}</strong>
                <p>{message.body}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Below the parties' own words, and explicitly labelled. Nothing reads it back. */}
      {dispute.aiSummary ? (
        <Card>
          <h2>AI suggestion — not a decision</h2>
          <p>{dispute.aiSummary}</p>
        </Card>
      ) : null}

      {dispute.resolution ? (
        <Card>
          <h2>Recorded decision</h2>
          <p>
            <strong>{dispute.resolution.decision.replace(/_/g, ' ')}</strong>
          </p>
          <p>{dispute.resolution.reasoning}</p>
          {dispute.resolution.proposedRefundAmountMinorUnits !== null ? (
            <p>
              Proposed refund: {dispute.resolution.proposedRefundAmountMinorUnits}{' '}
              {dispute.resolution.proposedRefundCurrencyCode} (minor units) — state:{' '}
              {dispute.resolution.refundState}. A Finance Admin initiates this through Refunds; a second admin
              approves it. Nothing is sent from this screen.
            </p>
          ) : null}
        </Card>
      ) : null}

      {dispute.status === 'open' ? (
        <Card>
          <Button onClick={() => void claim()} disabled={busy}>
            Start reviewing it
          </Button>
        </Card>
      ) : null}

      {canResolve ? (
        <Card>
          <h2>Record a decision</h2>
          <label htmlFor="dispute-decision">Decision</label>
          <Select
            id="dispute-decision"
            value={decision}
            onChange={(event: React.ChangeEvent<HTMLSelectElement>) => setDecision(event.target.value as DisputeDecision)}
            options={DECISIONS}
            disabled={busy}
          />
          <label htmlFor="dispute-reasoning">Reasoning (shown to both parties)</label>
          <Textarea
            id="dispute-reasoning"
            value={reasoning}
            onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setReasoning(event.target.value)}
            maxLength={MAX_DISPUTE_REASONING_LENGTH}
            disabled={busy}
          />
          {REFUND_DECISIONS.includes(decision) ? (
            <>
              <p>
                This records a <strong>proposed</strong> refund. It does not send money: a Finance Admin initiates it
                and a second admin approves it.
              </p>
              <label>
                Amount in minor units
                <input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="numeric" />
              </label>
              <label>
                Currency code
                <input value={currency} onChange={(event) => setCurrency(event.target.value)} maxLength={3} />
              </label>
            </>
          ) : null}
          <Button
            onClick={() => void resolve()}
            disabled={busy || reasoning.trim().length < MIN_DISPUTE_REASONING_LENGTH}
          >
            Record this decision
          </Button>
        </Card>
      ) : null}

      {dispute.status === 'appealed' && dispute.appeal && !dispute.appeal.outcome ? (
        <Card>
          <h2>Decide the appeal</h2>
          <p>{dispute.appeal.reason}</p>
          <p>
            This must be decided by a different admin from the one who recorded the original decision. The original
            decision is never edited — your outcome is recorded alongside it.
          </p>
          <label htmlFor="dispute-appeal-outcome">Outcome</label>
          <Select
            id="dispute-appeal-outcome"
            value={appealOutcome}
            onChange={(event: React.ChangeEvent<HTMLSelectElement>) => setAppealOutcome(event.target.value as typeof appealOutcome)}
            disabled={busy}
            options={[
              { value: 'upheld', label: 'Uphold the original decision' },
              { value: 'partially_upheld', label: 'Partially uphold it' },
              { value: 'overturned', label: 'Overturn it' },
            ]}
          />
          <label htmlFor="dispute-appeal-reasoning">Reasoning (shown to both parties)</label>
          <Textarea
            id="dispute-appeal-reasoning"
            value={appealReasoning}
            onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setAppealReasoning(event.target.value)}
            maxLength={MAX_DISPUTE_REASONING_LENGTH}
            disabled={busy}
          />
          <Button
            onClick={() => void decideTheAppeal()}
            disabled={busy || appealReasoning.trim().length < MIN_DISPUTE_REASONING_LENGTH}
          >
            Record the appeal decision
          </Button>
        </Card>
      ) : null}

      {formError ? <ErrorState title="That did not work" description={formError} /> : null}
      <Link href="/admin/operations/disputes">Back to the queue</Link>
    </main>
  );
}
