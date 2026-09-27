'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Badge, Button, Card, ConfirmDialog, ErrorState, Skeleton } from '@/components';
import type { BookingDto } from '@/lib/types/bookings';
import type { PaymentDto, PriceAdjustmentDto } from '@/lib/types/payments';
import { apiFetch, mutateHeaders, type ApiErrorBody } from '../../booking-client';
import { CancellationPolicySection } from '../../_components/CancellationPolicySection';
import { useLocale } from '@/app/_components/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/dictionaries/en';
import { formatDateTime, formatMoney as formatLocaleMoney } from '@/lib/i18n/format';
import styles from './payment.module.css';

type PageStatus = 'loading' | 'error' | 'ready';

/** Master spec §105's exact payment wording (spec 042: its translations say the same). Never softened, never replaced with a guess. */
const PAYMENT_FAILED_HEADLINE: MessageKey = 'payment.failedHeadline';
const PAYMENT_FAILED_DETAIL: MessageKey = 'payment.failedDetail';

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
  const { locale, t, errorText } = useLocale();
  const formatMoney = (amountMinorUnits: number, currencyCode: string) => formatLocaleMoney(amountMinorUnits, currencyCode, locale);
  const formatInstant = (iso: string) => formatInstantIn(iso, locale);
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
      setLoadError(errorText(bookingResult.error?.code, bookingResult.error?.message, t('payment.loadFailed')));
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
  }, [bookingId, errorText, t]);

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
        <ErrorState title={t('payment.errorTitle')} description={loadError ?? undefined} onRetry={() => void load()} />
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
            {t('payment.back')}
          </Link>
        </p>
        <h1 className={styles.title}>{t('payment.title')}</h1>
        <p className={styles.subtitle}>{t('payment.subtitle')}</p>
      </header>

      <Card>
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>{t('payment.amountDue')}</h2>
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>{t('payment.agreedPrice')}</span>
            <span className={styles.summaryValue}>{formatMoney(booking.priceAmountMinorUnits, booking.currencyCode)}</span>
          </div>

          {payment ? (
            <div className={styles.summaryRow}>
              <span className={styles.summaryLabel}>{t('payment.paymentStatus')}</span>
              <Badge>{PAYMENT_STATUS_LABELS[payment.status] ? t(PAYMENT_STATUS_LABELS[payment.status]!) : payment.status}</Badge>
            </div>
          ) : null}

          {/* Loading: an explicit progress statement, never an optimistic success. */}
          {pending ? <p className={styles.status}>{t('payment.processing')}</p> : null}

          {/*
            §105's payment pattern owns BOTH recovery actions, so there is exactly one "Try Again"
            on the page: ErrorState renders the retry, and "Change Payment Method" is its secondary
            action. Both re-run `pay()` with a fresh Idempotency-Key — a new attempt, never a replay
            of the one that failed.
          */}
          {failure && !pending ? (
            <ErrorState
              title={t(PAYMENT_FAILED_HEADLINE)}
              description={failure.code === 'PAYMENT_FAILED' ? t(PAYMENT_FAILED_DETAIL) : errorText(failure.code, failure.message)}
              onRetry={() => void pay()}
              retryLabel={t('payment.tryAgain')}
              secondaryAction={
                <Button variant="secondary" onClick={() => void pay()} disabled={pending}>
                  {t('payment.changeMethod')}
                </Button>
              }
            />
          ) : null}

          {!paid ? (
            failure ? null : (
              <div className={styles.actions}>
                <Button onClick={() => void pay()} disabled={pending}>
                  {t('payment.payNow')}
                </Button>
              </div>
            )
          ) : (
            <p className={styles.status}>{t('payment.confirmed')}</p>
          )}

          {payment?.protectionState ? (
            <p className={styles.protection}>
              {payment.protectionState === 'held'
                ? payment.protectionWindowEndsAt
                  ? t('payment.protectionActiveUntil', { when: formatInstant(payment.protectionWindowEndsAt) })
                  : t('payment.protectionActive')
                : payment.protectionState === 'released'
                  ? t('payment.protectionReleased')
                  : t('payment.protectionDisputed')}
            </p>
          ) : null}
        </section>
      </Card>

      {adjustments.length > 0 ? (
        <Card>
          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>{t('payment.priceChanges')}</h2>
            <ul className={styles.adjustmentList}>
              {adjustments.map((adjustment) => (
                <li key={adjustment.id}>
                  <div className={styles.summaryRow}>
                    <span className={styles.summaryLabel}>{t('payment.additionalCharge')}</span>
                    <span className={styles.summaryValue}>
                      {formatMoney(adjustment.additionalAmountMinorUnits, adjustment.additionalCurrencyCode)}
                    </span>
                  </div>
                  <p className={styles.adjustmentReason}>{adjustment.reason}</p>
                  {adjustment.status === 'pending_approval' ? (
                    <div className={styles.actions}>
                      <Button onClick={() => setConfirming(adjustment)} disabled={pending}>
                        {t('payment.reviewApprove')}
                      </Button>
                      <Button variant="secondary" onClick={() => void rejectAdjustment(adjustment)} disabled={pending}>
                        {t('payment.decline')}
                      </Button>
                    </div>
                  ) : (
                    <Badge>
                      {ADJUSTMENT_STATUS_LABELS[adjustment.status] ? t(ADJUSTMENT_STATUS_LABELS[adjustment.status]!) : adjustment.status}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
            {pendingApprovals.length > 0 ? (
              <p className={styles.status}>{t('payment.nothingExtra')}</p>
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
        title={t('payment.approveTitle')}
        description={
          confirming
            ? t('payment.approveText', {
                amount: formatMoney(confirming.additionalAmountMinorUnits, confirming.additionalCurrencyCode),
                reason: confirming.reason,
              })
            : ''
        }
        confirmLabel={t('payment.approveAndPay')}
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

const PAYMENT_STATUS_LABELS: Record<string, MessageKey> = {
  created: 'payment.status.created',
  requires_action: 'payment.status.requires_action',
  authorized: 'payment.status.authorized',
  captured: 'payment.status.captured',
  failed: 'payment.status.failed',
  refunded: 'payment.status.refunded',
  partially_refunded: 'payment.status.partially_refunded',
};

const ADJUSTMENT_STATUS_LABELS: Record<string, MessageKey> = {
  pending_approval: 'payment.adjustmentStatus.pending_approval',
  approved: 'payment.adjustmentStatus.approved',
  rejected: 'payment.adjustmentStatus.rejected',
  charged: 'payment.adjustmentStatus.charged',
  failed: 'payment.adjustmentStatus.failed',
};

/** Spec 042 X-11: the shared formatter, in the reader's locale. */
function formatInstantIn(iso: string, locale: string): string {
  try {
    return formatDateTime(iso, locale, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}
