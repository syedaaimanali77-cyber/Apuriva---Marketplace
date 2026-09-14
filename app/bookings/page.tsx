'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Badge, Button, Card, EmptyState, ErrorState, PriceDisplay, Skeleton } from '@/components';
import type { BookingListFilter, BookingSummaryDto } from '@/lib/types/bookings';
import { apiFetch, BOOKING_STATUS_LABELS, formatScheduled } from './booking-client';
import styles from './bookings.module.css';

type PageStatus = 'loading' | 'error' | 'ready';

/** §3's documented filters, in the order the tab strip shows them. */
const FILTERS: { value: BookingListFilter; label: string }[] = [
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'disputed', label: 'Disputed' },
];

/**
 * Spec 020 §5, `/bookings` — the customer's booking list, replacing the spec 014 placeholder.
 *
 * Per CLAUDE.md's branding rule this page carries no logo or brand header of its own: the nav shell
 * already provides the single intentional placement.
 */
export default function BookingsPage() {
  const [status, setStatus] = useState<PageStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<BookingListFilter>('upcoming');
  const [bookings, setBookings] = useState<BookingSummaryDto[]>([]);

  const load = useCallback(async (next: BookingListFilter) => {
    setStatus('loading');
    setError(null);
    const result = await apiFetch<BookingSummaryDto[]>(`/api/v1/bookings?filter=${next}`);
    if (!result.ok) {
      setError(result.error?.message ?? 'We could not load your bookings.');
      setStatus('error');
      return;
    }
    setBookings(result.data ?? []);
    setStatus('ready');
  }, []);

  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <h1 className={styles.title}>Bookings</h1>
        <p className={styles.subtitle}>Your confirmed services, and the ones already done.</p>
      </header>

      <div className={styles.filters} role="tablist" aria-label="Filter bookings">
        {FILTERS.map((entry) => (
          <Button
            key={entry.value}
            role="tab"
            aria-selected={filter === entry.value}
            variant={filter === entry.value ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setFilter(entry.value)}
          >
            {entry.label}
          </Button>
        ))}
      </div>

      {status === 'loading' && (
        <div aria-busy="true" aria-label="Loading bookings">
          <Skeleton lines={3} />
        </div>
      )}

      {status === 'error' && (
        <ErrorState title="We could not load your bookings" description={error ?? undefined} onRetry={() => void load(filter)} />
      )}

      {status === 'ready' && bookings.length === 0 && (
        <EmptyState
          title="No bookings here yet"
          description="When you accept an offer, the booking will appear here."
          action={<Link href="/search">Browse services</Link>}
        />
      )}

      {status === 'ready' && bookings.length > 0 && (
        <ul className={styles.list}>
          {bookings.map((booking) => (
            <li key={booking.id}>
              <Link href={`/bookings/${booking.id}`} className={styles.rowLink}>
                <Card>
                  <div className={styles.rowBody}>
                    <h2 className={styles.rowTitle}>{booking.serviceName}</h2>
                    {/* Text, never colour alone — §5 accessibility. */}
                    <Badge>{BOOKING_STATUS_LABELS[booking.status]}</Badge>
                  </div>
                  <p className={styles.rowMeta}>{formatScheduled(booking.scheduledAt, booking.scheduledTimezone)}</p>
                  {booking.counterpartyName && <p className={styles.rowMeta}>{booking.counterpartyName}</p>}
                  {/* The agreed price is exact — it was copied verbatim from the accepted offer. */}
                  <PriceDisplay
                    priceDisplay={{
                      type: 'exact',
                      amountMinorUnits: booking.priceAmountMinorUnits,
                      currencyCode: booking.currencyCode,
                    }}
                  />
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
