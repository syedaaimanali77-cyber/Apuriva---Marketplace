'use client';

/**
 * Spec 029 §5 — one review, as every reader sees it.
 *
 * Composed from what already exists: the design system's `Card` and `Rating`, spec 027's
 * `MediaPreview`, and the existing tokens. No `ui/` primitive is created and none is forked.
 *
 * WHAT THIS COMPONENT DELIBERATELY CANNOT RENDER. There is no "flagged", "pending", "under review"
 * or "reported" badge anywhere, and `PublicReviewDto` carries no `status` field to drive one even
 * if someone added the markup. A flagged review therefore looks exactly like a published one to
 * every reader, which is what AC-4 and AC-5 mean in practice: a heuristic's suspicion is a request
 * for a human to look, never a signal shown to the public.
 *
 * There is no reviewer name either, because this repository has no customer display-name field
 * anywhere (spec 029 §8 question 3) — the DTO simply does not carry one.
 */
import { Card, Rating } from '@/components';
import { MediaPreview } from '@/app/_components/MediaPreview';
import { useLocale } from '@/app/_components/LocaleProvider';
import { formatDate as formatLocaleDate } from '@/lib/i18n/format';
import type { PublicReviewDto } from '@/lib/types/reviews';
import styles from './review-card.module.css';

export interface ReviewCardProps {
  review: PublicReviewDto;
  /** Rendered only when the viewer is someone who could act on it — never for the author. */
  onReport?: (review: PublicReviewDto) => void;
}

export function ReviewCard({ review, onReport }: ReviewCardProps) {
  const { locale, t } = useLocale();
  // Spec 042 X-11: the shared formatter, for the reader's locale (still identical on server and client).
  const formatDate = (iso: string) => formatLocaleDate(iso, locale, { dateStyle: 'medium' });
  return (
    <Card>
      <article className={styles.review} aria-label={t('price.review.rated', { rating: review.rating })}>
        <header className={styles.header}>
          <Rating value={review.rating} size="sm" />
          <time className={styles.date} dateTime={review.createdAt}>
            {formatDate(review.createdAt)}
          </time>
        </header>

        {review.text ? <p className={styles.text}>{review.text}</p> : null}

        {review.media.length > 0 ? (
          <ul className={styles.media}>
            {review.media.map((asset) => (
              <li key={asset.id}>
                <MediaPreview asset={asset} />
              </li>
            ))}
          </ul>
        ) : null}

        {review.response ? (
          <section className={styles.response} aria-label={t('price.review.providerResponse')}>
            <h4 className={styles.responseHeading}>{t('price.review.responseHeading')}</h4>
            <p className={styles.text}>{review.response.text}</p>
            <time className={styles.date} dateTime={review.response.createdAt}>
              {formatDate(review.response.createdAt)}
            </time>
          </section>
        ) : null}

        {onReport ? (
          <button type="button" className={styles.report} onClick={() => onReport(review)}>
            {t('price.review.report')}
          </button>
        ) : null}
      </article>
    </Card>
  );
}
