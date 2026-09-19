'use client';

/**
 * Spec 029 §5 — the provider's view of a review, and their one reply (AC-3).
 *
 * The reply form disappears once a response exists, because a response is IMMUTABLE: there is no
 * edit route and no delete route, the same stance spec 025 takes for messages and spec 028 for
 * milestones. Showing an edit affordance the server would refuse would be worse than showing none.
 *
 * NOTHING HERE TELLS THE PROVIDER A REVIEW WAS FLAGGED OR REPORTED. That is moderation data
 * (§4 "Retention and privacy"), restricted to the admin surface: a provider who could see it would
 * learn that someone reported a review about them, which is exactly how a reporter's identity gets
 * inferred. `ReviewCard` cannot render it either — the public DTO carries no such field.
 *
 * Adds no page and no `ui/` primitive; uses the booking screens' existing module CSS.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, ReviewCard, Textarea } from '@/components';
import { ReportReviewDialog } from '@/app/_components/ReportReviewDialog';
import type { BookingReviewStateDto, ReviewResponseDto } from '@/lib/types/reviews';
import { MAX_TEXT_LENGTH, MIN_TEXT_LENGTH } from '@/lib/reviews/limits';
import { apiFetch, mutateHeaders } from '@/app/bookings/booking-client';
import styles from '@/app/bookings/bookings.module.css';

export interface ReviewResponseSectionProps {
  bookingId: string;
}

function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `response-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function ReviewResponseSection({ bookingId }: ReviewResponseSectionProps) {
  const [state, setState] = useState<BookingReviewStateDto | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const [reported, setReported] = useState(false);

  const idempotencyKey = useMemo(newIdempotencyKey, []);

  const load = useCallback(async () => {
    const response = await apiFetch<BookingReviewStateDto>(`/api/v1/bookings/${bookingId}/reviews`);
    if (response.ok) setState(response.data!);
  }, [bookingId]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = useCallback(async () => {
    const review = state?.review;
    if (!review) return;

    const trimmed = text.trim();
    if (trimmed.length < MIN_TEXT_LENGTH) {
      setError(`Please write at least ${MIN_TEXT_LENGTH} characters.`);
      return;
    }

    setBusy(true);
    setError(null);
    const response = await apiFetch<ReviewResponseDto>(`/api/v1/reviews/${review.id}/response`, {
      method: 'POST',
      headers: mutateHeaders({ 'Idempotency-Key': idempotencyKey }),
      body: JSON.stringify({ text: trimmed }),
    });
    setBusy(false);

    if (!response.ok) {
      setError(response.error?.message ?? "Something went wrong. Please try again.");
      return;
    }
    setText('');
    await load();
  }, [idempotencyKey, load, state, text]);

  const review = state?.review;
  // No review yet, or one a human removed: nothing to show and nothing to reply to.
  if (!review || review.status === 'removed') return null;

  return (
    <section className={styles.section} aria-labelledby="provider-review-heading">
      <h2 className={styles.sectionTitle} id="provider-review-heading">
        Customer review
      </h2>

      {/* A provider is not the review's author, so they may report one they believe is false or
          abusive. Reporting changes nothing a customer can see: it asks Trust & Safety to look. */}
      <ReviewCard review={review} onReport={reported ? undefined : () => setReporting(true)} />

      {reported ? (
        <p className={styles.hint}>
          Thanks — Trust &amp; Safety will look at this review. It stays visible while they do.
        </p>
      ) : null}

      <ReportReviewDialog
        reviewId={review.id}
        open={reporting}
        onClose={() => setReporting(false)}
        onReported={() => setReported(true)}
      />

      {review.response ? (
        <p className={styles.hint}>You have replied to this review. A reply can be posted once and is not editable.</p>
      ) : (
        <Card>
          <label className={styles.detailLabel} htmlFor="review-response-text">
            Reply publicly (once)
          </label>
          <Textarea
            id="review-response-text"
            value={text}
            maxLength={MAX_TEXT_LENGTH}
            onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setText(event.target.value)}
            disabled={busy}
          />
          <p className={styles.hint}>
            Your reply is public and cannot be edited afterwards. Keep it factual — contact details are not allowed.
          </p>
          {error ? <p className={styles.hint}>{error}</p> : null}
          <div className={styles.actions}>
            <Button onClick={submit} disabled={busy || text.trim().length === 0}>
              {busy ? 'Posting…' : 'Post reply'}
            </Button>
          </div>
        </Card>
      )}
    </section>
  );
}
