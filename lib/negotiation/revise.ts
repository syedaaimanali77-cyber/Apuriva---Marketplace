/**
 * Spec 019 §3 "Revision — rules in evaluation order" (AC-4, AC-9, AC-13).
 *
 * A revision NEVER resets, pauses or extends any timer. It creates a NEW offer row whose `sent_at` and
 * `expires_at` come from one database clock read (spec 018's shared `insertSentOffer`); a live source
 * becomes `revised`, an expired source stays `expired`; the source's window and terms are never touched
 * (and `offers_terms_immutable_trg` would reject any attempt). One `offer_revisions` row records it.
 *
 * Lock order: request → match → source offer, all `FOR UPDATE` — the order spec 018 creation uses and a
 * superset of accept's request → offer, so no deadlock is possible with any offer path.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import { validationError } from '@/lib/api/errors';
import { findOfferByIdempotencyKey, insertSentOffer, redactOfferTerms } from '@/lib/offers/create';
import { isUniqueViolation, pgError, queryRows } from '@/lib/offers/db';
import { expireStaleOffersFor } from '@/lib/offers/expiry';
import { currentOfferIdFor } from '@/lib/offers/lineage';
import { loadOfferDto } from '@/lib/offers/read';
import { isUuid, validateOfferTerms, type ValidatedOfferTerms } from '@/lib/offers/validation';
import type { OfferDto } from '@/lib/types/offers';
import {
  idempotencyKeyConflictError,
  liveOfferExistsError,
  offerAlreadyDecidedError,
  offerNotFoundError,
  offerSupersededError,
  requestAlreadyClaimedError,
  requestNotActionableError,
  revisionLimitReachedError,
  revisionUnchangedError,
} from './errors';
import { MAX_REVISIONS } from './limits';
import { logContactRedaction } from './redaction-log';

interface LockedSource {
  status: string;
  price_amount_minor_units: number;
  price_currency_code: string;
  included_items: string[];
  provider_message: string | null;
  estimated_duration_minutes: number | null;
}

/** Rule 9 — every term (after redaction) equals the source's. `includedItems` order is significant. */
export function termsUnchanged(source: LockedSource, terms: ValidatedOfferTerms): boolean {
  return (
    source.price_amount_minor_units === terms.priceAmountMinorUnits &&
    JSON.stringify(source.included_items ?? []) === JSON.stringify(terms.includedItems) &&
    (source.provider_message ?? null) === terms.providerMessage &&
    (source.estimated_duration_minutes ?? null) === terms.estimatedDurationMinutes
  );
}

function isCheckViolation(err: unknown, constraint: string): boolean {
  const pg = pgError(err);
  return pg?.code === '23514' && pg.constraint === constraint;
}

/** `POST /api/v1/offers/{id}/revisions` — the offer's own provider. Returns the NEW offer. */
export async function reviseOffer(
  providerUserId: string,
  providerProfileId: string,
  sourceOfferId: string,
  idempotencyKey: string,
  body: unknown,
): Promise<{ offer: OfferDto; replayed: boolean }> {
  if (!isUuid(sourceOfferId)) throw offerNotFoundError();

  // Rule 1 — idempotency. The fingerprint covers the source id, so a `POST /offers` key never replays here.
  const fingerprint = idempotencyFingerprint({ sourceOfferId, body });
  const early = await findOfferByIdempotencyKey(getDb(), providerProfileId, idempotencyKey, fingerprint);
  if (early?.kind === 'conflict') throw idempotencyKeyConflictError();
  if (early?.kind === 'replay') return { offer: await loadOfferDto(early.offerId), replayed: true };

  // Rule 2 — validation (spec 018 bounds), then contact redaction.
  const { terms, redactedFields } = redactOfferTerms(validateOfferTerms(body));

  // Rule 3 — the caller's own non-draft offer.
  const [owned] = await queryRows<{ request_id: string }>(
    getDb(),
    sql`SELECT request_id FROM offers WHERE id = ${sourceOfferId} AND provider_profile_id = ${providerProfileId} AND status <> 'draft'`,
  );
  if (!owned) throw offerNotFoundError();
  const requestId = owned.request_id;

  let outcome: { offerId: string; replayed: boolean; previousPrice?: number; revisionNumber?: number };
  try {
    outcome = await getDb().transaction(async (tx) => {
      // Rule 4 — locks, request → match → source.
      const [request] = await queryRows<{ status: string }>(tx, sql`SELECT status FROM requests WHERE id = ${requestId} FOR UPDATE`);
      const [match] = await queryRows<{ provider_response: string }>(
        tx,
        sql`SELECT provider_response FROM request_provider_matches
             WHERE request_id = ${requestId} AND provider_profile_id = ${providerProfileId} FOR UPDATE`,
      );
      const [source] = await queryRows<LockedSource>(
        tx,
        sql`SELECT status, price_amount_minor_units, price_currency_code, included_items, provider_message, estimated_duration_minutes
              FROM offers WHERE id = ${sourceOfferId} FOR UPDATE`,
      );
      if (!request || !source) throw offerNotFoundError();

      const locked = await findOfferByIdempotencyKey(tx, providerProfileId, idempotencyKey, fingerprint);
      if (locked?.kind === 'conflict') throw idempotencyKeyConflictError();
      if (locked?.kind === 'replay') return { offerId: locked.offerId, replayed: true };

      // Rule 5 — request status.
      if (request.status === 'provider_selected' || request.status === 'booking_created') throw requestAlreadyClaimedError();
      if (request.status !== 'offers_open') {
        throw requestNotActionableError(`This request is no longer open for offers (status: ${request.status}).`);
      }

      // Rule 6 — spec 017 response and a customer decline are final.
      if (!match || (match.provider_response !== 'none' && match.provider_response !== 'offer_sent')) {
        throw requestNotActionableError('You can no longer change your offer on this request.');
      }
      const [declined] = await queryRows<{ id: string }>(
        tx,
        sql`SELECT id FROM offers WHERE request_id = ${requestId} AND provider_profile_id = ${providerProfileId} AND status = 'declined' LIMIT 1`,
      );
      if (declined) throw requestNotActionableError('The customer declined your offer on this request.');

      // Rule 7 — decided, superseded, or not the head.
      if (source.status === 'accepted' || source.status === 'declined' || source.status === 'withdrawn') {
        throw offerAlreadyDecidedError(source.status);
      }
      const headId = await currentOfferIdFor(tx, sourceOfferId);
      if (source.status === 'revised' || headId !== sourceOfferId) throw offerSupersededError(headId);

      // Rule 8 — same currency.
      if (terms.currencyCode !== source.price_currency_code) {
        throw validationError([{ field: 'currencyCode', message: `must be ${source.price_currency_code}, the offer's currency` }]);
      }

      // Rule 9 — at least one term changes.
      if (termsUnchanged(source, terms)) throw revisionUnchangedError();

      // Rule 10 — the per-(request, provider) cap.
      const [{ n } = { n: 0 }] = await queryRows<{ n: number }>(
        tx,
        sql`SELECT count(*)::int AS n FROM offer_revisions WHERE request_id = ${requestId} AND provider_profile_id = ${providerProfileId}`,
      );
      if (n >= MAX_REVISIONS) throw revisionLimitReachedError();

      // Rule 11 — post-lock clock read: supersede a live source; a stale one is persisted `expired`.
      const [clock] = await queryRows<{ live: boolean }>(
        tx,
        sql`SELECT (status IN ('sent', 'viewed') AND clock_timestamp() < expires_at) AS live FROM offers WHERE id = ${sourceOfferId}`,
      );
      if (clock?.live) {
        await tx.execute(sql`
          UPDATE offers SET status = 'revised', updated_at = clock_timestamp(), version = version + 1 WHERE id = ${sourceOfferId}
        `);
        await tx.execute(sql`
          INSERT INTO offers_status_history (offer_id, from_status, to_status, actor_user_id)
          VALUES (${sourceOfferId}, ${source.status}, 'revised', ${providerUserId})
        `);
      } else {
        await expireStaleOffersFor(tx, requestId, providerProfileId);
      }

      // Rule 12 — the new row with its own database-computed 2-minute window.
      const newOfferId = await insertSentOffer(tx, {
        requestId,
        providerProfileId,
        providerUserId,
        terms,
        idempotencyKey,
        fingerprint,
      });

      // Rule 13 — the audit record.
      const [changeRequest] = await queryRows<{ id: string }>(
        tx,
        sql`SELECT id FROM offer_messages WHERE offer_id = ${sourceOfferId} AND kind = 'change_request' LIMIT 1`,
      );
      await tx.execute(sql`
        INSERT INTO offer_revisions
          (offer_id, new_offer_id, request_id, provider_profile_id, revision_number,
           previous_price_amount_minor_units, previous_price_currency_code, new_price_amount_minor_units, new_price_currency_code,
           actor_user_id, change_request_message_id, created_at, updated_at)
        VALUES (${sourceOfferId}, ${newOfferId}, ${requestId}, ${providerProfileId}, ${n + 1},
                ${source.price_amount_minor_units}, ${source.price_currency_code}, ${terms.priceAmountMinorUnits}, ${terms.currencyCode},
                ${providerUserId}, ${changeRequest?.id ?? null}, clock_timestamp(), clock_timestamp())
      `);

      return { offerId: newOfferId, replayed: false, previousPrice: source.price_amount_minor_units, revisionNumber: n + 1 };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'offers_provider_idempotency_key_uq')) {
      const hit = await findOfferByIdempotencyKey(getDb(), providerProfileId, idempotencyKey, fingerprint);
      if (hit?.kind === 'replay') return { offer: await loadOfferDto(hit.offerId), replayed: true };
      throw idempotencyKeyConflictError();
    }
    if (isUniqueViolation(err, 'offers_request_provider_live_uq')) throw liveOfferExistsError();
    if (isUniqueViolation(err, 'offer_revisions_offer_id_uq')) throw offerSupersededError(await currentOfferIdFor(getDb(), sourceOfferId));
    if (isUniqueViolation(err, 'offer_revisions_request_provider_number_uq') || isCheckViolation(err, 'offer_revisions_number_ck')) {
      throw revisionLimitReachedError();
    }
    throw err;
  }

  if (!outcome.replayed) {
    console.log(
      JSON.stringify({
        event: 'negotiation.revision_created',
        offerId: outcome.offerId,
        previousOfferId: sourceOfferId,
        revisionNumber: outcome.revisionNumber,
        priceDeltaSign: Math.sign(terms.priceAmountMinorUnits - (outcome.previousPrice ?? terms.priceAmountMinorUnits)),
      }),
    );
    for (const field of redactedFields) await logContactRedaction(providerUserId, requestId, field);
  }
  return { offer: await loadOfferDto(outcome.offerId), replayed: outcome.replayed };
}
