'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Button, Card, ConfirmDialog, ErrorState, Skeleton } from '@/components';
import type { CancellationConsequenceDto, CancellationDto } from '@/lib/types/cancellation';
import { apiFetch, mutateHeaders } from '../../booking-client';
import { describeTier } from '../../_components/CancellationPolicySection';
import styles from '../../bookings.module.css';

type PageStatus = 'loading' | 'error' | 'ready' | 'cancelled';

/** A stable key per mounted screen, so a double-submit is a replay rather than a second cancellation. */
function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `cancel-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatMoney(minorUnits: number, currencyCode: string): string {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currencyCode }).format(minorUnits / 100);
  } catch {
    return `${(minorUnits / 100).toFixed(2)} ${currencyCode}`;
  }
}

/**
 * Spec 023 §5 — the cancellation screen (AC-3).
 *
 * Master spec §38 requires the financial consequence be shown BEFORE confirmation, so this screen
 * loads the server's `cancel-preview` first and states the exact fee and exact refund in the
 * booking's own currency. The customer confirms a number they have already been shown; nothing is
 * ever computed here, and the request body carries no amount — the server recomputes under the
 * booking row lock and its value is authoritative.
 *
 * Built entirely from existing primitives (`Card`, `Button`, `ConfirmDialog`, `ErrorState`,
 * `Skeleton`) and the booking screens' existing module CSS. No visual redesign, no new token, no
 * brand mark.
 */
export default function CancelBookingPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const bookingId = params.id;

  const [status, setStatus] = useState<PageStatus>('loading');
  const [preview, setPreview] = useState<CancellationConsequenceDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CancellationDto | null>(null);
  const [idempotencyKey] = useState(newIdempotencyKey);

  const load = useCallback(async () => {
    const response = await apiFetch<CancellationConsequenceDto>(`/api/v1/bookings/${bookingId}/cancel-preview`);
    if (!response.ok || !response.data) {
      setError(response.error?.message ?? 'This booking could not be loaded.');
      setStatus('error');
      return;
    }
    setPreview(response.data);
    setStatus('ready');
  }, [bookingId]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    const response = await apiFetch<CancellationDto>(`/api/v1/bookings/${bookingId}/cancel`, {
      method: 'POST',
      headers: mutateHeaders({ 'Idempotency-Key': idempotencyKey }),
      body: JSON.stringify({}),
    });
    setSubmitting(false);
    setConfirming(false);

    if (!response.ok || !response.data) {
      setError(response.error?.message ?? 'This booking could not be cancelled.');
      return;
    }
    setResult(response.data);
    setStatus('cancelled');
  }, [bookingId, idempotencyKey]);

  if (status === 'loading') {
    return (
      <main className={styles.page}>
        <Skeleton />
      </main>
    );
  }

  if (status === 'error') {
    return (
      <main className={styles.page}>
        <ErrorState title="Cancellation unavailable" description={error ?? 'Please try again.'} />
        <Link className={styles.eyebrowLink} href={`/bookings/${bookingId}`}>
          Back to booking
        </Link>
      </main>
    );
  }

  if (status === 'cancelled' && result) {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>Booking cancelled</h1>
        <Card>
          <dl className={styles.detailGrid}>
            <dt className={styles.detailLabel}>Cancellation fee</dt>
            <dd className={styles.detailValue}>{formatMoney(result.feeAmountMinorUnits, result.currencyCode)}</dd>
            <dt className={styles.detailLabel}>Refund</dt>
            <dd className={styles.detailValue}>{formatMoney(result.refundAmountMinorUnits, result.currencyCode)}</dd>
          </dl>
          {result.refundAmountMinorUnits > 0 ? (
            <p className={styles.hint}>
              Your refund is being processed. You can follow its progress on the booking page — it is only shown as
              refunded once your payment provider confirms it.
            </p>
          ) : (
            <p className={styles.hint}>No refund is due under the policy that applied to this booking.</p>
          )}
        </Card>
        <Link className={styles.eyebrowLink} href={`/bookings/${bookingId}`}>
          Back to booking
        </Link>
      </main>
    );
  }

  if (!preview?.cancellable) {
    return (
      <main className={styles.page}>
        <ErrorState
          title="This booking cannot be cancelled"
          description={
            preview?.blockedReason === 'BOOKING_ALREADY_CANCELLED'
              ? 'It has already been cancelled.'
              : 'Cancellation is not available for a booking at this stage. Contact support if you need help.'
          }
        />
        <Link className={styles.eyebrowLink} href={`/bookings/${bookingId}`}>
          Back to booking
        </Link>
      </main>
    );
  }

  const currency = preview.currencyCode ?? '';
  const fee = preview.feeAmountMinorUnits ?? 0;
  const refund = preview.refundAmountMinorUnits ?? 0;

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Cancel this booking</h1>

      <Card>
        <dl className={styles.detailGrid}>
          <dt className={styles.detailLabel}>Applies</dt>
          <dd className={styles.detailValue}>{preview.tier ? describeTier(preview.tier) : '—'}</dd>
          <dt className={styles.detailLabel}>Amount charged</dt>
          <dd className={styles.detailValue}>{formatMoney(preview.capturedAmountMinorUnits ?? 0, currency)}</dd>
          <dt className={styles.detailLabel}>Cancellation fee</dt>
          <dd className={styles.detailValue}>{formatMoney(fee, currency)}</dd>
          <dt className={styles.detailLabel}>You get back</dt>
          <dd className={styles.detailValue}>{formatMoney(refund, currency)}</dd>
        </dl>
        <p className={styles.hint}>
          This is calculated from the cancellation policy that applied when you booked, and from the amount actually
          charged. Cancelling cannot be undone.
        </p>
      </Card>

      {error ? <ErrorState title="Cancellation failed" description={error} /> : null}

      <div className={styles.actions}>
        <Button onClick={() => setConfirming(true)} disabled={submitting}>
          Cancel booking
        </Button>
        <Link className={styles.eyebrowLink} href={`/bookings/${bookingId}`}>
          Keep booking
        </Link>
      </div>

      <ConfirmDialog
        open={confirming}
        title="Cancel this booking?"
        description={`A fee of ${formatMoney(fee, currency)} applies and ${formatMoney(refund, currency)} will be refunded. This cannot be undone.`}
        confirmLabel={submitting ? 'Cancelling…' : 'Yes, cancel'}
        cancelLabel="Keep booking"
        onConfirm={() => void submit()}
        onCancel={() => setConfirming(false)}
      />

      <button type="button" hidden onClick={() => router.refresh()} aria-hidden />
    </main>
  );
}
