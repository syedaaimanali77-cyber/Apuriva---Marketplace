'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Badge, Button, Card, EmptyState, ErrorState, PriceDisplay, Skeleton } from '@/components';
import { useLocale } from '@/app/_components/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/dictionaries/en';
import type { BookingListFilter, BookingSummaryDto } from '@/lib/types/bookings';
import { apiFetch, BOOKING_STATUS_KEYS, formatScheduled } from './booking-client';
import styles from './bookings.module.css';

type PageStatus = 'loading' | 'error' | 'ready';

/** §3's documented filters, in the order the tab strip shows them. */
const FILTERS: { value: BookingListFilter; label: MessageKey }[] = [
  { value: 'upcoming', label: 'bookings.list.filters.upcoming' },
  { value: 'active', label: 'bookings.list.filters.active' },
  { value: 'completed', label: 'bookings.list.filters.completed' },
  { value: 'cancelled', label: 'bookings.list.filters.cancelled' },
  { value: 'disputed', label: 'bookings.list.filters.disputed' },
];

/**
 * Spec 020 §5, `/bookings` — the customer's booking list, replacing the spec 014 placeholder.
 *
 * Per CLAUDE.md's branding rule this page carries no logo or brand header of its own: the nav shell
 * already provides the single intentional placement.
 */
export default function BookingsPage() {
  const { locale, t, errorText } = useLocale();
  const [status, setStatus] = useState<PageStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<BookingListFilter>('upcoming');
  const [bookings, setBookings] = useState<BookingSummaryDto[]>([]);

  const load = useCallback(async (next: BookingListFilter) => {
    setStatus('loading');
    setError(null);
    const result = await apiFetch<BookingSummaryDto[]>(`/api/v1/bookings?filter=${next}`);
    if (!result.ok) {
      setError(errorText(result.error?.code, result.error?.message, t('bookings.list.loadFailed')));
      setStatus('error');
      return;
    }
    setBookings(result.data ?? []);
    setStatus('ready');
  }, [errorText, t]);

  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <h1 className={styles.title}>{t('bookings.list.title')}</h1>
        <p className={styles.subtitle}>{t('bookings.list.subtitle')}</p>
      </header>

      <div className={styles.filters} role="tablist" aria-label={t('bookings.list.filterLabel')}>
        {FILTERS.map((entry) => (
          <Button
            key={entry.value}
            role="tab"
            aria-selected={filter === entry.value}
            variant={filter === entry.value ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setFilter(entry.value)}
          >
            {t(entry.label)}
          </Button>
        ))}
      </div>

      {status === 'loading' && (
        <div aria-busy="true" aria-label={t('bookings.list.loading')}>
          <Skeleton lines={3} />
        </div>
      )}

      {status === 'error' && (
        <ErrorState title={t('bookings.list.errorTitle')} description={error ?? undefined} onRetry={() => void load(filter)} />
      )}

      {status === 'ready' && bookings.length === 0 && (
        <EmptyState
          title={t('bookings.list.emptyTitle')}
          description={t('bookings.list.emptyDescription')}
          action={<Link href="/search">{t('bookings.list.browse')}</Link>}
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
                    <Badge>{t(BOOKING_STATUS_KEYS[booking.status])}</Badge>
                  </div>
                  <p className={styles.rowMeta}>{formatScheduled(booking.scheduledAt, booking.scheduledTimezone, locale)}</p>
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
