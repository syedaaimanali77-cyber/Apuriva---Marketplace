/**
 * Spec 032 §3 "Context attachment" (AC-2, DECIDED-6) — the boundary that makes
 * "booking/payment/dispute context attached automatically" safe.
 *
 * THE CLIENT IS NEVER TRUSTED. A `contextId` is an opaque identifier the server re-resolves and
 * re-authorizes through the OWNING SPEC'S OWN HELPER, every single time — at creation and on every
 * subsequent read. Nothing about the object is copied onto the ticket.
 *
 * EVERY FAILURE IS THE SAME ERROR. Unknown id, deleted row, and a real object the caller has no
 * relationship to all produce `422 SUPPORT_CONTEXT_NOT_AVAILABLE` with an identical message, so
 * these routes cannot be used to enumerate bookings, payments or disputes. This is the same
 * enumeration-safety reasoning behind spec 031's "a non-participant gets `404`, never `403`".
 * `lib/support/context.integration.test.ts` asserts the responses are byte-identical.
 *
 * CONTEXT IS LIVE, NOT SNAPSHOTTED. Reads re-resolve, so the user and the admin always see the
 * object's current state rather than a stale copy that could contradict the source of truth. And
 * when re-resolution fails on a READ the ticket still opens, carrying `available: false` — a
 * support ticket must never become unopenable because its subject changed.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows, type Executor } from '@/lib/offers/db';
import { requireBookingParticipant } from '@/lib/bookings/read';
import type { SupportContextDto, SupportContextType } from '@/lib/types/support';
import { supportContextNotAvailableError } from './errors';

/**
 * Resolves a context to the booking whose participants own it, and to a neutral status string.
 *
 * `payment` and `dispute` both resolve THROUGH their booking, because that is where participation
 * is defined in this repository — `payments.booking_id` (spec 021) and `disputes.booking_id`
 * (spec 031). Participation in the dispute's booking is exactly spec 031's own participant rule.
 */
async function resolveBookingAndStatus(
  db: Executor,
  contextType: SupportContextType,
  contextId: string,
): Promise<{ bookingId: string; status: string } | null> {
  if (contextType === 'booking') {
    const [row] = await queryRows<{ id: string; status: string }>(
      db,
      sql`SELECT id, status FROM bookings WHERE id = ${contextId}`,
    );
    return row ? { bookingId: row.id, status: row.status } : null;
  }

  if (contextType === 'payment') {
    const [row] = await queryRows<{ booking_id: string; status: string }>(
      db,
      sql`SELECT booking_id, status FROM payments WHERE id = ${contextId}`,
    );
    return row ? { bookingId: row.booking_id, status: row.status } : null;
  }

  const [row] = await queryRows<{ booking_id: string; status: string }>(
    db,
    sql`SELECT booking_id, status FROM disputes WHERE id = ${contextId}`,
  );
  return row ? { bookingId: row.booking_id, status: row.status } : null;
}

/**
 * AC-2 at CREATION — throws the uniform `422` if the caller may not attach this object.
 *
 * `requireBookingParticipant` is called with NO `preferRole`: either party to a booking may raise a
 * support ticket about it, and forcing a mode here would block a provider asking about a booking
 * they took as a customer.
 *
 * Its own `bookingNotFoundError` is deliberately swallowed and replaced: spec 020's `404` is right
 * for a booking route, but here it would distinguish "no such booking" from "not yours" across two
 * different status codes. One code, one message, no signal.
 */
export async function authorizeContext(
  userId: string,
  contextType: SupportContextType,
  contextId: string,
  db: Executor = getDb(),
): Promise<void> {
  let resolved: { bookingId: string; status: string } | null;
  try {
    resolved = await resolveBookingAndStatus(db, contextType, contextId);
  } catch {
    throw supportContextNotAvailableError();
  }
  if (!resolved) throw supportContextNotAvailableError();

  try {
    await requireBookingParticipant(userId, resolved.bookingId, undefined, db);
  } catch {
    throw supportContextNotAvailableError();
  }
}

/**
 * AC-2 on READ — the non-throwing form.
 *
 * Returns `available: false` rather than raising, because the ticket must stay readable whatever
 * happened to its subject. The status is the owning table's own neutral status string and NOTHING
 * else: no amount, no currency, no counterparty, no dispute reason. That is true for the admin
 * projection too — the workspace renders a LINK into the owning spec's permissioned surface, so
 * this spec widens no existing exposure.
 */
export async function projectContext(
  viewerUserId: string,
  contextType: string | null,
  contextId: string | null,
  options: { viewerIsAdmin?: boolean } = {},
  db: Executor = getDb(),
): Promise<SupportContextDto | null> {
  if (contextType === null || contextId === null) return null;
  const type = contextType as SupportContextType;

  let resolved: { bookingId: string; status: string } | null = null;
  try {
    resolved = await resolveBookingAndStatus(db, type, contextId);
  } catch {
    resolved = null;
  }
  if (!resolved) return { type, id: contextId, status: null, available: false };

  // An admin holding `support/read` sees the neutral status without being a party — they need to
  // know a ticket is about a cancelled booking to work it. They still see nothing beyond that.
  if (options.viewerIsAdmin) {
    return { type, id: contextId, status: resolved.status, available: true };
  }

  try {
    await requireBookingParticipant(viewerUserId, resolved.bookingId, undefined, db);
  } catch {
    // The requester lost access to the object after raising the ticket (a role change, a transfer).
    // The ticket and its conversation remain theirs; the pointer simply goes dark.
    return { type, id: contextId, status: null, available: false };
  }

  return { type, id: contextId, status: resolved.status, available: true };
}
