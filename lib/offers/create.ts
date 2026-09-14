/**
 * Spec 018 §3 "Offer creation — rules in evaluation order" (AC-5, AC-7, AC-9).
 *
 * `sent_at` and `expires_at` are written from ONE `clock_timestamp()` read in ONE statement, so the
 * database CHECK `expires_at = sent_at + interval '2 minutes'` always holds and no application or
 * client clock is involved. Nothing in the request body can influence either value.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import { validationError } from '@/lib/api/errors';
import { actionForPricingModel } from '@/lib/matching/actions';
import type { OfferDto } from '@/lib/types/offers';
import { isUniqueViolation, queryRows, type Executor } from './db';
import {
  actionNotAvailableForPricingModelError,
  idempotencyKeyConflictError,
  liveOfferExistsError,
  notDistributedToProviderError,
  requestNotActionableError,
} from './errors';
import { expireStaleOffersFor } from './expiry';
import { loadOfferDto } from './read';
import { OFFER_WINDOW_SQL } from './timer';
import { validateCreateOfferBody } from './validation';

type IdempotencyHit = { kind: 'replay'; offerId: string } | { kind: 'conflict' } | null;

async function findByIdempotencyKey(
  db: Executor,
  providerProfileId: string,
  idempotencyKey: string,
  fingerprint: string,
): Promise<IdempotencyHit> {
  const [row] = await queryRows<{ id: string; idempotency_fingerprint: string }>(
    db,
    sql`SELECT id, idempotency_fingerprint FROM offers
        WHERE provider_profile_id = ${providerProfileId} AND idempotency_key = ${idempotencyKey}`,
  );
  if (!row) return null;
  return row.idempotency_fingerprint === fingerprint ? { kind: 'replay', offerId: row.id } : { kind: 'conflict' };
}

export async function createOffer(
  providerUserId: string,
  providerProfileId: string,
  idempotencyKey: string,
  body: unknown,
): Promise<{ offer: OfferDto; replayed: boolean }> {
  // Rule 1 — idempotency, before any other rule, so a retry replays even if the request has moved on.
  const fingerprint = idempotencyFingerprint(body);
  const earlyHit = await findByIdempotencyKey(getDb(), providerProfileId, idempotencyKey, fingerprint);
  if (earlyHit?.kind === 'conflict') throw idempotencyKeyConflictError();
  if (earlyHit?.kind === 'replay') return { offer: await loadOfferDto(earlyHit.offerId), replayed: true };

  // Rule 2 — body validation (only whitelisted fields are ever read).
  const input = validateCreateOfferBody(body);

  let outcome: { offerId: string; replayed: boolean };
  try {
    outcome = await getDb().transaction(async (tx) => {
      // Rule 3 — serialize creation against accepts and other creations on this request.
      const [request] = await queryRows<{ status: string; service_id: string; budget_currency: string | null }>(
        tx,
        sql`SELECT status, service_id, budget_min_currency_code AS budget_currency
              FROM requests WHERE id = ${input.requestId} FOR UPDATE`,
      );
      // Unknown request id: indistinguishable from "not distributed", so ids cannot be probed.
      if (!request) throw notDistributedToProviderError();

      // A concurrent retry with the same key is decided here, under the lock.
      const lockedHit = await findByIdempotencyKey(tx, providerProfileId, idempotencyKey, fingerprint);
      if (lockedHit?.kind === 'conflict') throw idempotencyKeyConflictError();
      if (lockedHit?.kind === 'replay') return { offerId: lockedHit.offerId, replayed: true };

      // Rule 4 — distributed-to-only (spec 017 `notified_at`).
      const [match] = await queryRows<{ provider_response: string; notified_at: Date | null }>(
        tx,
        sql`SELECT provider_response, notified_at FROM request_provider_matches
             WHERE request_id = ${input.requestId} AND provider_profile_id = ${providerProfileId} FOR UPDATE`,
      );
      if (!match || !match.notified_at) throw notDistributedToProviderError();

      // Rule 5 — request status.
      if (request.status !== 'matching' && request.status !== 'offers_open') {
        throw requestNotActionableError(`This request is no longer open for offers (status: ${request.status}).`);
      }

      // Rule 6 — quote/custom only (spec 017's pricing-model mapping).
      const [service] = await queryRows<{ pricing_model: string }>(
        tx,
        sql`SELECT pricing_model FROM services WHERE id = ${request.service_id}`,
      );
      if (!service || actionForPricingModel(service.pricing_model) !== 'send_offer') {
        throw actionNotAvailableForPricingModelError(service?.pricing_model ?? 'unknown');
      }

      // Rule 7 — spec 017 response state.
      if (match.provider_response !== 'none' && match.provider_response !== 'offer_sent') {
        throw requestNotActionableError(`You have already ${match.provider_response} this request.`);
      }

      // Rule 8 — currency must match the request budget's currency (no FX in this repository).
      if (request.budget_currency && request.budget_currency !== input.currencyCode) {
        throw validationError([{ field: 'currencyCode', message: `must be ${request.budget_currency}, the request budget's currency` }]);
      }

      // Rule 9 — a customer "no" is final for this spec (re-negotiation is spec 019's).
      const [declined] = await queryRows<{ id: string }>(
        tx,
        sql`SELECT id FROM offers WHERE request_id = ${input.requestId}
              AND provider_profile_id = ${providerProfileId} AND status = 'declined' LIMIT 1`,
      );
      if (declined) throw requestNotActionableError('The customer declined your offer on this request.');

      // Rule 10 — persist `expired` on any stale, not-yet-swept offer first.
      await expireStaleOffersFor(tx, input.requestId, providerProfileId);

      // Rule 11 — at most one live offer per provider per request.
      const [live] = await queryRows<{ id: string }>(
        tx,
        sql`SELECT id FROM offers WHERE request_id = ${input.requestId} AND provider_profile_id = ${providerProfileId}
              AND status IN ('draft', 'sent', 'viewed') LIMIT 1`,
      );
      if (live) throw liveOfferExistsError();

      // Rule 12 — insert as `draft`, then `draft -> sent` exercising the trigger, one clock read.
      const [inserted] = await queryRows<{ id: string }>(
        tx,
        sql`INSERT INTO offers
              (request_id, provider_profile_id, status, price_amount_minor_units, price_currency_code,
               included_items, provider_message, estimated_duration_minutes, idempotency_key, idempotency_fingerprint)
            VALUES (${input.requestId}, ${providerProfileId}, 'draft', ${input.priceAmountMinorUnits}, ${input.currencyCode},
                    ${JSON.stringify(input.includedItems)}::jsonb, ${input.providerMessage}, ${input.estimatedDurationMinutes},
                    ${idempotencyKey}, ${fingerprint})
            RETURNING id`,
      );
      const offerId = inserted!.id;

      await tx.execute(sql`
        UPDATE offers o
           SET status = 'sent', sent_at = c.t, expires_at = c.t + ${OFFER_WINDOW_SQL}, updated_at = c.t
          FROM (SELECT clock_timestamp() AS t) c
         WHERE o.id = ${offerId}
      `);
      await tx.execute(sql`
        INSERT INTO offers_status_history (offer_id, from_status, to_status, actor_user_id)
        VALUES (${offerId}, NULL, 'draft', ${providerUserId}), (${offerId}, 'draft', 'sent', ${providerUserId})
      `);

      // Spec 017 reserved `offer_sent` for this spec.
      if (match.provider_response === 'none') {
        await tx.execute(sql`
          UPDATE request_provider_matches
             SET provider_response = 'offer_sent', responded_at = clock_timestamp(), updated_at = clock_timestamp()
           WHERE request_id = ${input.requestId} AND provider_profile_id = ${providerProfileId}
        `);
      }

      // `matching -> offers_open` on the first offer (seeded by this spec's migration).
      if (request.status === 'matching') {
        await tx.execute(sql`
          UPDATE requests SET status = 'offers_open', updated_at = clock_timestamp(), version = version + 1
           WHERE id = ${input.requestId}
        `);
        await tx.execute(sql`
          INSERT INTO requests_status_history (request_id, from_status, to_status, actor_user_id)
          VALUES (${input.requestId}, 'matching', 'offers_open', ${providerUserId})
        `);
      }

      return { offerId, replayed: false };
    });
  } catch (err) {
    // Database backstops for races the locks already prevent in practice.
    if (isUniqueViolation(err, 'offers_provider_idempotency_key_uq')) {
      const hit = await findByIdempotencyKey(getDb(), providerProfileId, idempotencyKey, fingerprint);
      if (hit?.kind === 'replay') return { offer: await loadOfferDto(hit.offerId), replayed: true };
      throw idempotencyKeyConflictError();
    }
    if (isUniqueViolation(err, 'offers_request_provider_live_uq')) throw liveOfferExistsError();
    throw err;
  }

  return { offer: await loadOfferDto(outcome.offerId), replayed: outcome.replayed };
}
