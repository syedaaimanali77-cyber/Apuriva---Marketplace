/**
 * Spec 019 §3 "Change request — rules in evaluation order" (AC-3). A change request is a thread row on a
 * specific offer; it NEVER updates the offer (price, status, `expires_at` and `version` are untouched) and
 * never pauses, extends or resets any timer.
 *
 * Lock order: request → match (thread) → offer, all `FOR UPDATE` — the same order as revisions and
 * spec 018 creation, a superset of accept's request → offer.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import { isUniqueViolation, queryRows } from '@/lib/offers/db';
import { currentOfferIdFor } from '@/lib/offers/lineage';
import { isUuid } from '@/lib/offers/validation';
import type { OfferMessageDto } from '@/lib/types/negotiation';
import {
  changeAlreadyRequestedError,
  idempotencyKeyConflictError,
  offerAlreadyDecidedError,
  offerNotFoundError,
  offerSupersededError,
  requestAlreadyClaimedError,
  requestNotActionableError,
  threadClosedError,
} from './errors';
import { logContactRedaction } from './redaction-log';
import { assertWithinThreadLimit, findMessageByIdempotencyKey, insertThreadRow, isThreadClosed, loadMessageDto, prepareStoredText } from './threads';
import { validateChangeRequestBody } from './validation';

/** `POST /api/v1/offers/{id}/change-requests` — the request's customer only. */
export async function createChangeRequest(
  customerUserId: string,
  offerId: string,
  idempotencyKey: string,
  body: unknown,
): Promise<{ message: OfferMessageDto; replayed: boolean }> {
  if (!isUuid(offerId)) throw offerNotFoundError();

  // Step 1 — idempotency.
  const fingerprint = idempotencyFingerprint({ offerId, body });
  const early = await findMessageByIdempotencyKey(getDb(), customerUserId, idempotencyKey, fingerprint);
  if (early?.kind === 'conflict') throw idempotencyKeyConflictError();
  if (early?.kind === 'replay') return { message: await loadMessageDto(getDb(), early.messageId), replayed: true };

  // Step 2 — validation.
  const input = validateChangeRequestBody(body);

  // Step 3 — ownership (404 for a non-owner, indistinguishable from a missing offer).
  const [owned] = await queryRows<{ request_id: string; provider_profile_id: string }>(
    getDb(),
    sql`SELECT o.request_id, o.provider_profile_id FROM offers o
          JOIN requests r ON r.id = o.request_id
          JOIN customer_profiles cp ON cp.id = r.customer_profile_id
         WHERE o.id = ${offerId} AND cp.user_id = ${customerUserId} AND o.status <> 'draft'`,
  );
  if (!owned) throw offerNotFoundError();
  const requestId = owned.request_id;
  const providerProfileId = owned.provider_profile_id;

  const stored = prepareStoredText(input.note);
  let outcome: { messageId: string; replayed: boolean };
  try {
    outcome = await getDb().transaction(async (tx) => {
      // Step 4 — locks.
      const [request] = await queryRows<{ status: string }>(tx, sql`SELECT status FROM requests WHERE id = ${requestId} FOR UPDATE`);
      const [match] = await queryRows<{ provider_response: string }>(
        tx,
        sql`SELECT provider_response FROM request_provider_matches
             WHERE request_id = ${requestId} AND provider_profile_id = ${providerProfileId} FOR UPDATE`,
      );
      const [offer] = await queryRows<{ status: string; price_currency_code: string }>(
        tx,
        sql`SELECT status, price_currency_code FROM offers WHERE id = ${offerId} FOR UPDATE`,
      );
      if (!request || !offer) throw offerNotFoundError();

      const locked = await findMessageByIdempotencyKey(tx, customerUserId, idempotencyKey, fingerprint);
      if (locked?.kind === 'conflict') throw idempotencyKeyConflictError();
      if (locked?.kind === 'replay') return { messageId: locked.messageId, replayed: true };

      // Step 5 — request status.
      if (request.status === 'provider_selected' || request.status === 'booking_created') throw requestAlreadyClaimedError();
      if (request.status !== 'offers_open') {
        throw requestNotActionableError(`This request is no longer open for offers (status: ${request.status}).`);
      }

      // Step 6 — AC-8 closure.
      const [declined] = await queryRows<{ id: string }>(
        tx,
        sql`SELECT id FROM offers WHERE request_id = ${requestId} AND provider_profile_id = ${providerProfileId} AND status = 'declined' LIMIT 1`,
      );
      if (
        isThreadClosed({ requestStatus: request.status, providerResponse: match?.provider_response ?? null, hasDeclinedOffer: Boolean(declined) })
      ) {
        throw threadClosedError();
      }

      // Step 7 — offer state: decided, or superseded/not the head. Effective `expired` is allowed.
      if (offer.status === 'accepted' || offer.status === 'declined' || offer.status === 'withdrawn') {
        throw offerAlreadyDecidedError(offer.status);
      }
      const headId = await currentOfferIdFor(tx, offerId);
      if (offer.status === 'revised' || headId !== offerId) throw offerSupersededError(headId);

      // Step 8 — one change request per offer row.
      const [existing] = await queryRows<{ id: string }>(
        tx,
        sql`SELECT id FROM offer_messages WHERE offer_id = ${offerId} AND kind = 'change_request' LIMIT 1`,
      );
      if (existing) throw changeAlreadyRequestedError();

      // Step 9 — AC-1 anti-spam (a change request counts as a message).
      await assertWithinThreadLimit(tx, customerUserId, requestId, providerProfileId);

      // Step 10 — insert; the offer row is NOT updated.
      const messageId = await insertThreadRow(tx, {
        requestId,
        providerProfileId,
        offerId,
        senderUserId: customerUserId,
        senderRole: 'customer',
        kind: 'change_request',
        body: stored.text,
        contactRedacted: stored.redacted,
        proposedPrice:
          input.proposedPriceAmountMinorUnits === null
            ? null
            : { amountMinorUnits: input.proposedPriceAmountMinorUnits, currencyCode: offer.price_currency_code },
        idempotencyKey,
        fingerprint,
      });
      return { messageId, replayed: false };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'offer_messages_change_request_per_offer_uq')) throw changeAlreadyRequestedError();
    if (isUniqueViolation(err, 'offer_messages_sender_idempotency_key_uq')) {
      const hit = await findMessageByIdempotencyKey(getDb(), customerUserId, idempotencyKey, fingerprint);
      if (hit?.kind === 'replay') return { message: await loadMessageDto(getDb(), hit.messageId), replayed: true };
      throw idempotencyKeyConflictError();
    }
    throw err;
  }

  if (!outcome.replayed && stored.redacted) await logContactRedaction(customerUserId, requestId, 'note');
  return { message: await loadMessageDto(getDb(), outcome.messageId), replayed: outcome.replayed };
}
