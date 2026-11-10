'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Badge, Button, Card, ErrorState, PriceDisplay, RequestStatusTimeline, Skeleton } from '@/components';
import type { BookingDto, BookingStatus, BookingStatusHistoryDto } from '@/lib/types/bookings';
import {
  apiFetch,
  BOOKING_POLL_MS,
  BOOKING_PROGRESSION,
  BOOKING_STATUS_KEYS,
  formatScheduled,
  isLiveBookingStatus,
  mutateHeaders,
  progressionIndex,
} from '../booking-client';
import { useLocale } from '@/app/_components/LocaleProvider';
import { RefundSection } from '../_components/RefundSection';
import { CancellationPolicySection } from '../_components/CancellationPolicySection';
import { BookingConversation } from '../_components/BookingConversation';
import { BookingEvidence } from '../_components/BookingEvidence';
import { BookingMilestones } from '../_components/BookingMilestones';
import { ReviewSection } from '../_components/ReviewSection';
import styles from '../bookings.module.css';

type PageStatus = 'loading' | 'error' | 'ready';

/** Mirrors AC-11's `MIN_IN_PROGRESS_SECONDS`; the server is authoritative, this only labels the wait. */
const DWELL_HINT_SECONDS = 60;

/** Spec 023 §3 "Cancellation eligibility by booking state" — mirrored for display only. */
const CANCELLABLE_STATUSES: readonly BookingStatus[] = ['confirmed', 'provider_en_route', 'arrived'];

/** Spec 023 §3 "No-show workflow" — the statuses in which a no-show is a coherent claim. */
const NO_SHOW_REPORTABLE_STATUSES: readonly BookingStatus[] = [
  'confirmed',
  'provider_en_route',
  'arrived',
  'in_progress',
];

/**
 * Spec 020 §5, `/bookings/{id}` — the customer's booking view.
 *
 * Live updates are POLLING, not WebSocket: no WebSocket layer exists in this repository (specs 018
 * and 019 both say so), so this refetches on spec 018's cadence and on window focus, and stops once
 * the booking reaches a status spec 020 cannot leave.
 *
 * "Mark Complete" is offered here identically to the provider's view (AC-8): either party may
 * complete an in-progress booking, and this screen never asks for, waits on, or implies the other
 * party's confirmation. Per CLAUDE.md's branding rule the page carries no logo of its own.
 */
export default function BookingDetailPage() {
  const { locale, t, errorText } = useLocale();
  const params = useParams<{ id: string }>();
  const bookingId = params.id;

  const [status, setStatus] = useState<PageStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [booking, setBooking] = useState<BookingDto | null>(null);
  const [history, setHistory] = useState<BookingStatusHistoryDto[]>([]);

  const [completing, setCompleting] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [retryAfter, setRetryAfter] = useState<number | null>(null);

  const liveRef = useRef(true);

  const load = useCallback(
    async (showSpinner: boolean) => {
      if (showSpinner) setStatus('loading');
      const [bookingResult, historyResult] = await Promise.all([
        apiFetch<BookingDto>(`/api/v1/bookings/${bookingId}`),
        apiFetch<BookingStatusHistoryDto[]>(`/api/v1/bookings/${bookingId}/status-history`),
      ]);

      if (!bookingResult.ok || !bookingResult.data) {
        setError(errorText(bookingResult.error?.code, bookingResult.error?.message, t('bookings.detail.loadFailed')));
        setStatus('error');
        liveRef.current = false;
        return;
      }

      setBooking(bookingResult.data);
      setHistory(historyResult.data ?? []);
      liveRef.current = isLiveBookingStatus(bookingResult.data.status);
      setStatus('ready');
    },
    [bookingId, errorText, t],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  // §5 polling: only while the booking can still change, and also on focus.
  useEffect(() => {
    const tick = () => {
      if (liveRef.current) void load(false);
    };
    const timer = setInterval(tick, BOOKING_POLL_MS);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', tick);
    };
  }, [load]);

  // The dwell countdown on the disabled control — text, never a silent failure (§5).
  useEffect(() => {
    if (retryAfter === null || retryAfter <= 0) return;
    const timer = setInterval(() => setRetryAfter((current) => (current === null ? null : Math.max(0, current - 1))), 1000);
    return () => clearInterval(timer);
  }, [retryAfter]);

  const markComplete = useCallback(async () => {
    setCompleting(true);
    setCompleteError(null);
    const result = await apiFetch<BookingDto>(`/api/v1/bookings/${bookingId}/complete`, {
      method: 'POST',
      headers: mutateHeaders({ 'Idempotency-Key': crypto.randomUUID() }),
    });
    setCompleting(false);

    if (!result.ok) {
      const details = result.error?.code === 'COMPLETION_TOO_EARLY' ? (result.error as { details?: { retryAfterSeconds?: number } }).details : undefined;
      if (details?.retryAfterSeconds) setRetryAfter(details.retryAfterSeconds);
      setCompleteError(errorText(result.error?.code, result.error?.message, t('bookings.detail.completeFailed')));
      return;
    }
    await load(false);
  }, [bookingId, errorText, load, t]);

  if (status === 'loading') {
    return (
      <main className={styles.page} aria-busy="true">
        <Skeleton lines={4} />
      </main>
    );
  }

  if (status === 'error' || !booking) {
    return (
      <main className={styles.page}>
        <ErrorState title={t('bookings.detail.errorTitle')} description={error ?? undefined} onRetry={() => void load(true)} />
      </main>
    );
  }

  const completion = history.find((row) => row.toStatus === 'completed');
  const canComplete = booking.status === 'in_progress';
  const dwellBlocked = retryAfter !== null && retryAfter > 0;

  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <p className={styles.eyebrow}>
          <Link href="/bookings" className={styles.eyebrowLink}>
            {t('bookings.detail.bookings')}
          </Link>
        </p>
        <h1 className={styles.title}>{t('bookings.detail.title')}</h1>
        {/* Text plus badge — status is never conveyed by colour alone (§5 accessibility). */}
        <p className={styles.subtitle} role="status" aria-live="polite">
          {t(BOOKING_STATUS_KEYS[booking.status])}
        </p>
      </header>

      <Card>
        <RequestStatusTimeline
          steps={BOOKING_PROGRESSION.map((step) => ({ label: t(step.labelKey) }))}
          currentIndex={progressionIndex(booking.status)}
        />
      </Card>

      <Card>
        <div className={styles.detailGrid}>
          <div>
            <p className={styles.detailLabel}>{t('bookings.detail.scheduled')}</p>
            <p className={styles.detailValue}>{formatScheduled(booking.scheduledAt, booking.scheduledTimezone, locale)}</p>
          </div>
          <div>
            <p className={styles.detailLabel}>{t('bookings.detail.duration')}</p>
            <p className={styles.detailValue}>{t('bookings.detail.minutes', { count: booking.durationMinutes })}</p>
          </div>
          <div>
            <p className={styles.detailLabel}>{t('bookings.detail.agreedPrice')}</p>
            <PriceDisplay
              priceDisplay={{ type: 'exact', amountMinorUnits: booking.priceAmountMinorUnits, currencyCode: booking.currencyCode }}
            />
          </div>
          <div>
            <p className={styles.detailLabel}>{t('bookings.detail.status')}</p>
            <Badge>{t(BOOKING_STATUS_KEYS[booking.status])}</Badge>
          </div>
        </div>
      </Card>

      {canComplete && (
        <Card>
          <h2 className={styles.sectionTitle}>{t('bookings.detail.finishedTitle')}</h2>
          {/* AC-8: equal authority, and no confirmation from the provider is requested anywhere. */}
          <p className={styles.hint}>{t('bookings.detail.finishedHint')}</p>
          <div className={styles.actions}>
            <Button onClick={() => void markComplete()} loading={completing} disabled={dwellBlocked}>
              {t('bookings.detail.markComplete')}
            </Button>
          </div>
          {dwellBlocked && (
            <p className={styles.hint} role="status" aria-live="polite">
              {t(retryAfter === 1 ? 'bookings.detail.dwellOne' : 'bookings.detail.dwellMany', { count: retryAfter ?? 0 })}
            </p>
          )}
          {!dwellBlocked && completeError && (
            <p className={styles.hint} role="alert">
              {completeError}
            </p>
          )}
          {!dwellBlocked && !completeError && (
            <p className={styles.hint}>{t('bookings.detail.dwellHint', { seconds: DWELL_HINT_SECONDS })}</p>
          )}
        </Card>
      )}

      {completion && (
        <Card>
          <h2 className={styles.sectionTitle}>{t('bookings.detail.completed')}</h2>
          {/* AC-8: who completed it, read from the status history — never a separate field. */}
          <p className={styles.hint}>
            {t('bookings.detail.completedBy', {
              role: completion.actorRole === 'customer' ? t('bookings.detail.roleCustomer') : t('bookings.detail.roleProvider'),
              when: formatScheduled(completion.occurredAt, booking.scheduledTimezone, locale),
            })}
          </p>
          {/* AC-10: an explicit, user-initiated route only — completion never opens a dispute itself. */}
          <p className={styles.hint}>
            {t('bookings.detail.disagree')} <Link href="/account">{t('bookings.detail.contactSupport')}</Link>{' '}
            {t('bookings.detail.disagreeTail')}
          </p>
        </Card>
      )}

      {/* Spec 028 §5 — renders NOTHING when no milestone has been posted: a provider who posts
          none must not look like one who is failing to report. */}
      <BookingMilestones
        bookingId={booking.id}
        status={booking.status}
        scheduledTimezone={booking.scheduledTimezone}
        viewerRole="customer"
      />

      {/* Spec 028 §5/AC-8 — nothing before completion: the server returns an empty list until the
          booking has actually been marked complete, so there is nothing to render or hint at. */}
      <BookingEvidence bookingId={booking.id} status={booking.status} viewerRole="customer" />

      {/* Spec 029 §5 — renders nothing until the booking has actually been completed: the server's
          `GET /bookings/{id}/reviews` decides both whether a review is possible and until when. */}
      <ReviewSection bookingId={booking.id} />

      {/* Spec 025 §5 — the booking conversation, read-only once the booking is archived. */}
      <BookingConversation bookingId={booking.id} viewerRole="customer" />

      {/* Spec 022 §5 — renders nothing when the booking has no refunds. */}
      <RefundSection bookingId={booking.id} scheduledTimezone={booking.scheduledTimezone} />

      {/* Spec 023 §5 — AC-1: the policy SNAPSHOTTED for this booking, not current configuration. */}
      <CancellationPolicySection bookingId={booking.id} />

      {/* Spec 023 §5 — the two entry points, offered only while each is actually available, so the
          screen never invites an action the server would refuse. */}
      {CANCELLABLE_STATUSES.includes(booking.status) && (
        <Card>
          <h2 className={styles.sectionTitle}>{t('bookings.detail.cancelTitle')}</h2>
          <p className={styles.hint}>{t('bookings.detail.cancelHint')}</p>
          <div className={styles.actions}>
            <Link className={styles.eyebrowLink} href={`/bookings/${booking.id}/cancel`}>
              {t('bookings.detail.cancel')}
            </Link>
          </div>
        </Card>
      )}

      {NO_SHOW_REPORTABLE_STATUSES.includes(booking.status) && (
        <Card>
          <h2 className={styles.sectionTitle}>{t('bookings.detail.attendanceTitle')}</h2>
          {/* Neutral by design (master spec §51): reporting asks for a review, it accuses nobody. */}
          <p className={styles.hint}>{t('bookings.detail.attendanceHint')}</p>
          <div className={styles.actions}>
            <Link className={styles.eyebrowLink} href={`/bookings/${booking.id}/no-show`}>
              {t('bookings.detail.reportAttendance')}
            </Link>
          </div>
        </Card>
      )}

      {/*
        Spec 032 §5 — the support entry point. Carrying the booking as context is what makes AC-2's
        "not requiring the user to re-explain it" true in practice; the server re-authorizes the id
        it is given, so this link grants nothing by itself.
      */}
      <div className={styles.actions}>
        <Link className={styles.eyebrowLink} href={`/support/new?contextType=booking&contextId=${booking.id}`}>
          {t('bookings.detail.help')}
        </Link>
      </div>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>{t('bookings.detail.activity')}</h2>
        <ul className={styles.historyList}>
          {history.map((row) => (
            <li key={`${row.toStatus}-${row.occurredAt}`} className={styles.historyRow}>
              <span>{t(BOOKING_STATUS_KEYS[row.toStatus])}</span>
              <span className={styles.historyActor}>
                {row.actorRole === 'system'
                  ? t('bookings.detail.actorSystem')
                  : row.actorRole === 'customer'
                    ? t('bookings.detail.actorCustomer')
                    : t('bookings.detail.actorProvider')}{' '}
                ·{' '}
                {formatScheduled(row.occurredAt, booking.scheduledTimezone, locale)}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
