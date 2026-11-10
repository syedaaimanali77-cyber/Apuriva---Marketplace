/**
 * Spec 029 §3 "Eligibility" (AC-1, AC-2) — the one definition of "this booking can be reviewed".
 *
 * THE REVIEWABLE FACT IS HISTORY, NOT CURRENT STATUS. A booking that reaches `completed` is moved
 * to `protected` by spec 021's sweep on its next tick and to `settled` 48 hours later, so a rule
 * keyed on `bookings.status = 'completed'` would give most customers a review window about one
 * minute wide. This module therefore reads the `in_progress -> completed` row from
 * `bookings_status_history`, which is append-only (`bookings_status_history_append_only_trg`) and so
 * can never drift — the same predicate spec 028 uses to open customer access to completion evidence.
 *
 * PAYMENT IS NEVER CONSULTED (AC-1). Nothing in `lib/reviews/**` imports a payment module or reads
 * a payment column; `boundary.test.ts` asserts that at the source level, the way spec 020's
 * `payment-boundary.test.ts` does. A booking that completed and was later refunded or disputed is
 * still reviewable: a bad experience is precisely what a review reports, and revoking the right to
 * describe it would be an automatic suppression of criticism (master §52).
 *
 * TIMING IS ALWAYS THE DATABASE CLOCK, read in the same statement as the completion instant — never
 * `now()` (frozen at transaction start) and never a client clock (architecture §5.4).
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows, type Executor } from '@/lib/offers/db';
import { isUuid } from '@/lib/offers/validation';
import type { ReviewIneligibilityReason } from '@/lib/types/reviews';
import { reviewWindowDays } from './limits';

export interface ReviewEligibility {
  eligible: boolean;
  reason: ReviewIneligibilityReason | null;
  /** Null when the booking never completed. */
  completedAt: string | null;
  windowClosesAt: string | null;
  /** The existing review's id, when one already exists. */
  existingReviewId: string | null;
  /** Copied into the review when it is created — never accepted from a client. */
  providerProfileId: string;
  serviceId: string;
}

interface EligibilityRow {
  provider_profile_id: string;
  service_id: string;
  is_customer: boolean;
  completed_at: Date | string | null;
  window_closes_at: Date | string | null;
  window_open: boolean | null;
  existing_review_id: string | null;
}

/**
 * Resolves eligibility for `userId` on `bookingId`, in ONE statement.
 *
 * Membership, the completion instant, the window and the existing-review check are read together so
 * they describe the same moment. `windowClosesAt` is computed in SQL from the history instant plus
 * `REVIEW_WINDOW_DAYS`, and `window_open` compares it against `clock_timestamp()` — so the deadline
 * a client is shown and the deadline the server enforces are the same expression.
 *
 * Returns `null` when the booking does not exist or `userId` is not a participant; callers map that
 * to `404`, indistinguishable from a missing booking, so booking ids cannot be probed.
 */
export async function resolveReviewEligibility(
  userId: string,
  bookingId: string,
  tx?: Executor,
): Promise<ReviewEligibility | null> {
  if (!isUuid(bookingId)) return null;

  const windowDays = reviewWindowDays();

  const [row] = await queryRows<EligibilityRow>(
    tx ?? getDb(),
    sql`WITH completion AS (
          SELECT min(h.occurred_at) AS completed_at
            FROM bookings_status_history h
           WHERE h.booking_id = ${bookingId} AND h.to_status = 'completed'
        )
        SELECT b.provider_profile_id,
               b.service_id,
               (cp.user_id = ${userId}) AS is_customer,
               c.completed_at,
               (c.completed_at + (${windowDays} * interval '1 day')) AS window_closes_at,
               (c.completed_at + (${windowDays} * interval '1 day')) > clock_timestamp() AS window_open,
               (SELECT r.id FROM reviews r WHERE r.booking_id = b.id) AS existing_review_id
          FROM bookings b
          JOIN customer_profiles cp ON cp.id = b.customer_profile_id
          JOIN provider_profiles pp ON pp.id = b.provider_profile_id
          CROSS JOIN completion c
         WHERE b.id = ${bookingId} AND (cp.user_id = ${userId} OR pp.user_id = ${userId})`,
  );
  if (!row) return null;

  const completedAt = row.completed_at === null ? null : new Date(row.completed_at).toISOString();
  const windowClosesAt = row.window_closes_at === null ? null : new Date(row.window_closes_at).toISOString();

  const base = {
    completedAt,
    windowClosesAt,
    existingReviewId: row.existing_review_id,
    providerProfileId: row.provider_profile_id,
    serviceId: row.service_id,
  };

  // Ordered most-specific-first so the UI can explain the single most useful thing. The provider,
  // who is a participant but never the author, gets `not_customer` rather than a false "you may
  // review this" — they see the review, they just cannot write it.
  if (!row.is_customer) return { eligible: false, reason: 'not_customer', ...base };
  if (completedAt === null) return { eligible: false, reason: 'not_completed', ...base };
  if (row.existing_review_id !== null) return { eligible: false, reason: 'already_reviewed', ...base };
  if (!row.window_open) return { eligible: false, reason: 'window_closed', ...base };
  return { eligible: true, reason: null, ...base };
}
