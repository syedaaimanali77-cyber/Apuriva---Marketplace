'use client';

/**
 * Spec 029 §5 — the customer's review screen (AC-2).
 *
 * THE DEADLINE IS NEVER COMPUTED HERE. The screen asks the server
 * (`GET /bookings/{id}/reviews`) whether this booking is reviewable and until when, and renders
 * exactly what it is told. Architecture §5.4 forbids a client deciding a deadline, and spec 018
 * established the same rule for offer expiry — so an ineligible booking shows the server's reason,
 * not a locally-derived guess.
 *
 * Media goes through spec 027's existing `FileUpload` with `contextType: 'review_media'` and the
 * BOOKING as its context id; no upload code is written here and no second storage path exists. The
 * server re-validates every id it is handed, so a client that lied about one is simply refused.
 *
 * Built from existing primitives (`Card`, `Button`, `Textarea`, `ErrorState`, `Skeleton`) plus this
 * spec's `RatingInput`, and the booking screens' existing module CSS. No redesign, no new token,
 * and no brand mark — the booking area's layout already carries one.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Button, Card, ErrorState, RatingInput, Skeleton, Textarea } from '@/components';
import { FileUpload } from '@/app/_components/FileUpload';
import type { FileAssetDto } from '@/lib/types/files';
import type { BookingReviewStateDto, ReviewDto } from '@/lib/types/reviews';
import { MAX_REVIEW_MEDIA, MAX_TEXT_LENGTH, MIN_TEXT_LENGTH } from '@/lib/reviews/limits';
import { apiFetch, mutateHeaders } from '../../booking-client';
import styles from '../../bookings.module.css';

type PageStatus = 'loading' | 'error' | 'ready' | 'submitted';

/** A stable key per mounted screen, so a double-submit is a replay rather than a second review. */
function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `review-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** The server's reason, rendered as something a customer can act on. */
const INELIGIBLE_COPY: Record<string, string> = {
  not_completed: 'You can leave a review once this booking has been marked complete.',
  window_closed: 'The review period for this booking has closed.',
  already_reviewed: 'You have already reviewed this booking.',
  not_customer: 'Only the customer on this booking can leave a review.',
};

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'long' }).format(new Date(iso));
}

export default function BookingReviewPage() {
  const params = useParams<{ id: string }>();
  const bookingId = params.id;
  const router = useRouter();

  const [status, setStatus] = useState<PageStatus>('loading');
  const [state, setState] = useState<BookingReviewStateDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const [rating, setRating] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [media, setMedia] = useState<FileAssetDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState<ReviewDto | null>(null);

  const idempotencyKey = useMemo(newIdempotencyKey, []);

  const load = useCallback(async () => {
    const response = await apiFetch<BookingReviewStateDto>(`/api/v1/bookings/${bookingId}/reviews`);
    if (!response.ok) {
      setError(response.error?.message ?? "Something went wrong. Please try again.");
      setStatus('error');
      return;
    }
    setState(response.data!);
    setStatus('ready');
  }, [bookingId]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = useCallback(async () => {
    if (rating === null) {
      setFormError('Choose a rating first.');
      return;
    }
    const trimmed = text.trim();
    if (trimmed.length > 0 && trimmed.length < MIN_TEXT_LENGTH) {
      setFormError(`If you write something, please use at least ${MIN_TEXT_LENGTH} characters.`);
      return;
    }

    setBusy(true);
    setFormError(null);
    const response = await apiFetch<ReviewDto>(`/api/v1/bookings/${bookingId}/reviews`, {
      method: 'POST',
      headers: mutateHeaders({ 'Idempotency-Key': idempotencyKey }),
      body: JSON.stringify({
        rating,
        text: trimmed.length > 0 ? trimmed : null,
        mediaFileAssetIds: media.map((asset) => asset.id),
      }),
    });
    setBusy(false);

    if (!response.ok) {
      setFormError(response.error?.message ?? "Something went wrong. Please try again.");
      return;
    }
    setSubmitted(response.data!);
    setStatus('submitted');
  }, [bookingId, idempotencyKey, media, rating, text]);

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
        <ErrorState title="Review unavailable" description={error ?? 'Please try again.'} />
        <Link className={styles.eyebrowLink} href={`/bookings/${bookingId}`}>
          Back to booking
        </Link>
      </main>
    );
  }

  if (status === 'submitted' && submitted) {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>Thank you for your review</h1>
        <Card>
          <p className={styles.hint}>
            Your review is published on the provider&rsquo;s profile. They can reply to it once; you will be notified
            if they do.
          </p>
        </Card>
        <Link className={styles.eyebrowLink} href={`/bookings/${bookingId}`}>
          Back to booking
        </Link>
      </main>
    );
  }

  // Not eligible: show the server's own reason rather than a form that would only be refused.
  if (state && !state.eligible) {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>Leave a review</h1>
        <Card>
          <p className={styles.hint}>{INELIGIBLE_COPY[state.reason ?? ''] ?? 'This booking cannot be reviewed.'}</p>
          {state.reason === 'not_completed' && state.windowClosesAt === null ? null : state.windowClosesAt ? (
            <p className={styles.hint}>The review period closed on {formatDate(state.windowClosesAt)}.</p>
          ) : null}
        </Card>
        <Link className={styles.eyebrowLink} href={`/bookings/${bookingId}`}>
          Back to booking
        </Link>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Leave a review</h1>

      {state?.windowClosesAt ? (
        <p className={styles.subtitle}>You can review this booking until {formatDate(state.windowClosesAt)}.</p>
      ) : null}

      <Card>
        <div className={styles.section}>
          <RatingInput value={rating} onChange={setRating} label="How was the service?" disabled={busy} />
        </div>

        <div className={styles.section}>
          {/* A real <label for> rather than a `label` prop: `ui/`'s Textarea does not take one,
              and `FormField` is another spec's in-flight work this spec does not depend on. */}
          <label className={styles.detailLabel} htmlFor="review-text">
            Tell others about it (optional)
          </label>
          <Textarea
            id="review-text"
            value={text}
            maxLength={MAX_TEXT_LENGTH}
            onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setText(event.target.value)}
            disabled={busy}
          />
          <p className={styles.hint}>
            Optional. If you write something, please use at least {MIN_TEXT_LENGTH} characters. Leave out phone
            numbers and email addresses &mdash; reviews are public.
          </p>
        </div>

        <div className={styles.section}>
          <FileUpload
            contextType="review_media"
            contextId={bookingId}
            accept="image/*"
            maxFiles={MAX_REVIEW_MEDIA}
            visibility="public"
            label="Add photos (optional)"
            onChange={setMedia}
          />
        </div>

        {formError ? <p className={styles.hint}>{formError}</p> : null}

        <div className={styles.actions}>
          <Button onClick={submit} disabled={busy || rating === null}>
            {busy ? 'Publishing…' : 'Publish review'}
          </Button>
          <Button variant="secondary" onClick={() => router.push(`/bookings/${bookingId}`)} disabled={busy}>
            Cancel
          </Button>
        </div>
      </Card>
    </main>
  );
}
