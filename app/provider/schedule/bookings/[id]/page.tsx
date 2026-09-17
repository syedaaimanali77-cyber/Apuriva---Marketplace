'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Badge, Button, Card, ErrorState, PriceDisplay, RequestStatusTimeline, Skeleton } from '@/components';
import type { BookingDto, BookingStatusHistoryDto } from '@/lib/types/bookings';
import {
  apiFetch,
  BOOKING_POLL_MS,
  BOOKING_PROGRESSION,
  BOOKING_STATUS_LABELS,
  formatScheduled,
  isLiveBookingStatus,
  mutateHeaders,
  progressionIndex,
} from '@/app/bookings/booking-client';
import { BookingConversation } from '@/app/bookings/_components/BookingConversation';
import { BookingEvidence } from '@/app/bookings/_components/BookingEvidence';
import { BookingMilestones } from '@/app/bookings/_components/BookingMilestones';
import type { ServiceDto } from '@/lib/types/catalog';
import type { FileAssetDto } from '@/lib/types/files';
import styles from '@/app/bookings/bookings.module.css';

type PageStatus = 'loading' | 'error' | 'ready';

/** The provider's three lifecycle actions, and the status each reaches (§3). */
const ACTIONS: { path: string; label: string; from: BookingDto['status'][] }[] = [
  { path: 'provider-en-route', label: "I'm on my way", from: ['confirmed'] },
  // AC-4: the en-route step is OPTIONAL, so "I've Arrived" is offered from either status.
  { path: 'arrived', label: "I've arrived", from: ['confirmed', 'provider_en_route'] },
  { path: 'start-service', label: 'Start service', from: ['arrived'] },
];

/**
 * Spec 020 §5, `/provider/schedule/bookings/{id}` — the provider's active-job view.
 *
 * Every transition here is an explicit tap (AC-7): nothing on this screen reads location, starts a
 * timer that advances state, or transitions the booking on its own. Polling, not WebSocket — no
 * WebSocket layer exists in this repository. Per CLAUDE.md's branding rule, no logo of its own.
 */
export default function ProviderBookingPage() {
  const params = useParams<{ id: string }>();
  const bookingId = params.id;

  const [status, setStatus] = useState<PageStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [booking, setBooking] = useState<BookingDto | null>(null);
  const [history, setHistory] = useState<BookingStatusHistoryDto[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retryAfter, setRetryAfter] = useState<number | null>(null);
  // Spec 028 — copy only. The requirement and whether it is met are resolved server-side from the
  // catalog inside the completion transaction; this just lets the screen say so before the tap.
  const [evidenceRequired, setEvidenceRequired] = useState(false);
  const [evidenceAssets, setEvidenceAssets] = useState<FileAssetDto[]>([]);

  const liveRef = useRef(true);

  const load = useCallback(
    async (showSpinner: boolean) => {
      if (showSpinner) setStatus('loading');
      const [bookingResult, historyResult] = await Promise.all([
        apiFetch<BookingDto>(`/api/v1/bookings/${bookingId}`),
        apiFetch<BookingStatusHistoryDto[]>(`/api/v1/bookings/${bookingId}/status-history`),
      ]);

      if (!bookingResult.ok || !bookingResult.data) {
        setError(bookingResult.error?.message ?? 'We could not load this booking.');
        setStatus('error');
        liveRef.current = false;
        return;
      }

      setBooking(bookingResult.data);
      setHistory(historyResult.data ?? []);
      liveRef.current = isLiveBookingStatus(bookingResult.data.status);
      setStatus('ready');
    },
    [bookingId],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  // Spec 028 §5 — read the service's `completionEvidenceRequired` so the completion control can
  // state the requirement BEFORE it is pressed. A service this caller cannot read simply leaves the
  // copy at "optional"; the server still refuses a completion that lacks required evidence.
  useEffect(() => {
    if (!booking) return;
    let cancelled = false;
    void apiFetch<ServiceDto>(`/api/v1/services/${booking.serviceId}`)
      .then((result) => {
        if (!cancelled && result.ok) setEvidenceRequired(Boolean(result.data?.completionEvidenceRequired));
      })
      // Copy only: if the service cannot be read, the screen stays on "optional" wording and the
      // SERVER still refuses a completion that lacks required evidence. Never an unhandled rejection.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [booking]);

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

  useEffect(() => {
    if (retryAfter === null || retryAfter <= 0) return;
    const timer = setInterval(() => setRetryAfter((current) => (current === null ? null : Math.max(0, current - 1))), 1000);
    return () => clearInterval(timer);
  }, [retryAfter]);

  const act = useCallback(
    async (path: string, withIdempotencyKey: boolean) => {
      setPending(path);
      setActionError(null);
      // Spec 028 AC-6 — on `complete`, declare the evidence this screen actually holds. It is not
      // what satisfies the requirement (the server counts that itself); sending an id that is not
      // this booking's own evidence fails the request rather than passing it.
      const body =
        path === 'complete' && evidenceAssets.length > 0
          ? JSON.stringify({ evidenceFileAssetIds: evidenceAssets.filter((a) => a.status === 'ready').map((a) => a.id) })
          : undefined;
      const result = await apiFetch<BookingDto>(`/api/v1/bookings/${bookingId}/${path}`, {
        method: 'POST',
        headers: mutateHeaders(withIdempotencyKey ? { 'Idempotency-Key': crypto.randomUUID() } : undefined),
        body,
      });
      setPending(null);

      if (!result.ok) {
        if (result.error?.code === 'COMPLETION_TOO_EARLY') {
          const details = (result.error as { details?: { retryAfterSeconds?: number } }).details;
          if (details?.retryAfterSeconds) setRetryAfter(details.retryAfterSeconds);
        }
        setActionError(result.error?.message ?? 'That action did not go through.');
        return;
      }
      await load(false);
    },
    [bookingId, load, evidenceAssets],
  );

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
        <ErrorState title="We could not load this booking" description={error ?? undefined} onRetry={() => void load(true)} />
      </main>
    );
  }

  const available = ACTIONS.filter((action) => action.from.includes(booking.status));
  const canComplete = booking.status === 'in_progress';
  const dwellBlocked = retryAfter !== null && retryAfter > 0;
  const completion = history.find((row) => row.toStatus === 'completed');

  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <p className={styles.eyebrow}>
          <Link href="/provider/schedule" className={styles.eyebrowLink}>
            Schedule
          </Link>
        </p>
        <h1 className={styles.title}>Active job</h1>
        <p className={styles.subtitle} role="status" aria-live="polite">
          {BOOKING_STATUS_LABELS[booking.status]}
        </p>
      </header>

      <Card>
        <RequestStatusTimeline
          steps={BOOKING_PROGRESSION.map((step) => ({ label: step.label }))}
          currentIndex={progressionIndex(booking.status)}
        />
      </Card>

      <Card>
        <div className={styles.detailGrid}>
          <div>
            <p className={styles.detailLabel}>Scheduled</p>
            <p className={styles.detailValue}>{formatScheduled(booking.scheduledAt, booking.scheduledTimezone)}</p>
          </div>
          <div>
            <p className={styles.detailLabel}>Duration</p>
            <p className={styles.detailValue}>{booking.durationMinutes} minutes</p>
          </div>
          <div>
            <p className={styles.detailLabel}>Agreed price</p>
            <PriceDisplay
              priceDisplay={{ type: 'exact', amountMinorUnits: booking.priceAmountMinorUnits, currencyCode: booking.currencyCode }}
            />
          </div>
          <div>
            <p className={styles.detailLabel}>Status</p>
            <Badge>{BOOKING_STATUS_LABELS[booking.status]}</Badge>
          </div>
        </div>
      </Card>

      {/* Spec 028 §5 — optional progress updates, and evidence capture while the job is running. */}
      <BookingMilestones
        bookingId={booking.id}
        status={booking.status}
        scheduledTimezone={booking.scheduledTimezone}
        viewerRole="provider"
      />

      <BookingEvidence
        bookingId={booking.id}
        status={booking.status}
        viewerRole="provider"
        evidenceRequired={evidenceRequired}
        onAssetsChange={setEvidenceAssets}
      />

      {(available.length > 0 || canComplete) && (
        <Card>
          <h2 className={styles.sectionTitle}>Update this job</h2>
          <div className={styles.actions}>
            {available.map((action) => (
              <Button
                key={action.path}
                variant={action.path === 'start-service' ? 'primary' : 'secondary'}
                loading={pending === action.path}
                onClick={() => void act(action.path, false)}
              >
                {action.label}
              </Button>
            ))}
            {canComplete && (
              <Button loading={pending === 'complete'} disabled={dwellBlocked} onClick={() => void act('complete', true)}>
                Mark complete
              </Button>
            )}
          </div>

          {canComplete && (
            // AC-8: equal authority — the provider needs no confirmation from the customer.
            <p className={styles.hint}>You can mark this complete yourself; the customer does not need to confirm it.</p>
          )}
          {canComplete && evidenceRequired && (
            // Spec 028 §5 "Evidence required" — stated before the tap, not only after a 422.
            <p className={styles.hint} role="status" aria-live="polite">
              This service needs completion evidence.{' '}
              {evidenceAssets.some((asset) => asset.status === 'ready')
                ? 'Attached above.'
                : 'Attach a file above before marking it complete.'}
            </p>
          )}
          {dwellBlocked && (
            <p className={styles.hint} role="status" aria-live="polite">
              This job has only just started. You can mark it complete in {retryAfter} second{retryAfter === 1 ? '' : 's'}.
            </p>
          )}
          {actionError && !dwellBlocked && (
            <p className={styles.hint} role="alert">
              {actionError}
            </p>
          )}
        </Card>
      )}

      {completion && (
        <Card>
          <h2 className={styles.sectionTitle}>Completed</h2>
          <p className={styles.hint}>
            Marked complete by the {completion.actorRole === 'provider' ? 'provider' : 'customer'} on{' '}
            {formatScheduled(completion.occurredAt, booking.scheduledTimezone)}.
          </p>
        </Card>
      )}

      {/* Spec 025 §5 — the booking conversation, read-only once the booking is archived. */}
      <BookingConversation bookingId={booking.id} viewerRole="provider" />

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Activity</h2>
        <ul className={styles.historyList}>
          {history.map((row) => (
            <li key={`${row.toStatus}-${row.occurredAt}`} className={styles.historyRow}>
              <span>{BOOKING_STATUS_LABELS[row.toStatus]}</span>
              <span className={styles.historyActor}>
                {row.actorRole === 'system' ? 'System' : row.actorRole === 'provider' ? 'You' : 'Customer'} ·{' '}
                {formatScheduled(row.occurredAt, booking.scheduledTimezone)}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
