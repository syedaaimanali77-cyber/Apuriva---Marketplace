/**
 * Spec 018 §3 "Accept — rules in evaluation order", decline, withdraw (AC-1, AC-2, AC-6, AC-8) and
 * "Concurrency and the single-accept invariant".
 *
 * Lock order is ALWAYS request, then offer (the same order creation uses), so no deadlock is possible.
 * The expiry check reads `clock_timestamp()` in a statement issued AFTER the lock is held — never
 * `now()`, which is frozen at transaction start: a transaction that waited on a lock past `expires_at`
 * must see the offer as expired.
 *
 * Spec 019 §3 "Spec 018 path extensions": a stored `revised` row answers `409 OFFER_SUPERSEDED` with the
 * current offer id, checked right after the locks and BEFORE the expiry check, so a superseded offer is
 * never reported as expired and its (immutable) price can never be accepted.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { offerSupersededError } from '@/lib/negotiation/errors';
import type { OfferDto } from '@/lib/types/offers';
import { isUniqueViolation, queryRows, type Executor } from './db';
import {
  offerAlreadyDecidedError,
  offerExpiredError,
  offerNotFoundError,
  requestAlreadyClaimedError,
  requestNotActionableError,
} from './errors';
import { currentOfferIdFor } from './lineage';
import { loadOfferDto } from './read';
import { isUuid } from './validation';

interface LockedOffer {
  status: string;
  accept_idempotency_key: string | null;
}

/** The post-lock clock read. A separate statement, so it can only observe time after the lock. */
async function isLiveNow(tx: Executor, offerId: string): Promise<boolean> {
  const [row] = await queryRows<{ live: boolean }>(
    tx,
    sql`SELECT (status IN ('sent', 'viewed') AND clock_timestamp() < expires_at) AS live FROM offers WHERE id = ${offerId}`,
  );
  return Boolean(row?.live);
}

/** Spec 019: a superseded row can never be decided. */
async function rejectIfSuperseded(tx: Executor, offerId: string, offer: LockedOffer): Promise<void> {
  if (offer.status === 'revised') throw offerSupersededError(await currentOfferIdFor(tx, offerId));
}

/** Resolves the offer's request for a customer action; 404 for a missing offer or a non-owner. */
async function customerOfferRequestId(userId: string, offerId: string): Promise<string> {
  if (!isUuid(offerId)) throw offerNotFoundError();
  const [row] = await queryRows<{ request_id: string }>(
    getDb(),
    sql`SELECT o.request_id FROM offers o
          JOIN requests r ON r.id = o.request_id
          JOIN customer_profiles cp ON cp.id = r.customer_profile_id
        WHERE o.id = ${offerId} AND cp.user_id = ${userId} AND o.status <> 'draft'`,
  );
  if (!row) throw offerNotFoundError();
  return row.request_id;
}

async function lockRequestThenOffer(
  tx: Executor,
  requestId: string,
  offerId: string,
): Promise<{ requestStatus: string; offer: LockedOffer }> {
  const [request] = await queryRows<{ status: string }>(tx, sql`SELECT status FROM requests WHERE id = ${requestId} FOR UPDATE`);
  const [offer] = await queryRows<LockedOffer>(
    tx,
    sql`SELECT status, accept_idempotency_key FROM offers WHERE id = ${offerId} FOR UPDATE`,
  );
  if (!request || !offer) throw offerNotFoundError();
  return { requestStatus: request.status, offer };
}

async function recordOfferTransition(tx: Executor, offerId: string, from: string, to: string, actorUserId: string): Promise<void> {
  await tx.execute(sql`
    INSERT INTO offers_status_history (offer_id, from_status, to_status, actor_user_id)
    VALUES (${offerId}, ${from}, ${to}, ${actorUserId})
  `);
}

function logSupersededRejection(action: string, offerId: string, err: unknown): void {
  if ((err as { code?: string })?.code === 'OFFER_SUPERSEDED') {
    console.log(JSON.stringify({ event: 'negotiation.superseded_action_rejected', action, offerId }));
  }
}

/** `POST /api/v1/offers/{id}/accept` — requires `Idempotency-Key`. Creates no booking (spec 020). */
export async function acceptOffer(customerUserId: string, offerId: string, idempotencyKey: string): Promise<OfferDto> {
  const requestId = await customerOfferRequestId(customerUserId, offerId);

  try {
    await getDb().transaction(async (tx) => {
      const { requestStatus, offer } = await lockRequestThenOffer(tx, requestId, offerId);

      // Step 3 — idempotent replay of this very accept.
      if (offer.status === 'accepted' && offer.accept_idempotency_key === idempotencyKey) return;
      // Spec 019 — a revised row's price is never acceptable.
      await rejectIfSuperseded(tx, offerId, offer);
      // Step 4 — already decided another way.
      if (offer.status === 'accepted' || offer.status === 'declined' || offer.status === 'withdrawn') {
        throw offerAlreadyDecidedError(offer.status);
      }
      // Step 5 — expired, judged by the database clock read after the lock.
      if (!(await isLiveNow(tx, offerId))) throw offerExpiredError();
      // Step 6 — request state.
      if (requestStatus === 'provider_selected' || requestStatus === 'booking_created') throw requestAlreadyClaimedError();
      if (requestStatus !== 'offers_open') {
        throw requestNotActionableError(`This request is no longer open for responses (status: ${requestStatus}).`);
      }

      // Step 7.
      await tx.execute(sql`
        UPDATE offers
           SET status = 'accepted', decided_at = clock_timestamp(), accept_idempotency_key = ${idempotencyKey},
               updated_at = clock_timestamp(), version = version + 1
         WHERE id = ${offerId}
      `);
      await recordOfferTransition(tx, offerId, offer.status, 'accepted', customerUserId);
      await tx.execute(sql`
        UPDATE requests SET status = 'provider_selected', updated_at = clock_timestamp(), version = version + 1
         WHERE id = ${requestId}
      `);
      await tx.execute(sql`
        INSERT INTO requests_status_history (request_id, from_status, to_status, actor_user_id)
        VALUES (${requestId}, 'offers_open', 'provider_selected', ${customerUserId})
      `);
    });
  } catch (err) {
    logSupersededRejection('accept', offerId, err);
    // Database backstop: the partial unique index on accepted offers per request.
    if (isUniqueViolation(err, 'offers_request_accepted_uq')) throw requestAlreadyClaimedError();
    throw err;
  }

  return loadOfferDto(offerId);
}

/** `POST /api/v1/offers/{id}/decline` — naturally idempotent. */
export async function declineOffer(customerUserId: string, offerId: string): Promise<OfferDto> {
  const requestId = await customerOfferRequestId(customerUserId, offerId);

  try {
    await getDb().transaction(async (tx) => {
      const { requestStatus, offer } = await lockRequestThenOffer(tx, requestId, offerId);

      if (offer.status === 'declined') return;
      await rejectIfSuperseded(tx, offerId, offer);
      if (offer.status === 'accepted' || offer.status === 'withdrawn') throw offerAlreadyDecidedError(offer.status);
      if (!(await isLiveNow(tx, offerId))) throw offerExpiredError();
      if (requestStatus !== 'offers_open') {
        throw requestNotActionableError(`This request is no longer open for responses (status: ${requestStatus}).`);
      }

      await tx.execute(sql`
        UPDATE offers SET status = 'declined', decided_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1
         WHERE id = ${offerId}
      `);
      await recordOfferTransition(tx, offerId, offer.status, 'declined', customerUserId);
    });
  } catch (err) {
    logSupersededRejection('decline', offerId, err);
    throw err;
  }

  return loadOfferDto(offerId);
}

/** `POST /api/v1/offers/{id}/withdraw` — the offer's own provider; locks the offer only (never the request). */
export async function withdrawOffer(providerUserId: string, providerProfileId: string, offerId: string): Promise<OfferDto> {
  if (!isUuid(offerId)) throw offerNotFoundError();

  try {
    await getDb().transaction(async (tx) => {
      const [offer] = await queryRows<LockedOffer>(
        tx,
        sql`SELECT status, accept_idempotency_key FROM offers
             WHERE id = ${offerId} AND provider_profile_id = ${providerProfileId} AND status <> 'draft' FOR UPDATE`,
      );
      if (!offer) throw offerNotFoundError();

      if (offer.status === 'withdrawn') return;
      await rejectIfSuperseded(tx, offerId, offer);
      if (offer.status === 'accepted' || offer.status === 'declined') throw offerAlreadyDecidedError(offer.status);
      if (!(await isLiveNow(tx, offerId))) throw offerExpiredError();

      await tx.execute(sql`
        UPDATE offers SET status = 'withdrawn', decided_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1
         WHERE id = ${offerId}
      `);
      await recordOfferTransition(tx, offerId, offer.status, 'withdrawn', providerUserId);
    });
  } catch (err) {
    logSupersededRejection('withdraw', offerId, err);
    throw err;
  }

  return loadOfferDto(offerId);
}
