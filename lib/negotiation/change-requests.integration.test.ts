import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { acceptOffer, declineOffer, withdrawOffer } from '@/lib/offers/decide';
import { createChangeRequest } from './change-requests';
import { reviseOffer } from './revise';
import {
  EXPIRED_MS_AGO,
  fullOfferRow,
  isDatabaseReachable,
  messageRows,
  reviseBody,
  seedOfferScenario,
  seedOffersFromEachProvider,
  shiftOfferWindow,
} from './negotiation-test-support';

const dbReachable = await isDatabaseReachable();

/**
 * Spec 019 AC-3 — a change request is a thread row on a specific offer. It never alters the offer, and
 * never pauses, extends or resets its 2-minute window.
 */
describe.skipIf(!dbReachable)('offer change requests (spec 019 AC-3, integration)', { timeout: 60_000 }, () => {
  afterAll(async () => {
    await getPool().end();
  });

  beforeEach(() => {
    resetRateLimitState();
  });

  it('records a change_request with note and proposed price, and leaves the offer price, status, expires_at and version unchanged', async () => {
    const { customer, providers, requestId, offerIds } = await seedOffersFromEachProvider(1);
    const offerId = offerIds[0]!;
    const before = await fullOfferRow(offerId);

    const { message } = await createChangeRequest(customer.userId, offerId, randomUUID(), {
      note: 'Can you do it on Sunday instead?',
      proposedPriceAmountMinorUnits: 250_000,
    });

    expect(message).toMatchObject({
      kind: 'change_request',
      senderRole: 'customer',
      offerId,
      requestId,
      providerProfileId: providers[0]!.providerProfileId,
      body: 'Can you do it on Sunday instead?',
      // The currency always comes from the offer, never from the client.
      proposedPrice: { amountMinorUnits: 250_000, currencyCode: 'PKR' },
    });

    const after = await fullOfferRow(offerId);
    expect(after.status).toBe(before.status);
    expect(after.price_amount_minor_units).toBe(before.price_amount_minor_units);
    expect(after.sent_at.getTime()).toBe(before.sent_at.getTime());
    expect(after.expires_at.getTime()).toBe(before.expires_at.getTime());
    expect(after.version).toBe(before.version);
  });

  it('is allowed on an expired head', async () => {
    const { customer, offerIds } = await seedOffersFromEachProvider(1);
    await shiftOfferWindow(offerIds[0]!, EXPIRED_MS_AGO);

    const { message } = await createChangeRequest(customer.userId, offerIds[0]!, randomUUID(), { note: 'Resend at a lower price?' });
    expect(message.kind).toBe('change_request');
  });

  it('409 CHANGE_ALREADY_REQUESTED on a second request for the same row', async () => {
    const { customer, requestId, offerIds } = await seedOffersFromEachProvider(1);
    await createChangeRequest(customer.userId, offerIds[0]!, randomUUID(), { note: 'First' });

    await expect(createChangeRequest(customer.userId, offerIds[0]!, randomUUID(), { note: 'Second' })).rejects.toMatchObject({
      code: 'CHANGE_ALREADY_REQUESTED',
      status: 409,
    });
    // Exactly one change request survives — the second wrote nothing.
    const rows = await messageRows(requestId);
    expect(rows.filter((row) => row.kind === 'change_request')).toHaveLength(1);
  });

  it('409 OFFER_SUPERSEDED on a non-head row', async () => {
    const { customer, providers, offerIds } = await seedOffersFromEachProvider(1);
    const provider = providers[0]!;
    const { offer: revised } = await reviseOffer(provider.userId, provider.providerProfileId, offerIds[0]!, randomUUID(), reviseBody());

    await expect(createChangeRequest(customer.userId, offerIds[0]!, randomUUID(), { note: 'On the old one' })).rejects.toMatchObject({
      code: 'OFFER_SUPERSEDED',
      status: 409,
      details: { currentOfferId: revised.id },
    });
    // The new head accepts one.
    await expect(createChangeRequest(customer.userId, revised.id, randomUUID(), { note: 'On the new one' })).resolves.toBeDefined();
  });

  it('rejects a decided offer in the documented evaluation order (request status, then closure, then offer state)', async () => {
    // Withdrawn: the request is still open and the thread is not closed, so the offer state decides.
    const withdrawn = await seedOffersFromEachProvider(1);
    await withdrawOffer(withdrawn.providers[0]!.userId, withdrawn.providers[0]!.providerProfileId, withdrawn.offerIds[0]!);
    await expect(createChangeRequest(withdrawn.customer.userId, withdrawn.offerIds[0]!, randomUUID(), { note: 'x' })).rejects.toMatchObject({
      code: 'OFFER_ALREADY_DECIDED',
      status: 409,
    });

    // Declined: AC-8 closes the thread first, so the closure answer wins.
    const declined = await seedOffersFromEachProvider(1);
    await declineOffer(declined.customer.userId, declined.offerIds[0]!);
    await expect(createChangeRequest(declined.customer.userId, declined.offerIds[0]!, randomUUID(), { note: 'x' })).rejects.toMatchObject({
      code: 'THREAD_CLOSED',
      status: 422,
    });

    // Accepted: the request has moved to provider_selected, which is checked before the offer state.
    const accepted = await seedOffersFromEachProvider(1);
    await acceptOffer(accepted.customer.userId, accepted.offerIds[0]!, randomUUID());
    await expect(createChangeRequest(accepted.customer.userId, accepted.offerIds[0]!, randomUUID(), { note: 'x' })).rejects.toMatchObject({
      code: 'REQUEST_ALREADY_CLAIMED',
      status: 409,
    });
  });

  it('404 OFFER_NOT_FOUND for another customer, a malformed id and an unknown id — ids cannot be probed', async () => {
    const { offerIds } = await seedOffersFromEachProvider(1);
    const outsider = await seedOfferScenario();

    await expect(createChangeRequest(outsider.customer.userId, offerIds[0]!, randomUUID(), { note: 'x' })).rejects.toMatchObject({
      code: 'OFFER_NOT_FOUND',
      status: 404,
    });
    await expect(createChangeRequest(outsider.customer.userId, 'not-a-uuid', randomUUID(), { note: 'x' })).rejects.toMatchObject({
      code: 'OFFER_NOT_FOUND',
    });
    await expect(createChangeRequest(outsider.customer.userId, randomUUID(), randomUUID(), { note: 'x' })).rejects.toMatchObject({
      code: 'OFFER_NOT_FOUND',
    });
  });

  it('replays with the same Idempotency-Key and body, conflicts on a different body, and validates the note', async () => {
    const { customer, offerIds } = await seedOffersFromEachProvider(1);
    const key = randomUUID();

    const first = await createChangeRequest(customer.userId, offerIds[0]!, key, { note: 'Same note' });
    const replay = await createChangeRequest(customer.userId, offerIds[0]!, key, { note: 'Same note' });
    expect(replay.replayed).toBe(true);
    expect(replay.message.id).toBe(first.message.id);

    await expect(createChangeRequest(customer.userId, offerIds[0]!, key, { note: 'Other note' })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_CONFLICT',
    });
    await expect(createChangeRequest(customer.userId, offerIds[0]!, randomUUID(), { note: '' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
    });
  });

  it('redacts contact details in the note before storage', async () => {
    const { customer, offerIds, requestId, providers } = await seedOffersFromEachProvider(1);
    const { message } = await createChangeRequest(customer.userId, offerIds[0]!, randomUUID(), {
      note: 'Call me on 03001234567 to discuss',
    });

    expect(message.contactRedacted).toBe(true);
    expect(message.body).not.toContain('03001234567');
    const [stored] = await messageRows(requestId, providers[0]!.providerProfileId);
    expect(stored!.body).not.toContain('03001234567');
  });
});
