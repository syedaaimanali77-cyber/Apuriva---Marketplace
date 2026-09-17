import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { conversationParticipants, messages, users } from '@/lib/db/schema';
import { isDatabaseReachable } from '@/lib/db/test-support';
import {
  generateExportPayload,
  getExportDownload,
  getExportStatusDto,
  requestExport,
  runExportSweep,
} from './export';
import { registerFileAssetStorage } from './file-asset-storage';
import { registerTestFileAssetStorage, seedBooking, seedUser } from './test-support';
import { runMatching } from '@/lib/matching/run';
import {
  allWeekAlwaysOpen,
  registerProvider,
  seedCustomerWithAddress,
  seedProviderService,
  seedSubmittedRequest,
  seedWeeklyHours,
} from '@/lib/matching/matching-test-support';
import { seedOfferScenario, sendOffer } from '@/lib/offers/offers-test-support';
import { createChangeRequest } from '@/lib/negotiation/change-requests';
import { sendCustomerMessage, sendProviderMessage } from '@/lib/negotiation/messages';
import { reviseOffer } from '@/lib/negotiation/revise';
import { reviseBody, seedOffersFromEachProvider } from '@/lib/negotiation/negotiation-test-support';
import { randomUUID } from 'node:crypto';

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('lib/privacy/export (spec 008 AC-3, integration)', () => {
  const pool = getPool();

  // Spec 008 depends on spec 027's FileAsset storage capability rather than implementing one —
  // this registers the test double standing in for it (lib/privacy/file-asset-storage.ts).
  beforeAll(() => {
    registerTestFileAssetStorage();
  });

  afterAll(async () => {
    registerFileAssetStorage(null);
    await pool.end();
  });

  it('requestExport is idempotent while pending/processing — returns the same id, not a new one', async () => {
    const userId = await seedUser();
    const first = await requestExport(userId);
    const second = await requestExport(userId);
    expect(second.exportRequestId).toBe(first.exportRequestId);
  });

  it('requestExport starts a new export once the previous one reached a terminal state', async () => {
    const userId = await seedUser();
    const first = await requestExport(userId);
    await getDb().update(users).set({ dataExportStatus: 'ready' }).where(eq(users.id, userId));

    const second = await requestExport(userId);
    expect(second.exportRequestId).not.toBe(first.exportRequestId);
  });

  it("GET status: another user's export id (or a nonexistent one) returns NOT_FOUND", async () => {
    const ownerId = await seedUser();
    const { exportRequestId } = await requestExport(ownerId);

    const strangerId = await seedUser();
    await expect(getExportStatusDto(strangerId, exportRequestId)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    await expect(getExportStatusDto(ownerId, 'not-a-real-id')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('downloadUrl is present only once status is ready', async () => {
    const userId = await seedUser();
    const { exportRequestId } = await requestExport(userId);

    const pending = await getExportStatusDto(userId, exportRequestId);
    expect(pending.status).toBe('pending');
    expect(pending.downloadUrl).toBeUndefined();

    await runExportSweep();

    const ready = await getExportStatusDto(userId, exportRequestId);
    expect(ready.status).toBe('ready');
    expect(ready.downloadUrl).toBeTruthy();
    expect(ready.expiresAt).toBeTruthy();
  });

  it('depends on the registered FileAsset storage capability rather than a spec-008-owned fallback — without one registered, the export fails honestly instead of faking success', async () => {
    const userId = await seedUser();
    await requestExport(userId);

    registerFileAssetStorage(null);
    try {
      const { processed } = await runExportSweep();
      expect(processed).toBe(0);

      const status = await getDb().select({ dataExportStatus: users.dataExportStatus }).from(users).where(eq(users.id, userId));
      expect(status[0]!.dataExportStatus).toBe('failed');
    } finally {
      registerTestFileAssetStorage();
    }
  });

  it('runExportSweep is idempotent/retry-safe — re-running after ready does not reprocess the account', async () => {
    const userId = await seedUser();
    await requestExport(userId);
    const first = await runExportSweep();
    expect(first.processed).toBeGreaterThanOrEqual(1);

    const second = await runExportSweep();
    expect(second.processed).toBe(0);
  });

  it('generateExportPayload includes only the caller\'s own scoped bookings, never another user\'s', async () => {
    const userId = await seedUser();
    const otherUserId = await seedUser();
    const { bookingId } = await seedBooking(userId, 'in_progress');
    const { bookingId: otherBookingId } = await seedBooking(otherUserId, 'in_progress');

    const payload = await generateExportPayload(userId);
    const bookingIds = payload.bookings.map((b) => b.id);
    expect(bookingIds).toContain(bookingId);
    expect(bookingIds).not.toContain(otherBookingId);
  });

  it("generateExportPayload's messages only include conversations the user participates in (spec 025 boundary)", async () => {
    const memberId = await seedUser();
    const outsiderId = await seedUser();

    const { rows: convoRows } = await pool.query<{ id: string }>('INSERT INTO conversations DEFAULT VALUES RETURNING id');
    const conversationId = convoRows[0]!.id;
    // Spec 025 §4 made `role`, `body`, `sender_role` and the idempotency columns NOT NULL.
    await getDb().insert(conversationParticipants).values({ conversationId, userId: memberId, role: 'customer' });
    const [message] = await getDb()
      .insert(messages)
      .values({
        conversationId,
        senderUserId: memberId,
        senderRole: 'customer',
        body: 'See you at ten.',
        idempotencyKey: randomUUID(),
        idempotencyFingerprint: 'fp',
      })
      .returning({ id: messages.id });

    const memberPayload = await generateExportPayload(memberId);
    expect(memberPayload.messages.map((m) => m.id)).toContain(message!.id);

    const outsiderPayload = await generateExportPayload(outsiderId);
    expect(outsiderPayload.messages.map((m) => m.id)).not.toContain(message!.id);
  });

  it('the export payload never carries credentials/tokens/secrets — passwordHash is not one of its keys', async () => {
    const userId = await seedUser();
    const payload = await generateExportPayload(userId);
    expect(Object.keys(payload.profile)).not.toContain('passwordHash');
    expect(JSON.stringify(payload)).not.toMatch(/passwordHash/);
  });

  it('getExportDownload rejects an invalid/missing signature', async () => {
    const userId = await seedUser();
    const { exportRequestId } = await requestExport(userId);
    await runExportSweep();

    await expect(getExportDownload(exportRequestId, null, null)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(getExportDownload(exportRequestId, String(Date.now() + 1000), 'deadbeef')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('getExportDownload rejects an expired link even with a well-formed signature shape', async () => {
    const userId = await seedUser();
    const { exportRequestId } = await requestExport(userId);
    await runExportSweep();

    const expiredMs = Date.now() - 1000;
    await expect(getExportDownload(exportRequestId, String(expiredMs), 'a'.repeat(64))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('getExportDownload succeeds for a valid, unexpired signed link and returns the JSON payload', async () => {
    const userId = await seedUser();
    const { exportRequestId } = await requestExport(userId);
    await runExportSweep();

    const status = await getExportStatusDto(userId, exportRequestId);
    const url = new URL(status.downloadUrl!, 'http://localhost');
    const download = await getExportDownload(exportRequestId, url.searchParams.get('exp'), url.searchParams.get('sig'));
    expect(download.contentType).toBe('application/json');
    const parsed = JSON.parse(download.body);
    expect(parsed.profile.id).toBe(userId);
  });

  // Spec 017 §4 "Retention and privacy" — the existence and outcome of matching, never the
  // admin-only competitive-intelligence fields.
  it("generateExportPayload includes matching on the caller's own requests (asCustomer) and own provider rows (asProvider)", async () => {
    const provider = await registerProvider();
    const { serviceId } = await seedProviderService(provider.providerProfileId);
    await seedWeeklyHours(provider.providerProfileId, allWeekAlwaysOpen());
    const customer = await seedCustomerWithAddress();
    const request = await seedSubmittedRequest(customer.userId, serviceId, customer.addressId);
    await runMatching(request.id);

    const customerPayload = await generateExportPayload(customer.userId);
    expect(customerPayload.matching.asCustomer).toHaveLength(1);
    expect(customerPayload.matching.asCustomer[0]!.requestId).toBe(request.id);
    expect(customerPayload.matching.asCustomer[0]!.providerResponse).toBe('none');
    expect(customerPayload.matching.asProvider).toHaveLength(0);

    const providerPayload = await generateExportPayload(provider.userId);
    expect(providerPayload.matching.asProvider).toHaveLength(1);
    expect(providerPayload.matching.asProvider[0]!.requestId).toBe(request.id);
    expect(providerPayload.matching.asCustomer).toHaveLength(0);
  });

  it('generateExportPayload NEVER includes scoreMicros, scoreBreakdown, or exclusionReason — those are admin-only (AC-6)', async () => {
    const provider = await registerProvider();
    const { serviceId } = await seedProviderService(provider.providerProfileId);
    await seedWeeklyHours(provider.providerProfileId, allWeekAlwaysOpen());
    const customer = await seedCustomerWithAddress();
    const request = await seedSubmittedRequest(customer.userId, serviceId, customer.addressId);
    await runMatching(request.id);

    const payload = await generateExportPayload(provider.userId);
    const matchingRow = payload.matching.asProvider[0]!;
    expect(Object.keys(matchingRow).sort()).toEqual(['notifiedAt', 'providerResponse', 'rank', 'requestId'].sort());
    expect(JSON.stringify(payload.matching)).not.toMatch(/scoreMicros|scoreBreakdown|exclusionReason/i);
  });

  // Spec 018 §4 "Retention and privacy" — offers.
  it('generateExportPayload exports offers made on the customer\'s own requests and only the provider\'s own offers, never idempotency data', async () => {
    const { customer, providers, requestId } = await seedOfferScenario({ providerCount: 2 });
    const mine = await sendOffer(providers[0]!, requestId, { providerMessage: 'Can come today.' });
    const theirs = await sendOffer(providers[1]!, requestId);

    const customerPayload = await generateExportPayload(customer.userId);
    expect(customerPayload.offers.asCustomer.map((o) => o.id).sort()).toEqual([mine.id, theirs.id].sort());
    expect(customerPayload.offers.asProvider).toEqual([]);

    const providerPayload = await generateExportPayload(providers[0]!.userId);
    expect(providerPayload.offers.asProvider.map((o) => o.id)).toEqual([mine.id]);
    expect(providerPayload.offers.asCustomer).toEqual([]);

    const exported = providerPayload.offers.asProvider[0]!;
    expect(Object.keys(exported).sort()).toEqual(
      ['currencyCode', 'decidedAt', 'estimatedDurationMinutes', 'expiresAt', 'id', 'includedItems', 'priceAmountMinorUnits', 'providerMessage', 'requestId', 'sentAt', 'status'].sort(),
    );
    expect(exported).toMatchObject({ priceAmountMinorUnits: 320_000, currencyCode: 'PKR', providerMessage: 'Can come today.' });
    expect(JSON.stringify(providerPayload.offers)).not.toMatch(/idempotency|fingerprint/i);
  });

  it('a user with no requests and no provider profile exports empty matching arrays, not an error', async () => {
    const userId = await seedUser();
    const payload = await generateExportPayload(userId);
    expect(payload.matching).toEqual({ asCustomer: [], asProvider: [] });
  });

  // Spec 019 §4 "Retention and privacy" / AC-12 — pre-selection threads and revisions.
  it('negotiation section includes own threads and revisions with no idempotency data or user ids', async () => {
    const { customer, providers, requestId, offerIds } = await seedOffersFromEachProvider(2);
    const provider = providers[0]!;
    await sendCustomerMessage(customer.userId, requestId, provider.providerProfileId, randomUUID(), { body: 'Is the AC on the second floor?' });
    await sendProviderMessage(provider.userId, provider.providerProfileId, requestId, randomUUID(), { body: 'Second floor is fine.' });
    await createChangeRequest(customer.userId, offerIds[0]!, randomUUID(), { note: 'Cheaper please', proposedPriceAmountMinorUnits: 250_000 });
    await reviseOffer(provider.userId, provider.providerProfileId, offerIds[0]!, randomUUID(), reviseBody({ priceAmountMinorUnits: 250_000 }));

    const customerPayload = await generateExportPayload(customer.userId);
    // The customer took part in the thread, so both sides' messages are theirs to export.
    expect(customerPayload.negotiation.messages).toHaveLength(3);
    expect(customerPayload.negotiation.messages.map((m) => m.senderRole).sort()).toEqual(['customer', 'customer', 'provider']);
    expect(customerPayload.negotiation.revisions).toHaveLength(1);
    expect(customerPayload.negotiation.revisions[0]).toMatchObject({
      previousOfferId: offerIds[0],
      revisionNumber: 1,
      previousPrice: { amountMinorUnits: 300_000, currencyCode: 'PKR' },
      newPrice: { amountMinorUnits: 250_000, currencyCode: 'PKR' },
    });

    const messageKeys = Object.keys(customerPayload.negotiation.messages[0]!).sort();
    expect(messageKeys).toEqual(
      ['body', 'contactRedacted', 'createdAt', 'id', 'kind', 'offerId', 'proposedPrice', 'providerProfileId', 'requestId', 'senderRole'].sort(),
    );
    expect(Object.keys(customerPayload.negotiation.revisions[0]!).sort()).toEqual(
      ['createdAt', 'id', 'newPrice', 'offerId', 'previousOfferId', 'previousPrice', 'revisionNumber'].sort(),
    );
    const serialized = JSON.stringify(customerPayload.negotiation);
    expect(serialized).not.toMatch(/idempotency|fingerprint|senderUserId|actorUserId/i);
    expect(serialized).not.toContain(customer.userId);
    expect(serialized).not.toContain(provider.userId);
  });

  it('a provider never exports another provider’s thread', async () => {
    const { customer, providers, requestId } = await seedOffersFromEachProvider(2);
    const [mine, theirs] = providers;
    await sendCustomerMessage(customer.userId, requestId, mine!.providerProfileId, randomUUID(), { body: 'To the first provider' });
    await sendCustomerMessage(customer.userId, requestId, theirs!.providerProfileId, randomUUID(), { body: 'To the second provider' });

    const providerPayload = await generateExportPayload(mine!.userId);
    expect(providerPayload.negotiation.messages.map((m) => m.body)).toEqual(['To the first provider']);
    expect(providerPayload.negotiation.messages.every((m) => m.providerProfileId === mine!.providerProfileId)).toBe(true);

    // The customer, who is a party to both threads, exports both.
    const customerPayload = await generateExportPayload(customer.userId);
    expect(customerPayload.negotiation.messages).toHaveLength(2);
  });

  it('a user with no negotiation history exports empty arrays, not an error', async () => {
    const userId = await seedUser();
    const payload = await generateExportPayload(userId);
    expect(payload.negotiation).toEqual({ messages: [], revisions: [] });
  });
});
