'use client';

/**
 * Spec 029 §5 "Admin (Trust & Safety)" — the review moderation queue and the resolution form.
 *
 * NOTE THE PATH. `app/admin/actions/review/page.tsx` already exists and is spec 009's *post-action
 * review* queue — an unrelated feature about admin actions, not about customer reviews. This page
 * is therefore a sibling at `review-moderation`, not a replacement for it.
 *
 * THE SCREEN PRESENTS SIGNALS AS SIGNALS, NEVER AS A VERDICT. The flag codes are labelled as
 * "what a rule noticed", the reports are shown as what a person said, and the review itself is
 * shown in full — because master spec §52 forbids suppressing legitimate criticism, and a screen
 * that led with "flagged: spam" would be the easiest way for a reviewer to rubber-stamp a removal.
 * The queue is ordered oldest-first, so nothing waits indefinitely.
 *
 * Resolution requires a reason (master §68) and offers a decision from a closed set. There is
 * deliberately no visibility toggle and no status field: an admin decides what happened, and the
 * server derives the row from that. `expectedStatus` is sent with every decision, so two admins
 * working the queue at once cannot silently overwrite each other.
 *
 * Reporter identities are not in the payload at all — a reporter whose identity can leak to the
 * reviewed provider will not report, so the API never returns one.
 */
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, ErrorState, Rating, Select, Skeleton, Textarea } from '@/components';
import { apiFetch, mutateHeaders } from '@/app/requests/api-client';
import {
  REVIEW_MODERATION_DECISIONS,
  type AdminReviewDto,
  type ReviewModerationDecision,
  type ReviewSignalCode,
} from '@/lib/types/reviews';
import { MAX_MODERATION_REASON_LENGTH, MIN_MODERATION_REASON_LENGTH } from '@/lib/reviews/limits';
import styles from '../../admin.module.css';

const DECISION_LABELS: Record<ReviewModerationDecision, string> = {
  keep: 'Keep it published',
  remove: 'Remove it',
  reinstate: 'Put it back',
};

/** Plain descriptions of what a RULE noticed — never a conclusion about the reviewer. */
const SIGNAL_LABELS: Record<ReviewSignalCode, string> = {
  profanity: 'Contains a word on the profanity list',
  contact_sharing: 'Contains something that looks like a phone number or email address',
  spam_shape: 'Shaped like spam (repeated words, several links, or mostly non-letters)',
  burst_submission: 'This author posted several reviews within an hour',
  repeat_pair: 'This author has reviewed this provider several times recently',
};

const REASON_LABELS: Record<string, string> = {
  spam: 'Spam or advertising',
  offensive: 'Offensive or abusive language',
  false_information: 'Untrue account of what happened',
  personal_information: 'Contains personal information',
  off_topic: 'Not about this service',
  other: 'Something else',
};

export default function AdminReviewModerationPage() {
  const [reviews, setReviews] = useState<AdminReviewDto[] | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AdminReviewDto | null>(null);
  const [decision, setDecision] = useState<ReviewModerationDecision>('keep');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await apiFetch<AdminReviewDto[]>('/api/v1/admin/reviews/moderation-queue');
    if (!response.ok) {
      setPageError(response.error?.message ?? "The moderation queue could not be loaded.");
      setReviews([]);
      return;
    }
    setReviews(response.data ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const resolve = useCallback(async () => {
    if (!selected) return;
    const trimmed = reason.trim();
    if (trimmed.length < MIN_MODERATION_REASON_LENGTH || trimmed.length > MAX_MODERATION_REASON_LENGTH) {
      setFormError(
        `A reason of ${MIN_MODERATION_REASON_LENGTH}–${MAX_MODERATION_REASON_LENGTH} characters is required.`,
      );
      return;
    }

    setBusy(true);
    setFormError(null);
    const response = await apiFetch<AdminReviewDto>(`/api/v1/admin/reviews/${selected.id}/resolve`, {
      method: 'POST',
      headers: mutateHeaders(),
      // `expectedStatus` is what this admin was actually shown — the optimistic-concurrency token.
      body: JSON.stringify({ decision, reason: trimmed, expectedStatus: selected.status }),
    });
    setBusy(false);

    if (!response.ok) {
      setFormError(response.error?.message ?? "Something went wrong. Please try again.");
      return;
    }
    setSelected(null);
    setReason('');
    await load();
  }, [decision, load, reason, selected]);

  if (reviews === null) {
    return (
      <main className={styles.page}>
        <Skeleton />
      </main>
    );
  }

  if (pageError) {
    return (
      <main className={styles.page}>
        <ErrorState title="Moderation queue unavailable" description={pageError} />
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Review moderation</h1>
      <p className={styles.subtitle}>
        Flagged reviews and reviews someone reported, oldest first. Everything here is still visible to the public —
        a flag is a request to look, not a removal.
      </p>

      {reviews.length === 0 ? (
        <Card>
          <p>Nothing is waiting for review.</p>
        </Card>
      ) : (
        <ul className={styles.list}>
          {reviews.map((review) => (
            <li key={review.id}>
              <Card>
                <div>
                  <Rating value={review.rating} size="sm" />
                  <Badge>{review.status}</Badge>
                </div>

                {review.text ? <p>{review.text}</p> : <p>(No written review — a rating only.)</p>}

                {review.flagSignals.length > 0 ? (
                  <section aria-label="What a rule noticed">
                    <h3>What a rule noticed</h3>
                    <ul>
                      {review.flagSignals.map((code) => (
                        <li key={code}>{SIGNAL_LABELS[code] ?? code}</li>
                      ))}
                    </ul>
                  </section>
                ) : null}

                {review.reports.length > 0 ? (
                  <section aria-label="Reports">
                    <h3>Reports ({review.reportCount})</h3>
                    <ul>
                      {review.reports.map((report) => (
                        <li key={report.id}>
                          {REASON_LABELS[report.reason] ?? report.reason}
                          {report.details ? ` — ${report.details}` : ''}
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}

                {review.removalReason ? <p>Previously removed because: {review.removalReason}</p> : null}

                <Button
                  onClick={() => {
                    setSelected(review);
                    setDecision(review.status === 'removed' ? 'reinstate' : 'keep');
                    setReason('');
                    setFormError(null);
                  }}
                >
                  Resolve
                </Button>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {selected ? (
        <Card>
          <h2 className={styles.sectionTitle}>Resolve this review</h2>

          <label htmlFor="moderation-decision">Decision</label>
          <Select
            id="moderation-decision"
            value={decision}
            options={REVIEW_MODERATION_DECISIONS.map((value) => ({ value, label: DECISION_LABELS[value] }))}
            onChange={(event: React.ChangeEvent<HTMLSelectElement>) =>
              setDecision(event.target.value as ReviewModerationDecision)
            }
            disabled={busy}
          />

          <label htmlFor="moderation-reason">Reason (recorded in the audit log)</label>
          <Textarea
            id="moderation-reason"
            value={reason}
            maxLength={MAX_MODERATION_REASON_LENGTH}
            onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setReason(event.target.value)}
            disabled={busy}
          />

          {formError ? <p role="alert">{formError}</p> : null}

          <div className={styles.actions}>
            <Button onClick={resolve} disabled={busy}>
              {busy ? 'Saving…' : 'Save decision'}
            </Button>
            <Button variant="secondary" onClick={() => setSelected(null)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </Card>
      ) : null}
    </main>
  );
}
