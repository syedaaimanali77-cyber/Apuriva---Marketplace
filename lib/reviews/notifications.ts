/**
 * Spec 029 §9 — the two notifications this spec produces, through spec 026's `notify()`.
 *
 * Called DIRECTLY rather than through a port, the way spec 015's request cancellation and spec 016's
 * availability opt-in do: spec 026 already ships, so there is nothing to register inertly and
 * nothing to wire. Two entries were added to spec 026's closed catalogue; the WORDS live there, and
 * only ids travel as params — a notification must never become a channel through which one user
 * sends another arbitrary text (§4 "Retention and privacy").
 *
 * Both are best-effort and are invoked outside the creating transaction: a notification failure must
 * never roll back a published review or a posted reply.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { notify } from '@/lib/notifications';
import { queryRows } from '@/lib/offers/db';

/** Tells the booking's provider that a review was left, so they can exercise their right of reply. */
export async function notifyReviewReceived(reviewId: string, bookingId: string): Promise<void> {
  const [row] = await queryRows<{ provider_user_id: string }>(
    getDb(),
    sql`SELECT pp.user_id AS provider_user_id
          FROM bookings b
          JOIN provider_profiles pp ON pp.id = b.provider_profile_id
         WHERE b.id = ${bookingId}`,
  );
  if (!row) return;

  await notify({
    recipientUserId: row.provider_user_id,
    type: 'review_received',
    // Deterministic (spec 026 AC-7): the same event retried produces the same key, never a
    // timestamp and never a random value.
    eventKey: `review_received:${reviewId}`,
    params: { reviewId },
  });
}

/** Tells the reviewer that the provider replied. */
export async function notifyReviewResponsePosted(reviewId: string): Promise<void> {
  const [row] = await queryRows<{ author_user_id: string }>(
    getDb(),
    sql`SELECT r.author_user_id FROM reviews r WHERE r.id = ${reviewId}`,
  );
  if (!row) return;

  await notify({
    recipientUserId: row.author_user_id,
    type: 'review_response_posted',
    eventKey: `review_response_posted:${reviewId}`,
    params: { reviewId },
  });
}
