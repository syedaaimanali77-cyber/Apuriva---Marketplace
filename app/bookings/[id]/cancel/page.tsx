'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Button, Card, ConfirmDialog, ErrorState, Skeleton } from '@/components';
import type { CancellationConsequenceDto, CancellationDto } from '@/lib/types/cancellation';
import { apiFetch, mutateHeaders } from '../../booking-client';
import { describeTier } from '../../_components/CancellationPolicySection';
import { useLocale } from '@/app/_components/LocaleProvider';
import { formatMoney as formatLocaleMoney } from '@/lib/i18n/format';
import styles from '../../bookings.module.css';

type PageStatus = 'loading' | 'error' | 'ready' | 'cancelled';

/** A stable key per mounted screen, so a double-submit is a replay rather than a second cancellation. */
function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `cancel-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
  const { locale, t, errorText } = useLocale();
  // Spec 042 X-11: the shared formatter — the booking's own currency and its real fraction digits.
  const formatMoney = (minorUnits: number, currencyCode: string) => formatLocaleMoney(minorUnits, currencyCode, locale);
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
      setError(errorText(response.error?.code, response.error?.message, t('bookingCancel.loadFailed')));
      setStatus('error');
      return;
    }
    setPreview(response.data);
    setStatus('ready');
  }, [bookingId, errorText, t]);

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
      setError(errorText(response.error?.code, response.error?.message, t('bookingCancel.cancelFailed')));
      return;
    }
    setResult(response.data);
    setStatus('cancelled');
  }, [bookingId, errorText, idempotencyKey, t]);

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
        <ErrorState title={t('bookingCancel.unavailableTitle')} description={error ?? t('bookingCancel.tryAgain')} />
        <Link className={styles.eyebrowLink} href={`/bookings/${bookingId}`}>
          {t('bookingCancel.back')}
        </Link>
      </main>
    );
  }

  if (status === 'cancelled' && result) {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>{t('bookingCancel.cancelledTitle')}</h1>
        <Card>
          <dl className={styles.detailGrid}>
            <dt className={styles.detailLabel}>{t('bookingCancel.fee')}</dt>
            <dd className={styles.detailValue}>{formatMoney(result.feeAmountMinorUnits, result.currencyCode)}</dd>
            <dt className={styles.detailLabel}>{t('bookingCancel.refund')}</dt>
            <dd className={styles.detailValue}>{formatMoney(result.refundAmountMinorUnits, result.currencyCode)}</dd>
          </dl>
          {result.refundAmountMinorUnits > 0 ? (
            <p className={styles.hint}>{t('bookingCancel.refundPending')}</p>
          ) : (
            <p className={styles.hint}>{t('bookingCancel.noRefund')}</p>
          )}
        </Card>
        <Link className={styles.eyebrowLink} href={`/bookings/${bookingId}`}>
          {t('bookingCancel.back')}
        </Link>
      </main>
    );
  }

  if (!preview?.cancellable) {
    return (
      <main className={styles.page}>
        <ErrorState
          title={t('bookingCancel.notCancellableTitle')}
          description={
            preview?.blockedReason === 'BOOKING_ALREADY_CANCELLED' ? t('bookingCancel.alreadyCancelled') : t('bookingCancel.notAvailable')
          }
        />
        <Link className={styles.eyebrowLink} href={`/bookings/${bookingId}`}>
          {t('bookingCancel.back')}
        </Link>
      </main>
    );
  }

  const currency = preview.currencyCode ?? '';
  const fee = preview.feeAmountMinorUnits ?? 0;
  const refund = preview.refundAmountMinorUnits ?? 0;

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>{t('bookingCancel.title')}</h1>

      <Card>
        <dl className={styles.detailGrid}>
          <dt className={styles.detailLabel}>{t('bookingCancel.applies')}</dt>
          <dd className={styles.detailValue}>{preview.tier ? describeTier(t, preview.tier) : '—'}</dd>
          <dt className={styles.detailLabel}>{t('bookingCancel.charged')}</dt>
          <dd className={styles.detailValue}>{formatMoney(preview.capturedAmountMinorUnits ?? 0, currency)}</dd>
          <dt className={styles.detailLabel}>{t('bookingCancel.fee')}</dt>
          <dd className={styles.detailValue}>{formatMoney(fee, currency)}</dd>
          <dt className={styles.detailLabel}>{t('bookingCancel.youGetBack')}</dt>
          <dd className={styles.detailValue}>{formatMoney(refund, currency)}</dd>
        </dl>
        <p className={styles.hint}>{t('bookingCancel.calculatedHint')}</p>
      </Card>

      {error ? <ErrorState title={t('bookingCancel.failedTitle')} description={error} /> : null}

      <div className={styles.actions}>
        <Button onClick={() => setConfirming(true)} disabled={submitting}>
          {t('bookingCancel.cancel')}
        </Button>
        <Link className={styles.eyebrowLink} href={`/bookings/${bookingId}`}>
          {t('bookingCancel.keep')}
        </Link>
      </div>

      <ConfirmDialog
        open={confirming}
        title={t('bookingCancel.confirmTitle')}
        description={t('bookingCancel.confirmText', { fee: formatMoney(fee, currency), refund: formatMoney(refund, currency) })}
        confirmLabel={submitting ? t('bookingCancel.cancelling') : t('bookingCancel.yesCancel')}
        cancelLabel={t('bookingCancel.keep')}
        onConfirm={() => void submit()}
        onCancel={() => setConfirming(false)}
      />

      <button type="button" hidden onClick={() => router.refresh()} aria-hidden />
    </main>
  );
}
