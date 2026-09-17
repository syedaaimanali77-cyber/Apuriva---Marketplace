/**
 * Spec 028 §3 "Booking-evidence context policy" (AC-7, AC-8) — the resolver that lifts spec 027's
 * reserved `booking_evidence` context out of `422 FILE_CONTEXT_NOT_AVAILABLE`.
 *
 * WHY IT LIVES HERE AND NOT IN `lib/files/contexts/`. Spec 027 §3 makes the consuming spec the
 * owner of "who may see a file in a given context", and `lib/files/boundaries.test.ts` enforces
 * that `lib/files/**` never acquires a consuming spec's business rules. Who may attach evidence to
 * a booking, and when, is a SPEC 028 rule about bookings — so it is written here, in spec 028's own
 * domain, and handed to spec 027's registry from the composition root. Spec 027's source is not
 * touched at all.
 *
 * `contextId` is the BOOKING id. The two rules, and why each is what it is:
 *
 *   UPLOAD — the booking's own provider, in provider mode, and only while the job is actually being
 *   executed (`arrived` or `in_progress`). Completion evidence that could be pre-staged before
 *   arrival, or bolted on days after the fact, would not be evidence of anything. Because this is
 *   the ONLY way a `booking_evidence` row can come into existence, the completion gate's count can
 *   trust its own rows without re-deriving who uploaded them (see `evidence.ts`).
 *
 *   READ — the booking's provider always; the booking's customer only once the booking has actually
 *   reached `completed`. Nobody else, and deliberately no admin or Trust & Safety bypass: spec 031
 *   owns dispute access and registers its own AUDITED rule, exactly as spec 025 did for
 *   conversations (§8 #2). Shipping a broad unaudited read now, for a feature nobody can yet use,
 *   would be worse than the gap.
 *
 * `canRead` is re-run by spec 027 on every URL issue and every content fetch, so this is the live
 * answer to "may this caller see this", never a decision cached at upload time.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { isUuid } from '@/lib/offers/validation';
import { registerFileContextPolicy, type FileContextPolicy } from '@/lib/files/contexts/registry';
import { BOOKING_EVIDENCE_CONTEXT, hasReachedCompleted, MAX_BOOKING_EVIDENCE_ASSETS } from './evidence';
import { EXECUTING_BOOKING_STATUSES } from './execution-window';

/** Whether `userId` is this booking's provider, and (optionally) the booking is mid-execution. */
async function isBookingProvider(userId: string, bookingId: string, executingOnly = false): Promise<boolean> {
  if (!isUuid(bookingId)) return false;
  const statusFilter = executingOnly
    ? sql` AND b.status IN (${sql.join(EXECUTING_BOOKING_STATUSES.map((s) => sql`${s}`), sql`, `)})`
    : sql``;
  const rows = await queryRows<{ id: string }>(
    getDb(),
    sql`SELECT b.id FROM bookings b
          JOIN provider_profiles pp ON pp.id = b.provider_profile_id
         WHERE b.id = ${bookingId} AND pp.user_id = ${userId}${statusFilter}`,
  );
  return rows.length > 0;
}

async function isBookingCustomer(userId: string, bookingId: string): Promise<boolean> {
  if (!isUuid(bookingId)) return false;
  const rows = await queryRows<{ id: string }>(
    getDb(),
    sql`SELECT b.id FROM bookings b
          JOIN customer_profiles cp ON cp.id = b.customer_profile_id
         WHERE b.id = ${bookingId} AND cp.user_id = ${userId}`,
  );
  return rows.length > 0;
}

export const bookingEvidencePolicy: FileContextPolicy = {
  /** Never public, ever — evidence routinely shows the inside of a customer's home (§4). */
  publicEligible: false,
  maxPerContext: MAX_BOOKING_EVIDENCE_ASSETS,
  allowedKinds: ['image', 'video', 'document'],

  async canUpload({ userId, activeMode, contextId }) {
    if (activeMode !== 'provider') return false;
    if (!contextId) return false;
    return isBookingProvider(userId, contextId, true);
  },

  async canRead({ userId, asset }) {
    const bookingId = asset.context_id;
    if (!bookingId || !isUuid(bookingId)) return false;
    if (await isBookingProvider(userId, bookingId)) return true;
    // AC-8: the customer's access begins at completion, not before.
    if (!(await isBookingCustomer(userId, bookingId))) return false;
    return hasReachedCompleted(bookingId);
  },
};

/** Called from `instrumentation.ts` — the composition root specs 021–027 already use. */
export function registerBookingEvidenceContext(): void {
  registerFileContextPolicy(BOOKING_EVIDENCE_CONTEXT, bookingEvidencePolicy);
}
