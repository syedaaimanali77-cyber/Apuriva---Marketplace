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
import { useLocale } from '@/app/_components/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/dictionaries/en';
import { formatDate as formatLocaleDate } from '@/lib/i18n/format';
import styles from '../../bookings.module.css';

type PageStatus = 'loading' | 'error' | 'ready' | 'submitted';

/** A stable key per mounted screen, so a double-submit is a replay rather than a second review. */
function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `review-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** The server's reason, rendered as something a customer can act on. */
const INELIGIBLE_COPY: Record<string, MessageKey> = {
  not_completed: 'review.ineligible.not_completed',
  window_closed: 'review.ineligible.window_closed',
  already_reviewed: 'review.ineligible.already_reviewed',
  not_customer: 'review.ineligible.not_customer',
};

export default function BookingReviewPage() {
  const { locale, t, errorText } = useLocale();
  // Spec 042 X-11: the shared formatter, for the reader's locale.
  const formatDate = (iso: string) => formatLocaleDate(iso, locale, { dateStyle: 'long' });
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
      setError(errorText(response.error?.code, response.error?.message, t('review.failed')));
      setStatus('error');
      return;
    }
    setState(response.data!);
    setStatus('ready');
  }, [bookingId, errorText, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = useCallback(async () => {
    if (rating === null) {
      setFormError(t('review.chooseRating'));
      return;
    }
    const trimmed = text.trim();
    if (trimmed.length > 0 && trimmed.length < MIN_TEXT_LENGTH) {
      setFormError(t('review.tooShort', { min: MIN_TEXT_LENGTH }));
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
      setFormError(errorText(response.error?.code, response.error?.message, t('review.failed')));
      return;
    }
    setSubmitted(response.data!);
    setStatus('submitted');
  }, [bookingId, errorText, idempotencyKey, media, rating, t, text]);

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
        <ErrorState title={t('review.unavailableTitle')} description={error ?? t('review.tryAgain')} />
        <Link className={styles.eyebrowLink} href={`/bookings/${bookingId}`}>
          {t('review.back')}
        </Link>
      </main>
    );
  }

  if (status === 'submitted' && submitted) {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>{t('review.thanks')}</h1>
        <Card>
          <p className={styles.hint}>{t('review.published')}</p>
        </Card>
        <Link className={styles.eyebrowLink} href={`/bookings/${bookingId}`}>
          {t('review.back')}
        </Link>
      </main>
    );
  }

  // Not eligible: show the server's own reason rather than a form that would only be refused.
  if (state && !state.eligible) {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>{t('review.title')}</h1>
        <Card>
          <p className={styles.hint}>{t(INELIGIBLE_COPY[state.reason ?? ''] ?? 'review.ineligible.other')}</p>
          {state.reason === 'not_completed' && state.windowClosesAt === null ? null : state.windowClosesAt ? (
            <p className={styles.hint}>{t('review.closedOn', { date: formatDate(state.windowClosesAt) })}</p>
          ) : null}
        </Card>
        <Link className={styles.eyebrowLink} href={`/bookings/${bookingId}`}>
          {t('review.back')}
        </Link>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>{t('review.title')}</h1>

      {state?.windowClosesAt ? (
        <p className={styles.subtitle}>{t('review.until', { date: formatDate(state.windowClosesAt) })}</p>
      ) : null}

      <Card>
        <div className={styles.section}>
          <RatingInput value={rating} onChange={setRating} label={t('review.howWasIt')} disabled={busy} />
        </div>

        <div className={styles.section}>
          {/* A real <label for> rather than a `label` prop: `ui/`'s Textarea does not take one,
              and `FormField` is another spec's in-flight work this spec does not depend on. */}
          <label className={styles.detailLabel} htmlFor="review-text">
            {t('review.tellOthers')}
          </label>
          <Textarea
            id="review-text"
            value={text}
            maxLength={MAX_TEXT_LENGTH}
            onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setText(event.target.value)}
            disabled={busy}
          />
          <p className={styles.hint}>{t('review.textHint', { min: MIN_TEXT_LENGTH })}</p>
        </div>

        <div className={styles.section}>
          <FileUpload
            contextType="review_media"
            contextId={bookingId}
            accept="image/*"
            maxFiles={MAX_REVIEW_MEDIA}
            visibility="public"
            label={t('review.addPhotos')}
            onChange={setMedia}
          />
        </div>

        {formError ? <p className={styles.hint}>{formError}</p> : null}

        <div className={styles.actions}>
          <Button onClick={submit} disabled={busy || rating === null}>
            {busy ? t('review.publishing') : t('review.publish')}
          </Button>
          <Button variant="secondary" onClick={() => router.push(`/bookings/${bookingId}`)} disabled={busy}>
            {t('review.cancel')}
          </Button>
        </div>
      </Card>
    </main>
  );
}
