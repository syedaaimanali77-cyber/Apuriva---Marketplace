import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { createOffer } from '@/lib/offers/create';
import { declineOffer } from '@/lib/offers/decide';
import { OFFER_WINDOW_MS } from '@/lib/offers/timer';
import { createChangeRequest } from './change-requests';
import { reviseOffer } from './revise';
import { MAX_REVISIONS } from './limits';
import {
  EXPIRED_MS_AGO,
  fullOfferRow,
  isDatabaseReachable,
  offerBody,
  offerHistory,
  reviseBody,
  revisionRows,
  seedOfferScenario,
  seedOffersFromEachProvider,
  sendOffer,
  shiftOfferWindow,
} from './negotiation-test-support';

const dbReachable = await isDatabaseReachable();

/**
 * Spec 019 AC-4, AC-7, AC-13 — a revision is a NEW offer row with its own database-computed window. The
 * source's window is never reset, extended or otherwise touched (spec 018's invariant).
 */
describe.skipIf(!dbReachable)('offer revisions (spec 019 AC-4/AC-13, integration)', { timeout: 60_000 }, () => {
  afterAll(async () => {
    await getPool().end();
  });

  beforeEach(() => {
    resetRateLimitState();
  });

  it('creates a new row with expires_at = sent_at + 2 minutes from the database clock, and never modifies the source sent_at, expires_at or price', async () => {
    const { providers, offerIds } = await seedOffersFromEachProvider(1);
    const provider = providers[0]!;
    const sourceBefore = await fullOfferRow(offerIds[0]!);

    const { offer, replayed } = await reviseOffer(provider.userId, provider.providerProfileId, offerIds[0]!, randomUUID(), reviseBody({ priceAmountMinorUnits: 275_000 }));

    expect(replayed).toBe(false);
    expect(offer.id).not.toBe(offerIds[0]);
    expect(offer.status).toBe('sent');
    expect(offer.priceAmountMinorUnits).toBe(275_000);

    const created = await fullOfferRow(offer.id);
    expect(created.window_ok).toBe(true);
    expect(created.expires_at.getTime() - created.sent_at.getTime()).toBe(OFFER_WINDOW_MS);
    // The new window starts when the revision was made, not when the source was sent.
    expect(created.sent_at.getTime()).toBeGreaterThan(sourceBefore.sent_at.getTime());

    const sourceAfter = await fullOfferRow(offerIds[0]!);
    expect(sourceAfter.sent_at.getTime()).toBe(sourceBefore.sent_at.getTime());
    expect(sourceAfter.expires_at.getTime()).toBe(sourceBefore.expires_at.getTime());
    expect(sourceAfter.price_amount_minor_units).toBe(sourceBefore.price_amount_minor_units);
  });

  it('moves a live source to revised with a provider history row', async () => {
    const { providers, offerIds } = await seedOffersFromEachProvider(1);
    const provider = providers[0]!;
    await reviseOffer(provider.userId, provider.providerProfileId, offerIds[0]!, randomUUID(), reviseBody());

    expect((await fullOfferRow(offerIds[0]!)).status).toBe('revised');
    const history = await offerHistory(offerIds[0]!);
    expect(history.at(-1)).toMatchObject({ to_status: 'revised', actor_user_id: provider.userId });
    expect(['sent', 'viewed']).toContain(history.at(-1)!.from_status);
  });

  it('an expired source stays expired and is still linked', async () => {
    const { providers, offerIds, requestId } = await seedOffersFromEachProvider(1);
    const provider = providers[0]!;
    await shiftOfferWindow(offerIds[0]!, EXPIRED_MS_AGO);

    const { offer } = await reviseOffer(provider.userId, provider.providerProfileId, offerIds[0]!, randomUUID(), reviseBody());

    expect((await fullOfferRow(offerIds[0]!)).status).toBe('expired');
    expect((await fullOfferRow(offer.id)).status).toBe('sent');
    const [revision] = await revisionRows(requestId);
    expect(revision).toMatchObject({ offer_id: offerIds[0], new_offer_id: offer.id });
  });

  it('writes exactly one offer_revisions row with previous/new price, actor, number and time, and links the source change request', async () => {
    const { customer, providers, requestId, offerIds } = await seedOffersFromEachProvider(1);
    const provider = providers[0]!;
    const { message: changeRequest } = await createChangeRequest(customer.userId, offerIds[0]!, randomUUID(), {
      note: 'Cheaper please',
      proposedPriceAmountMinorUnits: 250_000,
    });

    const { offer } = await reviseOffer(provider.userId, provider.providerProfileId, offerIds[0]!, randomUUID(), reviseBody({ priceAmountMinorUnits: 250_000 }));

    const rows = await revisionRows(requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      offer_id: offerIds[0],
      new_offer_id: offer.id,
      request_id: requestId,
      provider_profile_id: provider.providerProfileId,
      revision_number: 1,
      previous_price_amount_minor_units: 300_000,
      previous_price_currency_code: 'PKR',
      new_price_amount_minor_units: 250_000,
      new_price_currency_code: 'PKR',
      actor_user_id: provider.userId,
      change_request_message_id: changeRequest.id,
    });
    expect(Number.isFinite(new Date(rows[0]!.created_at).getTime())).toBe(true);

    // The DTO exposes the lineage without exposing the actor.
    expect(offer.revisionNumber).toBe(1);
    expect(offer.previousOfferId).toBe(offerIds[0]);
    expect(offer.previousPriceAmountMinorUnits).toBe(300_000);
    expect(JSON.stringify(offer)).not.toContain(provider.userId);
  });

  it('the offers terms-immutability trigger rejects a price update on a non-draft row', async () => {
    const { offerIds } = await seedOffersFromEachProvider(1);
    const immutable = { cause: expect.objectContaining({ message: expect.stringMatching(/terms are immutable once sent/) }) };

    await expect(
      getDb().execute(sql`UPDATE offers SET price_amount_minor_units = 999 WHERE id = ${offerIds[0]}`),
    ).rejects.toMatchObject(immutable);
    await expect(getDb().execute(sql`UPDATE offers SET included_items = '["x"]'::jsonb WHERE id = ${offerIds[0]}`)).rejects.toMatchObject(immutable);
    await expect(
      getDb().execute(sql`UPDATE offers SET expires_at = expires_at + interval '1 minute' WHERE id = ${offerIds[0]}`),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/window is immutable once sent/) }) });
  });

  it('offer_revisions rows cannot be updated or deleted', async () => {
    const { providers, requestId, offerIds } = await seedOffersFromEachProvider(1);
    const provider = providers[0]!;
    await reviseOffer(provider.userId, provider.providerProfileId, offerIds[0]!, randomUUID(), reviseBody());
    const [revision] = await revisionRows(requestId);
    const appendOnly = { cause: expect.objectContaining({ message: expect.stringMatching(/append-only/) }) };

    await expect(
      getDb().execute(sql`UPDATE offer_revisions SET new_price_amount_minor_units = 1 WHERE id = ${revision!.id}`),
    ).rejects.toMatchObject(appendOnly);
    await expect(getDb().execute(sql`DELETE FROM offer_revisions WHERE id = ${revision!.id}`)).rejects.toMatchObject(appendOnly);
  });

  it('redacts providerMessage and includedItems on revisions', async () => {
    const { providers, offerIds } = await seedOffersFromEachProvider(1);
    const provider = providers[0]!;

    const { offer } = await reviseOffer(provider.userId, provider.providerProfileId, offerIds[0]!, randomUUID(), reviseBody({
      priceAmountMinorUnits: 275_000,
      providerMessage: 'WhatsApp me on 0300 123 4567',
      includedItems: ['Labour', 'Email ali@example.com for parts'],
    }));

    expect(offer.providerMessage).not.toContain('0300');
    expect(offer.providerMessage).toContain('[contact removed]');
    expect(offer.includedItems[1]).not.toContain('ali@example.com');
    const stored = await fullOfferRow(offer.id);
    expect(stored.provider_message).toBe(offer.providerMessage);
    expect(stored.included_items[1]).toBe(offer.includedItems[1]);
  });

  it('400 on a currency different from the source', async () => {
    const { providers, offerIds } = await seedOffersFromEachProvider(1);
    const provider = providers[0]!;
    await expect(
      reviseOffer(provider.userId, provider.providerProfileId, offerIds[0]!, randomUUID(), reviseBody({ currencyCode: 'USD' })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400, errors: [expect.objectContaining({ field: 'currencyCode' })] });
  });

  it('422 REVISION_UNCHANGED for identical terms', async () => {
    const { providers, requestId, offerIds } = await seedOffersFromEachProvider(1);
    const provider = providers[0]!;
    const source = await fullOfferRow(offerIds[0]!);

    await expect(
      reviseOffer(provider.userId, provider.providerProfileId, offerIds[0]!, randomUUID(), {
        priceAmountMinorUnits: source.price_amount_minor_units,
        currencyCode: source.price_currency_code,
        includedItems: source.included_items,
        providerMessage: source.provider_message,
        estimatedDurationMinutes: source.estimated_duration_minutes,
      }),
    ).rejects.toMatchObject({ code: 'REVISION_UNCHANGED', status: 422 });
    expect(await revisionRows(requestId)).toHaveLength(0);
  });

  it('changing only the included items (not the price) is a valid revision', async () => {
    const { providers, offerIds } = await seedOffersFromEachProvider(1);
    const provider = providers[0]!;
    const source = await fullOfferRow(offerIds[0]!);

    const { offer } = await reviseOffer(provider.userId, provider.providerProfileId, offerIds[0]!, randomUUID(), {
      priceAmountMinorUnits: source.price_amount_minor_units,
      currencyCode: source.price_currency_code,
      includedItems: ['Labour', 'Parts'],
    });
    expect(offer.priceAmountMinorUnits).toBe(source.price_amount_minor_units);
    expect(offer.includedItems).toEqual(['Labour', 'Parts']);
  });

  it(`422 REVISION_LIMIT_REACHED after ${MAX_REVISIONS} revisions on the request`, async () => {
    const { providers, requestId, offerIds } = await seedOffersFromEachProvider(1);
    const provider = providers[0]!;

    let head = offerIds[0]!;
    for (let i = 1; i <= MAX_REVISIONS; i += 1) {
      const { offer } = await reviseOffer(provider.userId, provider.providerProfileId, head, randomUUID(), reviseBody({ priceAmountMinorUnits: 300_000 - i * 1_000 }));
      head = offer.id;
    }
    expect(await revisionRows(requestId)).toHaveLength(MAX_REVISIONS);

    await expect(
      reviseOffer(provider.userId, provider.providerProfileId, head, randomUUID(), reviseBody({ priceAmountMinorUnits: 111_000 })),
    ).rejects.toMatchObject({ code: 'REVISION_LIMIT_REACHED', status: 422 });
    expect(await revisionRows(requestId)).toHaveLength(MAX_REVISIONS);
  });

  it('422 REQUEST_NOT_ACTIONABLE after a customer decline or a provider decline', async () => {
    const declined = await seedOffersFromEachProvider(1);
    await declineOffer(declined.customer.userId, declined.offerIds[0]!);
    await expect(
      reviseOffer(declined.providers[0]!.userId, declined.providers[0]!.providerProfileId, declined.offerIds[0]!, randomUUID(), reviseBody()),
    ).rejects.toMatchObject({ code: 'REQUEST_NOT_ACTIONABLE', status: 422 });

    // A provider whose spec 017 response is `declined` can no longer revise either. The response is set
    // at the DB layer (a test-setup shortcut) because spec 017's decline path is tested by spec 017.
    const scenario = await seedOfferScenario();
    const offer = await sendOffer(scenario.providers[0]!, scenario.requestId);
    await getDb().execute(
      sql`UPDATE request_provider_matches SET provider_response = 'declined', responded_at = clock_timestamp()
           WHERE request_id = ${scenario.requestId} AND provider_profile_id = ${scenario.providers[0]!.providerProfileId}`,
    );
    await expect(
      reviseOffer(scenario.providers[0]!.userId, scenario.providers[0]!.providerProfileId, offer.id, randomUUID(), reviseBody()),
    ).rejects.toMatchObject({ code: 'REQUEST_NOT_ACTIONABLE' });
  });

  it('409 OFFER_SUPERSEDED for a non-head source', async () => {
    const { providers, offerIds } = await seedOffersFromEachProvider(1);
    const provider = providers[0]!;
    const { offer: head } = await reviseOffer(provider.userId, provider.providerProfileId, offerIds[0]!, randomUUID(), reviseBody());

    await expect(
      reviseOffer(provider.userId, provider.providerProfileId, offerIds[0]!, randomUUID(), reviseBody({ priceAmountMinorUnits: 260_000 })),
    ).rejects.toMatchObject({ code: 'OFFER_SUPERSEDED', status: 409, details: { currentOfferId: head.id } });
  });

  it('404 OFFER_NOT_FOUND for another provider’s offer, a malformed id and an unknown id', async () => {
    const { offerIds } = await seedOffersFromEachProvider(1);
    const other = await seedOfferScenario();
    const outsider = other.providers[0]!;

    for (const id of [offerIds[0]!, 'not-a-uuid', randomUUID()]) {
      await expect(reviseOffer(outsider.userId, outsider.providerProfileId, id, randomUUID(), reviseBody())).rejects.toMatchObject({
        code: 'OFFER_NOT_FOUND',
        status: 404,
      });
    }
  });

  it('same key and body returns the original revision; a different body is 409; a POST /offers key reused for a revision conflicts', async () => {
    const { providers, requestId, offerIds } = await seedOffersFromEachProvider(1);
    const provider = providers[0]!;
    const key = randomUUID();

    const first = await reviseOffer(provider.userId, provider.providerProfileId, offerIds[0]!, key, reviseBody({ priceAmountMinorUnits: 280_000 }));
    const replay = await reviseOffer(provider.userId, provider.providerProfileId, offerIds[0]!, key, reviseBody({ priceAmountMinorUnits: 280_000 }));
    expect(replay.replayed).toBe(true);
    expect(replay.offer.id).toBe(first.offer.id);
    expect(await revisionRows(requestId)).toHaveLength(1);

    await expect(
      reviseOffer(provider.userId, provider.providerProfileId, offerIds[0]!, key, reviseBody({ priceAmountMinorUnits: 111_000 })),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT', status: 409 });

    // A key already used for an offer creation is not a revision replay.
    const fresh = await seedOfferScenario();
    const creationKey = randomUUID();
    const created = await createOffer(fresh.providers[0]!.userId, fresh.providers[0]!.providerProfileId, creationKey, offerBody(fresh.requestId));
    await expect(
      reviseOffer(fresh.providers[0]!.userId, fresh.providers[0]!.providerProfileId, created.offer.id, creationKey, reviseBody()),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
  });
});
