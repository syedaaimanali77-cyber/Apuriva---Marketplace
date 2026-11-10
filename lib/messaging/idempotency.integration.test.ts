import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import {
  freshKey,
  isDatabaseReachable,
  json,
  resetMessagingIntegration,
  seedConfirmedBooking,
  sendMessage,
  storedMessages,
  useMessagingIntegration,
} from './messaging-test-support';

/** Spec 025 AC-8 — duplicate and concurrent sends. */
const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('send idempotency (spec 025 AC-8)', { timeout: 90_000 }, () => {
  beforeEach(() => useMessagingIntegration());
  afterEach(() => resetMessagingIntegration());
  afterAll(async () => {
    await getPool().end();
  });

  it('replay returns 200 with the original; changed body is 409', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    const key = freshKey();

    const first = await sendMessage(scenario.customer, bookingId, { body: 'See you at 10' }, key);
    expect(first.status).toBe(201);
    const original = (await json(first)).data;

    const replay = await sendMessage(scenario.customer, bookingId, { body: 'See you at 10' }, key);
    expect(replay.status).toBe(200);
    expect((await json(replay)).data).toEqual(original);

    const conflict = await sendMessage(scenario.customer, bookingId, { body: 'See you at 11' }, key);
    expect(conflict.status).toBe(409);
    expect((await json(conflict)).code).toBe('IDEMPOTENCY_KEY_CONFLICT');

    expect(await storedMessages(bookingId)).toHaveLength(1);
  });

  it('the same key submitted concurrently produces exactly one message', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    const key = freshKey();

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => sendMessage(scenario.customer, bookingId, { body: 'Double tap' }, key)),
    );
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(4);

    const bodies = await Promise.all(responses.map(async (r) => (await json(r)).data.id));
    expect(new Set(bodies).size).toBe(1);
    expect(await storedMessages(bookingId)).toHaveLength(1);
  });

  it('keys are scoped per sender, and different keys sent concurrently all succeed in one total order', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    const shared = freshKey();

    const [customer, provider] = await Promise.all([
      sendMessage(scenario.customer, bookingId, { body: 'Same key, customer' }, shared),
      sendMessage(scenario.provider, bookingId, { body: 'Same key, provider' }, shared),
    ]);
    expect([customer.status, provider.status]).toEqual([201, 201]);

    await Promise.all(Array.from({ length: 4 }, (_, i) => sendMessage(scenario.customer, bookingId, { body: `burst ${i}` })));
    const stored = await storedMessages(bookingId);
    expect(stored).toHaveLength(6);
    const stamps = stored.map((m) => new Date(m.created_at).getTime());
    for (let i = 1; i < stamps.length; i += 1) expect(stamps[i]).toBeGreaterThan(stamps[i - 1]!);
  });

  it('requires an Idempotency-Key', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    const response = await sendMessage(scenario.customer, bookingId, { body: 'no key' }, null);
    expect(response.status).toBe(400);
    expect((await json(response)).errors).toEqual([expect.objectContaining({ field: 'Idempotency-Key' })]);
  });
});
