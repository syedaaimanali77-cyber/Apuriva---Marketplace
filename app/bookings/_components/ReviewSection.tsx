'use client';

/**
 * Spec 029 §5 — the review section on the existing customer booking page.
 *
 * Two states and nothing else: an invitation with the real deadline while the booking is
 * reviewable, and the published review afterwards. Both come from one server call
 * (`GET /bookings/{id}/reviews`), so this component decides nothing — a client that computed
 * "reviewable" itself would be wrong the moment the window closed (architecture §5.4).
 *
 * WHAT IS NEVER SHOWN HERE. A review's `flagged` status is not surfaced as a badge, a warning or a
 * tone: to its author, a flagged review reads exactly as a published one, because that is what it
 * is (AC-4). Only a `removed` review says anything, and then it says what a human decided and why.
 *
 * Adds no page and no `ui/` primitive; uses the booking screens' existing module CSS.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, ReviewCard } from '@/components';
import type { BookingReviewStateDto } from '@/lib/types/reviews';
import { apiFetch } from '@/app/bookings/booking-client';
import { useLocale } from '@/app/_components/LocaleProvider';
import { formatDate as formatLocaleDate } from '@/lib/i18n/format';
import styles from '@/app/bookings/bookings.module.css';

export interface ReviewSectionProps {
  bookingId: string;
}

export function ReviewSection({ bookingId }: ReviewSectionProps) {
  const { locale, t } = useLocale();
  const [state, setState] = useState<BookingReviewStateDto | null>(null);

  const load = useCallback(async () => {
    const response = await apiFetch<BookingReviewStateDto>(`/api/v1/bookings/${bookingId}/reviews`);
    if (response.ok) setState(response.data!);
  }, [bookingId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!state) return null;

  // Nothing written yet and nothing writable: say nothing rather than nag about a job still running.
  if (!state.review && !state.eligible) return null;

  return (
    <section className={styles.section} aria-labelledby="review-section-heading">
      <h2 className={styles.sectionTitle} id="review-section-heading">
        {t('review.section.title')}
      </h2>

      {state.review ? (
        state.review.status === 'removed' ? (
          <Card>
            <p className={styles.hint}>{t('review.section.removed')}</p>
          </Card>
        ) : (
          <ReviewCard review={state.review} />
        )
      ) : (
        <Card>
          <p className={styles.hint}>
            {t('review.section.invite')}
            {state.windowClosesAt
              ? t('review.section.until', { date: formatLocaleDate(state.windowClosesAt, locale, { dateStyle: 'long' }) })
              : ''}
          </p>
          <div className={styles.actions}>
            {/* A real navigation link, not a Button with an onClick: the DS `Button` renders a
                `<button>` and has no polymorphic `as`, and this genuinely navigates. */}
            <Link className={styles.eyebrowLink} href={`/bookings/${bookingId}/review`}>
              {t('review.section.leave')}
            </Link>
          </div>
        </Card>
      )}
    </section>
  );
}
