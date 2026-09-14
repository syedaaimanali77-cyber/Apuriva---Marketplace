/**
 * Spec 020 §3 "Creation, in evaluation order" (AC-1, AC-3, AC-12) — `POST /api/v1/bookings`.
 *
 * The client may determine exactly three things: `offerId`, `scheduledAt`, and the
 * `Idempotency-Key`. Everything else that defines the booking — customer, provider, service,
 * address, price, currency, duration, timezone — is resolved server-side from the accepted offer
 * and its request, and a client-supplied value for any of them is ignored, not merely rejected.
 *
 * LOCK ORDER is the repository-wide `requests -> offers -> provider_profiles`. Spec 018's
 * `lib/offers/decide.ts` already takes `requests -> offers`; spec 016's schedule writer takes
 * `provider_profiles` alone. Adding this path introduces no cycle, so no deadlock is possible.
 *
 * The slot reservation (spec 016's `reserveProviderSlot`, which takes the provider row lock) and
 * the booking INSERT happen inside ONE transaction, which is what makes double-booking impossible
 * (AC-12) rather than merely unlikely.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { validationError } from '@/lib/api/errors';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import { reserveProviderSlot } from '@/lib/availability/reserve';
import { findProviderSchedulingProfile } from '@/lib/availability/repository';
import { isUniqueViolation, queryRows, type Executor } from '@/lib/offers/db';
import { isUuid } from '@/lib/offers/validation';
import type { CreateBookingRequest } from '@/lib/types/bookings';
import { buildSlotUnavailableDetails } from './alternatives';
import { registerBookingBusyIntervals } from './busy-intervals';
import {
  bookingAlreadyExistsError,
  idempotencyKeyConflictError,
  offerNotAcceptableError,
  offerNotFoundError,
  requestNotActionableError,
  slotNoLongerAvailableError,
} from './errors';
import { loadBookingDto } from './read';
import { confirmBooking, recordBookingCreated } from './state-machine';
import { getBookingConfirmationGate } from './confirmation-gate';

/** The default a provider service falls back to — `provider_services.duration_minutes`'s own default. */
const FALLBACK_DURATION_MINUTES = 60;

export interface CreateBookingResult {
  booking: Awaited<ReturnType<typeof loadBookingDto>>;
  /** false when an idempotent replay returned an existing booking — the route answers 200, not 201. */
  created: boolean;
}

interface OfferContext {
  offerId: string;
  requestId: string;
  customerProfileId: string;
  providerProfileId: string;
  serviceId: string;
  addressId: string;
  preferredAt: Date | null;
}

/**
 * Steps 1–4 run OUTSIDE the transaction, so a stranger probing offer ids never causes a lock.
 * A missing offer and an offer belonging to someone else are indistinguishable (`404`), exactly as
 * `lib/offers/decide.ts` already resolves a customer's offer.
 */
async function customerOfferContext(userId: string, offerId: string): Promise<OfferContext> {
  if (!isUuid(offerId)) throw offerNotFoundError();
  const [row] = await queryRows<OfferContext>(
    getDb(),
    sql`SELECT o.id           AS "offerId",
               o.request_id   AS "requestId",
               cp.id          AS "customerProfileId",
               o.provider_profile_id AS "providerProfileId",
               r.service_id   AS "serviceId",
               r.address_id   AS "addressId",
               r.preferred_at AS "preferredAt"
          FROM offers o
          JOIN requests r ON r.id = o.request_id
          JOIN customer_profiles cp ON cp.id = r.customer_profile_id
         WHERE o.id = ${offerId} AND cp.user_id = ${userId} AND o.status <> 'draft'`,
  );
  if (!row) throw offerNotFoundError();
  return row;
}

function parseBody(body: unknown): CreateBookingRequest {
  const input = (body ?? {}) as Record<string, unknown>;
  const errors: { field: string; message: string }[] = [];

  const offerId = typeof input.offerId === 'string' ? input.offerId.trim() : '';
  if (offerId.length === 0) errors.push({ field: 'offerId', message: 'is required' });
  else if (!isUuid(offerId)) errors.push({ field: 'offerId', message: 'must be a UUID' });

  let scheduledAt: string | undefined;
  if (input.scheduledAt !== undefined && input.scheduledAt !== null) {
    if (typeof input.scheduledAt !== 'string' || Number.isNaN(new Date(input.scheduledAt).getTime())) {
      errors.push({ field: 'scheduledAt', message: 'must be an ISO-8601 date-time' });
    } else {
      scheduledAt = new Date(input.scheduledAt).toISOString();
    }
  }

  if (errors.length > 0) throw validationError(errors);
  return { offerId, scheduledAt };
}

/** Step 12 — fixed precedence, no other source. */
async function resolveDurationMinutes(tx: Executor, context: OfferContext): Promise<number> {
  const [row] = await queryRows<{ duration: number | null }>(
    tx,
    sql`SELECT COALESCE(
                 (SELECT o.estimated_duration_minutes FROM offers o WHERE o.id = ${context.offerId}),
                 (SELECT ps.duration_minutes FROM provider_services ps
                   WHERE ps.provider_profile_id = ${context.providerProfileId}
                     AND ps.service_id = ${context.serviceId}),
                 ${FALLBACK_DURATION_MINUTES}
               ) AS duration`,
  );
  return row?.duration ?? FALLBACK_DURATION_MINUTES;
}

/**
 * `POST /api/v1/bookings`. Returns the created (or replayed) booking.
 *
 * Throws `422 SLOT_NO_LONGER_AVAILABLE` with AC-2's full `details` when the slot is gone — built
 * AFTER the transaction has rolled back, so the provider lock is never held while alternatives are
 * computed.
 */
export async function createBooking(
  customerUserId: string,
  idempotencyKey: string,
  body: unknown,
): Promise<CreateBookingResult> {
  // Makes spec 016's `reserveProviderSlot` see real bookings (spec 016 §3 "Interface with spec 020").
  registerBookingBusyIntervals();

  const parsed = parseBody(body);
  const context = await customerOfferContext(customerUserId, parsed.offerId);
  const fingerprint = idempotencyFingerprint({ offerId: parsed.offerId, scheduledAt: parsed.scheduledAt ?? null });

  let bookingId = '';
  let created = false;
  let slotConflict: { startAt: Date; durationMinutes: number } | null = null;

  try {
    await getDb().transaction(async (tx) => {
      // Steps 5–6 — the fixed lock order.
      await tx.execute(sql`SELECT id FROM requests WHERE id = ${context.requestId} FOR UPDATE`);
      const [offer] = await queryRows<{ status: string }>(
        tx,
        sql`SELECT status FROM offers WHERE id = ${context.offerId} FOR UPDATE`,
      );
      const [request] = await queryRows<{ status: string }>(
        tx,
        sql`SELECT status FROM requests WHERE id = ${context.requestId}`,
      );
      if (!offer || !request) throw offerNotFoundError();

      // Step 7 — idempotent replay, judged under the lock.
      const [existingByKey] = await queryRows<{ id: string; idempotency_fingerprint: string }>(
        tx,
        sql`SELECT id, idempotency_fingerprint FROM bookings
             WHERE customer_profile_id = ${context.customerProfileId} AND idempotency_key = ${idempotencyKey}`,
      );
      if (existingByKey) {
        if (existingByKey.idempotency_fingerprint !== fingerprint) throw idempotencyKeyConflictError();
        bookingId = existingByKey.id;
        console.log(JSON.stringify({ event: 'booking.idempotent_replay', bookingId }));
        return;
      }

      // Step 8 — one booking per offer.
      const [existingByOffer] = await queryRows<{ id: string }>(
        tx,
        sql`SELECT id FROM bookings WHERE offer_id = ${context.offerId}`,
      );
      if (existingByOffer) throw bookingAlreadyExistsError(existingByOffer.id);

      // Step 9 — offer state. An accepted offer's `expires_at` is historical and is NOT re-checked
      // (spec 018 §3: "spec 020 decides what an accepted offer permits").
      if (offer.status !== 'accepted') {
        const reason =
          offer.status === 'revised' ? 'superseded' : offer.status === 'sent' || offer.status === 'viewed' ? 'not_accepted' : offer.status;
        throw offerNotAcceptableError(reason, offer.status);
      }

      // Step 10 — request state.
      if (request.status !== 'provider_selected') {
        throw requestNotActionableError(`This request is no longer ready for booking (status: ${request.status}).`);
      }

      // Step 11 — the scheduled instant and the zone it is local to.
      const profile = await findProviderSchedulingProfile(context.providerProfileId, tx);
      if (!profile) throw offerNotFoundError();

      const startAt = parsed.scheduledAt ? new Date(parsed.scheduledAt) : context.preferredAt ? new Date(context.preferredAt) : null;
      if (!startAt) {
        throw validationError([
          { field: 'scheduledAt', message: 'is required because this request has no preferred time' },
        ]);
      }

      // Step 12 — duration.
      const durationMinutes = await resolveDurationMinutes(tx, context);

      // A time already past is treated exactly like a lost slot, so the customer gets alternatives
      // rather than a bare validation error.
      const [clock] = await queryRows<{ past: boolean }>(
        tx,
        sql`SELECT clock_timestamp() >= ${startAt.toISOString()}::timestamptz AS past`,
      );
      if (clock?.past) {
        slotConflict = { startAt, durationMinutes };
        throw new SlotConflict();
      }

      // Step 13 — spec 016's primitive, inside this transaction, before the insert, holding the
      // provider row lock. Its `SLOT_OVERLAP` message is never forwarded: it can name a busy
      // interval's `sourceId`, which spec 016 restricts to the owning provider.
      try {
        await reserveProviderSlot(tx, {
          providerProfileId: context.providerProfileId,
          serviceId: context.serviceId,
          startAt,
          durationMinutes,
        });
      } catch (err) {
        if ((err as { code?: string })?.code === 'SLOT_OVERLAP') {
          slotConflict = { startAt, durationMinutes };
          throw new SlotConflict();
        }
        throw err;
      }

      // Steps 14–15 — price copied VERBATIM from the accepted offer row; insert; confirm.
      const inserted = await queryRows<{ id: string; version: number }>(
        tx,
        sql`INSERT INTO bookings (
               offer_id, status, request_id, service_id, customer_profile_id, provider_profile_id,
               address_id, scheduled_at, scheduled_timezone, duration_minutes,
               price_amount_minor_units, price_currency_code, idempotency_key, idempotency_fingerprint
             )
             SELECT o.id, 'pending', ${context.requestId}, ${context.serviceId}, ${context.customerProfileId},
                    ${context.providerProfileId}, ${context.addressId}, ${startAt.toISOString()}::timestamptz,
                    ${profile.timezone}, ${durationMinutes},
                    o.price_amount_minor_units, o.price_currency_code,
                    ${idempotencyKey}, ${fingerprint}
               FROM offers o
              WHERE o.id = ${context.offerId}
           RETURNING id, version`,
      );
      const row = inserted[0]!;
      bookingId = row.id;
      created = true;

      await recordBookingCreated(tx, { bookingId, actorUserId: customerUserId });

      // §3 "Why `pending` then `confirmed` in one transaction" — the gate spec 021 registers.
      // Unregistered (spec 020 standalone) it confirms immediately, exactly as before. Registered,
      // the booking commits `pending` and spec 021 confirms it only once its payment provider has
      // actually confirmed an authorization (its AC-1/AC-6). See `confirmation-gate.ts` for why
      // this is a port and not a call into the payment domain.
      const decision = await getBookingConfirmationGate()(tx, bookingId);
      if (decision.confirmNow) {
        const confirmed = await confirmBooking(tx, {
          bookingId,
          actorUserId: customerUserId,
          expectedVersion: row.version,
        });
        if (!confirmed.applied) {
          // Unreachable in practice: the row was just inserted inside this transaction, so nothing
          // else can have touched it. Fail loudly rather than returning a `pending` booking as if it
          // were confirmed (master spec §132.7 — never claim success the backend did not confirm).
          throw new Error(`booking ${bookingId} could not be confirmed (status ${confirmed.currentStatus})`);
        }
      }

      // Step 16 — the parent request. `booking_created -> completed` is spec 028's and is not seeded.
      await tx.execute(sql`
        UPDATE requests SET status = 'booking_created', updated_at = clock_timestamp(), version = version + 1
         WHERE id = ${context.requestId}
      `);
      await tx.execute(sql`
        INSERT INTO requests_status_history (request_id, from_status, to_status, actor_user_id)
        VALUES (${context.requestId}, 'provider_selected', 'booking_created', ${customerUserId})
      `);
    });
  } catch (err) {
    if (err instanceof SlotConflict) {
      const conflict = slotConflict as unknown as { startAt: Date; durationMinutes: number };
      const details = await buildSlotUnavailableDetails({
        providerProfileId: context.providerProfileId,
        serviceId: context.serviceId,
        requestedStartAt: conflict.startAt,
        durationMinutes: conflict.durationMinutes,
      });
      console.log(
        JSON.stringify({
          event: 'booking.slot_conflict',
          offerId: context.offerId,
          alternativesCount: details.alternatives.length,
        }),
      );
      throw slotNoLongerAvailableError(details);
    }
    // Database backstops for the two uniqueness invariants, in case a concurrent transaction slipped
    // past the pre-checks above (I-3, I-4).
    if (isUniqueViolation(err, 'bookings_offer_id_uq')) {
      const [row] = await queryRows<{ id: string }>(
        getDb(),
        sql`SELECT id FROM bookings WHERE offer_id = ${context.offerId}`,
      );
      throw bookingAlreadyExistsError(row?.id ?? randomUUID());
    }
    if (isUniqueViolation(err, 'bookings_customer_idempotency_key_uq')) throw idempotencyKeyConflictError();
    throw err;
  }

  if (created) console.log(JSON.stringify({ event: 'booking.created', bookingId, offerId: context.offerId }));
  return { booking: await loadBookingDto(bookingId), created };
}

/** Internal signal: unwinds the transaction so alternatives are computed with no lock held. */
class SlotConflict extends Error {}
