import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPool } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { acceptOffer, declineOffer } from '@/lib/offers/decide';
import { declineRequest } from '@/lib/matching/provider-requests';
import { createChangeRequest } from './change-requests';
import { listCustomerThreadMessages, listCustomerThreads, listProviderThreadMessages, sendCustomerMessage, sendProviderMessage } from './messages';
import { THREAD_MESSAGE_LIMIT } from './limits';
import {
  isDatabaseReachable,
  messageRows,
  registerProvider,
  seedAgedMessage,
  seedOfferScenario,
  sendOffer,
  seedOffersFromEachProvider,
} from './negotiation-test-support';

const dbReachable = await isDatabaseReachable();
const PAGE = { limit: 50, offset: 0 };

/** Spec 019 AC-1, AC-7, AC-8 — pre-selection threads: one per (request, provider). */
describe.skipIf(!dbReachable)('negotiation messages (spec 019 AC-1/AC-7/AC-8, integration)', { timeout: 60_000 }, () => {
  afterAll(async () => {
    await getPool().end();
  });

  beforeEach(() => {
    resetRateLimitState();
  });

  it('stores a message against the (request, provider) thread only', async () => {
    const { customer, providers, requestId } = await seedOffersFromEachProvider(2);
    const [first, second] = providers;

    const { message } = await sendCustomerMessage(customer.userId, requestId, first!.providerProfileId, randomUUID(), {
      body: 'Is the AC on the second floor?',
    });
    expect(message).toMatchObject({
      requestId,
      providerProfileId: first!.providerProfileId,
      kind: 'message',
      senderRole: 'customer',
      body: 'Is the AC on the second floor?',
      contactRedacted: false,
      offerId: null,
      proposedPrice: null,
    });

    expect(await messageRows(requestId, first!.providerProfileId)).toHaveLength(1);
    expect(await messageRows(requestId, second!.providerProfileId)).toHaveLength(0);

    // The DTO never carries the sender's identity.
    expect(JSON.stringify(message)).not.toContain(customer.userId);
    expect(Object.keys(message)).not.toContain('senderUserId');
  });

  it('a provider distributed into the request can ask before sending an offer', async () => {
    const { customer, providers, requestId } = await seedOfferScenario();
    const provider = providers[0]!;

    const { message } = await sendProviderMessage(provider.userId, provider.providerProfileId, requestId, randomUUID(), {
      body: 'Which floor is the unit on?',
    });
    expect(message.senderRole).toBe('provider');

    // The customer can now see and answer that thread even though no offer exists yet.
    const thread = await listCustomerThreadMessages(customer.userId, requestId, provider.providerProfileId, PAGE);
    expect(thread.data.map((m) => m.body)).toEqual(['Which floor is the unit on?']);
    await sendCustomerMessage(customer.userId, requestId, provider.providerProfileId, randomUUID(), { body: 'Second floor.' });
    expect(await messageRows(requestId, provider.providerProfileId)).toHaveLength(2);
  });

  it('another provider and another customer cannot read or post (404/403)', async () => {
    const { customer, providers, requestId } = await seedOffersFromEachProvider(1);
    const outsiderProvider = await registerProvider();
    const outsiderScenario = await seedOfferScenario();

    await expect(
      sendProviderMessage(outsiderProvider.userId, outsiderProvider.providerProfileId, requestId, randomUUID(), { body: 'hi' }),
    ).rejects.toMatchObject({ code: 'NOT_DISTRIBUTED_TO_PROVIDER', status: 403 });
    await expect(listProviderThreadMessages(outsiderProvider.providerProfileId, requestId, PAGE)).rejects.toMatchObject({
      code: 'NOT_DISTRIBUTED_TO_PROVIDER',
    });

    // A different customer sees the request as non-existent, not as forbidden.
    await expect(
      sendCustomerMessage(outsiderScenario.customer.userId, requestId, providers[0]!.providerProfileId, randomUUID(), { body: 'hi' }),
    ).rejects.toMatchObject({ code: 'REQUEST_NOT_FOUND', status: 404 });

    // The owning customer has no thread with an undistributed provider.
    await expect(
      sendCustomerMessage(customer.userId, requestId, outsiderProvider.providerProfileId, randomUUID(), { body: 'hi' }),
    ).rejects.toMatchObject({ code: 'THREAD_NOT_FOUND', status: 404 });
    await expect(listCustomerThreadMessages(customer.userId, requestId, 'not-a-uuid', PAGE)).rejects.toMatchObject({
      code: 'THREAD_NOT_FOUND',
    });
  });

  it(`rejects the ${THREAD_MESSAGE_LIMIT + 1}th message in 10 minutes with 429 and a database Retry-After, writing nothing`, async () => {
    const { customer, providers, requestId } = await seedOffersFromEachProvider(1);
    const providerProfileId = providers[0]!.providerProfileId;

    for (let i = 0; i < THREAD_MESSAGE_LIMIT; i += 1) {
      await sendCustomerMessage(customer.userId, requestId, providerProfileId, randomUUID(), { body: `Question ${i}` });
    }

    await expect(
      sendCustomerMessage(customer.userId, requestId, providerProfileId, randomUUID(), { body: 'One too many' }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429, retryAfterSeconds: expect.any(Number) });

    const rows = await messageRows(requestId, providerProfileId);
    expect(rows).toHaveLength(THREAD_MESSAGE_LIMIT);
    expect(rows.some((row) => row.body === 'One too many')).toBe(false);

    // The limit is per sender per thread: the provider is unaffected.
    await expect(
      sendProviderMessage(providers[0]!.userId, providerProfileId, requestId, randomUUID(), { body: 'Provider reply' }),
    ).resolves.toBeDefined();
  });

  it('the limit is a rolling window: messages older than 10 minutes no longer count', async () => {
    const { customer, providers, requestId } = await seedOffersFromEachProvider(1);
    const providerProfileId = providers[0]!.providerProfileId;

    for (let i = 0; i < THREAD_MESSAGE_LIMIT; i += 1) {
      await seedAgedMessage({
        requestId,
        providerProfileId,
        senderUserId: customer.userId,
        senderRole: 'customer',
        msAgo: 11 * 60_000,
      });
    }

    await expect(
      sendCustomerMessage(customer.userId, requestId, providerProfileId, randomUUID(), { body: 'Still allowed' }),
    ).resolves.toBeDefined();
  });

  it('change requests count toward the thread limit', async () => {
    const { customer, providers, requestId, offerIds } = await seedOffersFromEachProvider(1);
    const providerProfileId = providers[0]!.providerProfileId;

    for (let i = 0; i < THREAD_MESSAGE_LIMIT - 1; i += 1) {
      await sendCustomerMessage(customer.userId, requestId, providerProfileId, randomUUID(), { body: `Question ${i}` });
    }
    await createChangeRequest(customer.userId, offerIds[0]!, randomUUID(), { note: 'Cheaper please' });

    await expect(
      sendCustomerMessage(customer.userId, requestId, providerProfileId, randomUUID(), { body: 'One too many' }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('same Idempotency-Key and body replays one row; a different body conflicts', async () => {
    const { customer, providers, requestId } = await seedOffersFromEachProvider(1);
    const providerProfileId = providers[0]!.providerProfileId;
    const key = randomUUID();

    const first = await sendCustomerMessage(customer.userId, requestId, providerProfileId, key, { body: 'Same body' });
    const replay = await sendCustomerMessage(customer.userId, requestId, providerProfileId, key, { body: 'Same body' });
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.message.id).toBe(first.message.id);
    expect(await messageRows(requestId, providerProfileId)).toHaveLength(1);

    await expect(
      sendCustomerMessage(customer.userId, requestId, providerProfileId, key, { body: 'Different body' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT', status: 409 });
  });

  it('stores only the redacted body with contactRedacted true and still delivers it, and never logs the unredacted input', async () => {
    const { customer, providers, requestId } = await seedOffersFromEachProvider(1);
    const providerProfileId = providers[0]!.providerProfileId;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { message } = await sendCustomerMessage(customer.userId, requestId, providerProfileId, randomUUID(), {
      body: 'Call me on 0300-1234567 or ali@example.com — budget is Rs. 3,500',
    });

    expect(message.contactRedacted).toBe(true);
    expect(message.body).not.toContain('0300-1234567');
    expect(message.body).not.toContain('ali@example.com');
    expect(message.body).toContain('[contact removed]');
    // Legitimate service information survives.
    expect(message.body).toContain('Rs. 3,500');

    const [stored] = await messageRows(requestId, providerProfileId);
    expect(stored!.body).toBe(message.body);
    expect(stored!.contact_redacted).toBe(true);

    const logged = logSpy.mock.calls.flat().map(String).join(' ');
    expect(logged).not.toContain('0300-1234567');
    expect(logged).not.toContain('ali@example.com');
    expect(logged).toContain('negotiation.contact_redacted');
    logSpy.mockRestore();
  });

  it('422 THREAD_CLOSED once the request is provider_selected, and the thread stays readable by both parties', async () => {
    const { customer, providers, requestId, offerIds } = await seedOffersFromEachProvider(1);
    const provider = providers[0]!;
    await sendCustomerMessage(customer.userId, requestId, provider.providerProfileId, randomUUID(), { body: 'Before selection' });

    await acceptOffer(customer.userId, offerIds[0]!, randomUUID());

    await expect(
      sendCustomerMessage(customer.userId, requestId, provider.providerProfileId, randomUUID(), { body: 'After selection' }),
    ).rejects.toMatchObject({ code: 'THREAD_CLOSED', status: 422 });
    await expect(
      sendProviderMessage(provider.userId, provider.providerProfileId, requestId, randomUUID(), { body: 'After selection' }),
    ).rejects.toMatchObject({ code: 'THREAD_CLOSED' });

    const asCustomer = await listCustomerThreadMessages(customer.userId, requestId, provider.providerProfileId, PAGE);
    const asProvider = await listProviderThreadMessages(provider.providerProfileId, requestId, PAGE);
    expect(asCustomer.data.map((m) => m.body)).toEqual(['Before selection']);
    expect(asProvider.data.map((m) => m.body)).toEqual(['Before selection']);
  });

  it('422 THREAD_CLOSED after the provider declined the request', async () => {
    const { customer, providers, requestId } = await seedOfferScenario();
    const provider = providers[0]!;
    await sendProviderMessage(provider.userId, provider.providerProfileId, requestId, randomUUID(), { body: 'A question' });

    await declineRequest(provider.providerProfileId, requestId);

    await expect(
      sendProviderMessage(provider.userId, provider.providerProfileId, requestId, randomUUID(), { body: 'Another' }),
    ).rejects.toMatchObject({ code: 'THREAD_CLOSED' });
    await expect(
      sendCustomerMessage(customer.userId, requestId, provider.providerProfileId, randomUUID(), { body: 'Hello?' }),
    ).rejects.toMatchObject({ code: 'THREAD_CLOSED' });
  });

  it("422 THREAD_CLOSED after the customer declined that provider's offer", async () => {
    const { customer, providers, requestId, offerIds } = await seedOffersFromEachProvider(2);
    await declineOffer(customer.userId, offerIds[0]!);

    await expect(
      sendCustomerMessage(customer.userId, requestId, providers[0]!.providerProfileId, randomUUID(), { body: 'Still there?' }),
    ).rejects.toMatchObject({ code: 'THREAD_CLOSED' });

    // The other provider's thread is unaffected.
    await expect(
      sendCustomerMessage(customer.userId, requestId, providers[1]!.providerProfileId, randomUUID(), { body: 'Question' }),
    ).resolves.toBeDefined();
  });

  it('lists the customer threads with head offer, counts and canSend, newest activity first', async () => {
    const { customer, providers, requestId, offerIds } = await seedOffersFromEachProvider(2);
    await sendCustomerMessage(customer.userId, requestId, providers[1]!.providerProfileId, randomUUID(), { body: 'Hi' });

    const threads = await listCustomerThreads(customer.userId, requestId, PAGE);
    expect(threads.page.total).toBe(2);
    expect(threads.data).toHaveLength(2);
    // The thread with the most recent activity comes first.
    expect(threads.data[0]!.providerProfileId).toBe(providers[1]!.providerProfileId);
    expect(threads.data[0]!.messageCount).toBe(1);
    expect(threads.data[0]!.lastMessageAt).not.toBeNull();
    expect(threads.data[0]!.canSend).toBe(true);
    expect(threads.data.map((t) => t.headOffer?.offerId).sort()).toEqual([...offerIds].sort());

    await declineOffer(customer.userId, offerIds[1]!);
    const afterDecline = await listCustomerThreads(customer.userId, requestId, PAGE);
    expect(afterDecline.data.find((t) => t.providerProfileId === providers[1]!.providerProfileId)!.canSend).toBe(false);
  });

  it('rejects an invalid body before touching the database', async () => {
    const { customer, providers, requestId } = await seedOffersFromEachProvider(1);
    await expect(
      sendCustomerMessage(customer.userId, requestId, providers[0]!.providerProfileId, randomUUID(), { body: '   ' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
    expect(await messageRows(requestId, providers[0]!.providerProfileId)).toHaveLength(0);
  });
});
