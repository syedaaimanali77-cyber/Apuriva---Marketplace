'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Badge, Button, Card, ConfirmDialog, ErrorState, Skeleton } from '@/components';
import type { BookingDto } from '@/lib/types/bookings';
import type { PaymentDto, PriceAdjustmentDto } from '@/lib/types/payments';
import { apiFetch, mutateHeaders, type ApiErrorBody } from '../../booking-client';
import { CancellationPolicySection } from '../../_components/CancellationPolicySection';
import styles from './payment.module.css';

type PageStatus = 'loading' | 'error' | 'ready';

/** Master spec §105's exact payment wording. Never softened, never replaced with a guess. */
const PAYMENT_FAILED_HEADLINE = "Payment wasn't completed.";
const PAYMENT_FAILED_DETAIL = 'No charge was confirmed.';

/**
 * Spec 021 §5, `/bookings/{id}/payment` — the customer's payment screen.
 *
 * THE ONE RULE THIS COMPONENT EXISTS TO HOLD: never show an optimistic success. While the request
 * is in flight the screen says "Processing payment..." and nothing else; the booking is shown as
 * confirmed only once the server has returned a payment the provider actually captured
 * (master spec §132.7, §103). A failure shows §105's exact copy with Try Again / Change Payment
 * Method, and the booking is visibly still unconfirmed.
 *
 * Price-adjustment approval is a structured, high-risk financial confirmation (master spec §90's
 * "Financial/security" tier, bound to exact parameters): the dialog states the exact additional
 * amount and currency, so the amount approved is unambiguously the amount charged.
 *
 * Per CLAUDE.md's branding rule the page carries no logo of its own — the nav shell already
 * provides the one intentional brand placement.
 */
export default function BookingPaymentPage() {
  const params = useParams<{ id: string }>();
  const bookingId = params.id;

  const [status, setStatus] = useState<PageStatus>('loading');
  const [booking, setBooking] = useState<BookingDto | null>(null);
  const [payment, setPayment] = useState<PaymentDto | null>(null);
  const [adjustments, setAdjustments] = useState<PriceAdjustmentDto[]>([]);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiErrorBody | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<PriceAdjustmentDto | null>(null);

  const load = useCallback(async () => {
    const bookingResult = await apiFetch<BookingDto>(`/api/v1/bookings/${bookingId}`);
    if (!bookingResult.ok || !bookingResult.data) {
      setLoadError(bookingResult.error?.message ?? 'We could not load this booking.');
      setStatus('error');
      return;
    }
    setBooking(bookingResult.data);

    // A booking awaiting its first payment has no payment row yet: `404` here is the normal empty
    // state, not an error, and is deliberately NOT rendered as a failed payment.
    const paymentResult = await apiFetch<PaymentDto>(`/api/v1/bookings/${bookingId}/payment`);
    setPayment(paymentResult.ok && paymentResult.data ? paymentResult.data : null);

    const adjustmentResult = await apiFetch<PriceAdjustmentDto[]>(`/api/v1/bookings/${bookingId}/price-adjustments`);
    setAdjustments(adjustmentResult.ok && adjustmentResult.data ? adjustmentResult.data : []);

    setStatus('ready');
  }, [bookingId]);

  useEffect(() => {
    void load();
  }, [load]);

  const pay = useCallback(async () => {
    setPending(true);
    setFailure(null);

    const result = await apiFetch<PaymentDto>(`/api/v1/bookings/${bookingId}/payment/authorize`, {
      method: 'POST',
      // A fresh key per ATTEMPT: a retry after a decline is a new attempt, not a replay of the one
      // that failed, so reusing the key would be `409 IDEMPOTENCY_KEY_CONFLICT`.
      headers: mutateHeaders({ 'Idempotency-Key': crypto.randomUUID() }),
    });

    setPending(false);
    if (result.ok && result.data) {
      setPayment(result.data);
      await load();
      return;
    }
    setFailure(result.error ?? null);
  }, [bookingId, load]);

  const approveAdjustment = useCallback(
    async (adjustment: PriceAdjustmentDto) => {
      setPending(true);
      setFailure(null);

      const result = await apiFetch<PriceAdjustmentDto>(`/api/v1/price-adjustments/${adjustment.id}/approve`, {
        method: 'POST',
        headers: mutateHeaders({ 'Idempotency-Key': crypto.randomUUID() }),
      });

      setPending(false);
      setConfirming(null);
      if (!result.ok) setFailure(result.error ?? null);
      await load();
    },
    [load],
  );

  const rejectAdjustment = useCallback(
    async (adjustment: PriceAdjustmentDto) => {
      setPending(true);
      setFailure(null);

      const result = await apiFetch<PriceAdjustmentDto>(`/api/v1/price-adjustments/${adjustment.id}/reject`, {
        method: 'POST',
        headers: mutateHeaders({ 'Idempotency-Key': crypto.randomUUID() }),
      });

      setPending(false);
      if (!result.ok) setFailure(result.error ?? null);
      await load();
    },
    [load],
  );

  if (status === 'loading') {
    return (
      <main className={styles.page}>
        <Skeleton />
        <Skeleton />
      </main>
    );
  }

  if (status === 'error' || !booking) {
    return (
      <main className={styles.page}>
        <ErrorState title="We couldn't load this payment." description={loadError ?? undefined} onRetry={() => void load()} />
      </main>
    );
  }

  const paid = payment?.status === 'captured';
  const pendingApprovals = adjustments.filter((adjustment) => adjustment.status === 'pending_approval');

  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <p className={styles.eyebrow}>
          <Link className={styles.eyebrowLink} href={`/bookings/${booking.id}`}>
            Back to booking
          </Link>
        </p>
        <h1 className={styles.title}>Payment</h1>
        <p className={styles.subtitle}>
          Your booking is confirmed once payment is confirmed by the payment provider — not before.
        </p>
      </header>

      <Card>
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Amount due</h2>
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>Agreed price</span>
            <span className={styles.summaryValue}>{formatMoney(booking.priceAmountMinorUnits, booking.currencyCode)}</span>
          </div>

          {payment ? (
            <div className={styles.summaryRow}>
              <span className={styles.summaryLabel}>Payment status</span>
              <Badge>{PAYMENT_STATUS_LABELS[payment.status] ?? payment.status}</Badge>
            </div>
          ) : null}

          {/* Loading: an explicit progress statement, never an optimistic success. */}
          {pending ? <p className={styles.status}>Processing payment...</p> : null}

          {/*
            §105's payment pattern owns BOTH recovery actions, so there is exactly one "Try Again"
            on the page: ErrorState renders the retry, and "Change Payment Method" is its secondary
            action. Both re-run `pay()` with a fresh Idempotency-Key — a new attempt, never a replay
            of the one that failed.
          */}
          {failure && !pending ? (
            <ErrorState
              title={PAYMENT_FAILED_HEADLINE}
              description={failure.code === 'PAYMENT_FAILED' ? PAYMENT_FAILED_DETAIL : failure.message}
              onRetry={() => void pay()}
              retryLabel="Try Again"
              secondaryAction={
                <Button variant="secondary" onClick={() => void pay()} disabled={pending}>
                  Change Payment Method
                </Button>
              }
            />
          ) : null}

          {!paid ? (
            failure ? null : (
              <div className={styles.actions}>
                <Button onClick={() => void pay()} disabled={pending}>
                  Pay now
                </Button>
              </div>
            )
          ) : (
            <p className={styles.status}>Payment confirmed by the payment provider.</p>
          )}

          {payment?.protectionState ? (
            <p className={styles.protection}>
              {payment.protectionState === 'held'
                ? `Payment protection is active${payment.protectionWindowEndsAt ? ` until ${formatInstant(payment.protectionWindowEndsAt)}` : ''}.`
                : payment.protectionState === 'released'
                  ? 'Payment protection has ended and the provider is due to be paid.'
                  : 'Payment protection is on hold while this booking is in dispute.'}
            </p>
          ) : null}
        </section>
      </Card>

      {adjustments.length > 0 ? (
        <Card>
          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Price changes</h2>
            <ul className={styles.adjustmentList}>
              {adjustments.map((adjustment) => (
                <li key={adjustment.id}>
                  <div className={styles.summaryRow}>
                    <span className={styles.summaryLabel}>Additional charge</span>
                    <span className={styles.summaryValue}>
                      {formatMoney(adjustment.additionalAmountMinorUnits, adjustment.additionalCurrencyCode)}
                    </span>
                  </div>
                  <p className={styles.adjustmentReason}>{adjustment.reason}</p>
                  {adjustment.status === 'pending_approval' ? (
                    <div className={styles.actions}>
                      <Button onClick={() => setConfirming(adjustment)} disabled={pending}>
                        Review and approve
                      </Button>
                      <Button variant="secondary" onClick={() => void rejectAdjustment(adjustment)} disabled={pending}>
                        Decline
                      </Button>
                    </div>
                  ) : (
                    <Badge>{ADJUSTMENT_STATUS_LABELS[adjustment.status] ?? adjustment.status}</Badge>
                  )}
                </li>
              ))}
            </ul>
            {pendingApprovals.length > 0 ? (
              <p className={styles.status}>Nothing extra is charged unless you approve it.</p>
            ) : null}
          </section>
        </Card>
      ) : null}

      {/*
        Master spec §90's financial-tier confirmation: bound to exact parameters. The dialog names
        the exact amount and currency, so what the customer approves is unambiguously what is
        charged — §132.15 "do not silently change confirmed prices".
      */}
      {/* Spec 023 §5 / AC-1: the snapshotted policy, shown BEFORE the customer authorizes payment —
          the terms displayed here are the terms enforced if they later cancel. */}
      <CancellationPolicySection bookingId={bookingId} />

      <ConfirmDialog
        open={confirming !== null}
        title="Approve this additional charge?"
        description={
          confirming
            ? `You will be charged an additional ${formatMoney(confirming.additionalAmountMinorUnits, confirming.additionalCurrencyCode)} for: ${confirming.reason}. Nothing is charged until you approve.`
            : ''
        }
        confirmLabel="Approve and pay"
        tone="primary"
        pending={pending}
        onConfirm={() => {
          if (confirming) void approveAdjustment(confirming);
        }}
        onCancel={() => setConfirming(null)}
      />
    </main>
  );
}

const PAYMENT_STATUS_LABELS: Record<string, string> = {
  created: 'Not yet paid',
  requires_action: 'Extra verification needed',
  authorized: 'Authorized',
  captured: 'Paid',
  failed: 'Not completed',
  refunded: 'Refunded',
  partially_refunded: 'Partly refunded',
};

const ADJUSTMENT_STATUS_LABELS: Record<string, string> = {
  pending_approval: 'Waiting for your approval',
  approved: 'Approved',
  rejected: 'Declined',
  charged: 'Charged',
  failed: 'Not completed',
};

function formatMoney(amountMinorUnits: number, currencyCode: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currencyCode }).format(amountMinorUnits / 100);
  } catch {
    return `${currencyCode} ${(amountMinorUnits / 100).toFixed(2)}`;
  }
}

function formatInstant(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  } catch {
    return iso;
  }
}
