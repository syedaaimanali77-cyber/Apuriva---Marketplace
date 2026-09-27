'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Card } from '@/components';
import { useLocale } from '@/app/_components/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/dictionaries/en';
import { formatDateTime, formatMoney } from '@/lib/i18n/format';
import type { RefundDto } from '@/lib/types/refunds';
import { apiFetch, BOOKING_POLL_MS } from '../booking-client';
import styles from '../bookings.module.css';

/**
 * Spec 022 §5 "Customer" — the refund section on the booking detail screen.
 *
 * TWO RULES THIS COMPONENT EXISTS TO HOLD:
 *
 *  1. **Never show a refund as done before the provider confirmed it.** `requested`/`processing`
 *     render as "Refund in progress"; only `completed` says the money is back. Master spec §132.7
 *     applies to refunds exactly as it does to payments.
 *  2. **A failed refund is honest and not a dead end.** It states that this attempt did not return
 *     any money and points to support, without exposing the provider's failure code.
 *
 * Live updates use spec 020's EXISTING polling (`BOOKING_POLL_MS`, plus a refetch on window focus)
 * — there is no WebSocket layer in this repository and this spec introduces none. Polling stops as
 * soon as every refund is terminal, so a settled booking is not polled forever.
 */
export function RefundSection({ bookingId, scheduledTimezone }: { bookingId: string; scheduledTimezone: string }) {
  const { locale, t } = useLocale();
  const [refunds, setRefunds] = useState<RefundDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const liveRef = useRef(true);

  const load = useCallback(async () => {
    const result = await apiFetch<RefundDto[]>(`/api/v1/bookings/${bookingId}/refunds`);

    // Only an actual list is treated as refunds. A `404`, an error envelope, or any unexpected
    // shape stops the polling rather than retrying forever — an endpoint that is not answering
    // usefully will not start doing so because we ask every ten seconds.
    const rows = result.ok && Array.isArray(result.data) ? result.data : [];
    setRefunds(rows);
    liveRef.current = rows.some((refund) => refund.status === 'requested' || refund.status === 'processing');

    setLoaded(true);
  }, [bookingId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const tick = () => {
      if (liveRef.current) void load();
    };
    const timer = setInterval(tick, BOOKING_POLL_MS);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', tick);
    };
  }, [load]);

  // A booking with no refunds renders nothing at all — not an empty-state card (§5 "Empty").
  if (!loaded || refunds.length === 0) return null;

  return (
    <Card>
      <h2 className={styles.sectionTitle}>{t('bookingCancel.refunds.title')}</h2>
      <ul className={styles.historyList}>
        {refunds.map((refund) => (
          <li key={refund.id} className={styles.historyRow}>
            <span>
              {formatMoney(refund.totalAmountMinorUnits, refund.totalCurrencyCode, locale)}
              {' · '}
              <Badge>{REFUND_STATUS_LABELS[refund.status] ? t(REFUND_STATUS_LABELS[refund.status]!) : refund.status}</Badge>
            </span>
            <span className={styles.historyActor}>
              {refund.lines.map((line) => line.reason).join('; ')}
              {refund.completedAt ? ` · ${formatInstant(refund.completedAt, scheduledTimezone, locale)}` : ''}
            </span>
          </li>
        ))}
      </ul>

      {refunds.some((refund) => refund.status === 'requested' || refund.status === 'processing') && (
        <p className={styles.hint}>{t('bookingCancel.refunds.processing')}</p>
      )}
      {refunds.some((refund) => refund.status === 'failed') && (
        <p className={styles.hint} role="alert">
          {t('bookingCancel.refunds.failed')}
        </p>
      )}
    </Card>
  );
}

/** Customer-facing copy. "Refund in progress" is deliberately not "Refunded". */
const REFUND_STATUS_LABELS: Record<string, MessageKey> = {
  requested: 'bookingCancel.refunds.status.requested',
  processing: 'bookingCancel.refunds.status.processing',
  completed: 'bookingCancel.refunds.status.completed',
  failed: 'bookingCancel.refunds.status.failed',
};

/** Spec 042 X-11: the shared formatter, in the reader's locale and the booking's own time zone. */
function formatInstant(iso: string, timeZone: string, locale: string): string {
  try {
    return formatDateTime(iso, locale, { dateStyle: 'medium', timeStyle: 'short', timeZone });
  } catch {
    return iso;
  }
}
