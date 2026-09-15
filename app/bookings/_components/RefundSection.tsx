'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Card } from '@/components';
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
      <h2 className={styles.sectionTitle}>Refunds</h2>
      <ul className={styles.historyList}>
        {refunds.map((refund) => (
          <li key={refund.id} className={styles.historyRow}>
            <span>
              {formatMoney(refund.totalAmountMinorUnits, refund.totalCurrencyCode)}
              {' · '}
              <Badge>{REFUND_STATUS_LABELS[refund.status] ?? refund.status}</Badge>
            </span>
            <span className={styles.historyActor}>
              {refund.lines.map((line) => line.reason).join('; ')}
              {refund.completedAt ? ` · ${formatInstant(refund.completedAt, scheduledTimezone)}` : ''}
            </span>
          </li>
        ))}
      </ul>

      {refunds.some((refund) => refund.status === 'requested' || refund.status === 'processing') && (
        <p className={styles.hint}>
          A refund is being processed by the payment provider. It will appear here as soon as the provider confirms it.
        </p>
      )}
      {refunds.some((refund) => refund.status === 'failed') && (
        <p className={styles.hint} role="alert">
          A refund attempt did not complete and no money was returned by that attempt. Nothing was taken from you.
          Contact support and we will look into it.
        </p>
      )}
    </Card>
  );
}

/** Customer-facing copy. "Refund in progress" is deliberately not "Refunded". */
const REFUND_STATUS_LABELS: Record<string, string> = {
  requested: 'Refund in progress',
  processing: 'Refund in progress',
  completed: 'Refunded',
  failed: 'Refund not completed',
};

function formatMoney(amountMinorUnits: number, currencyCode: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currencyCode }).format(amountMinorUnits / 100);
  } catch {
    return `${currencyCode} ${(amountMinorUnits / 100).toFixed(2)}`;
  }
}

function formatInstant(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(iso));
  } catch {
    return iso;
  }
}
