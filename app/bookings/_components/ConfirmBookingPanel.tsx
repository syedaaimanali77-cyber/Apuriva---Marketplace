'use client';

import { useCallback, useId, useState } from 'react';
import { Button, Card } from '@/components';
import type { BookingDto, SlotAlternativeDto } from '@/lib/types/bookings';
import { apiFetch, formatAlternative, mutateHeaders, slotConflictDetails } from '../booking-client';
import { useLocale } from '@/app/_components/LocaleProvider';
import { OfflineWriteNotice } from '@/app/_components/OfflineWriteNotice';
import { useNetworkStatus } from '@/app/_components/useNetworkStatus';
import styles from '../bookings.module.css';

export interface ConfirmBookingPanelProps {
  /** The accepted offer this booking is created from. */
  offerId: string;
}

/**
 * Spec 020 §5 — the booking-confirmation step, mounted where spec 018's offers panel hands off
 * ("After an accept this panel creates no booking — booking is spec 020's next step").
 *
 * Two §5 rules drive this component:
 *
 *  1. **No optimistic confirmation** (master spec §103, §132.7). While the server revalidates, the
 *     button shows a pending state; nothing here ever says "booked" before the `201` arrives, and a
 *     failure leaves the customer exactly where they were.
 *  2. **AC-2's alternatives, in place.** `422 SLOT_NO_LONGER_AVAILABLE` renders the conflict plus up
 *     to three selectable times, each of which is re-submitted as `scheduledAt` with a FRESH
 *     `Idempotency-Key` — a new attempt, never a replay of the failed one. With no alternatives it
 *     shows the coarse next-available date as plain text and offers no misleading retry.
 */
export function ConfirmBookingPanel({ offerId }: ConfirmBookingPanelProps) {
  const { locale, t, errorText } = useLocale();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alternatives, setAlternatives] = useState<SlotAlternativeDto[]>([]);
  const [nextAvailableDate, setNextAvailableDate] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  // Spec 044 §3.5 (X-5): booking confirmation is disabled while offline, with the offline notice.
  const { online } = useNetworkStatus();
  const offlineNoticeId = useId();
  const offlineDescription = online ? undefined : offlineNoticeId;

  const confirm = useCallback(
    async (scheduledAt?: string) => {
      setPending(true);
      setError(null);

      const result = await apiFetch<BookingDto>('/api/v1/bookings', {
        method: 'POST',
        // A fresh key per ATTEMPT: retrying a conflicted booking at a different time is a new
        // request, not a replay, so reusing the key would be `409 IDEMPOTENCY_KEY_CONFLICT`.
        headers: mutateHeaders({ 'Idempotency-Key': crypto.randomUUID() }),
        body: JSON.stringify(scheduledAt ? { offerId, scheduledAt } : { offerId }),
      });
      setPending(false);

      if (result.ok && result.data) {
        setConflict(false);
        // Only now, with the server's confirmed booking in hand, do we move the customer on. A plain
        // navigation, not the Next.js hook: this panel is mounted inside spec 018's offers panel,
        // which is rendered (and tested) without an app-router context and must not need one.
        window.location.assign(`/bookings/${result.data.id}`);
        return;
      }

      const details = slotConflictDetails(result.error);
      if (details) {
        setConflict(true);
        setAlternatives(details.alternatives);
        setNextAvailableDate(details.nextAvailableDate);
        setError(t('bookingParts.confirm.slotGone'));
        return;
      }

      setConflict(false);
      setAlternatives([]);
      setError(errorText(result.error?.code, result.error?.message, t('bookingParts.confirm.failed')));
    },
    [errorText, offerId, t],
  );

  return (
    <Card>
      <h3 className={styles.sectionTitle}>{t('bookingParts.confirm.title')}</h3>
      <p className={styles.hint}>{t('bookingParts.confirm.hint')}</p>

      <div className={styles.actions}>
        <Button variant="primary" loading={pending} disabled={!online} aria-describedby={offlineDescription} onClick={() => void confirm()}>
          {t('bookingParts.confirm.button')}
        </Button>
      </div>
      <OfflineWriteNotice id={offlineNoticeId} />

      {error && (
        <p className={styles.hint} role="alert">
          {error}
        </p>
      )}

      {conflict && alternatives.length > 0 && (
        <>
          <p className={styles.hint}>{t('bookingParts.confirm.pickAnother')}</p>
          <ul className={styles.alternatives} aria-label={t('bookingParts.confirm.alternatives')}>
            {alternatives.map((alternative) => (
              <li key={alternative.startAt}>
                <Button
                  variant="secondary"
                  disabled={pending || !online}
                  aria-describedby={offlineDescription}
                  onClick={() => void confirm(alternative.startAt)}
                >
                  {formatAlternative(alternative, locale)}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}

      {conflict && alternatives.length === 0 && (
        // No alternatives: plain text and NO retry affordance, so the customer is not invited to
        // repeat an attempt that cannot succeed (§5).
        <p className={styles.hint}>
          {nextAvailableDate
            ? t('bookingParts.confirm.nextDay', { date: nextAvailableDate })
            : t('bookingParts.confirm.noAvailability')}
        </p>
      )}
    </Card>
  );
}
