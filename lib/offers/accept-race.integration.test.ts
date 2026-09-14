import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { acceptOffer } from './decide';
import { queryRows } from './db';
import { isDatabaseReachable, requestStatus, seedOfferScenario, sendOffer, storedOffer } from './offers-test-support';

const dbReachable = await isDatabaseReachable();

/**
 * Spec 018 AC-6 (a)–(c). Every concurrent call runs its own `getDb().transaction()`, which checks out a
 * SEPARATE physical connection from the pg Pool — so these are real multi-connection races decided by
 * PostgreSQL row locks, not an in-process simulation. (d), accept versus the sweep, lives in
 * expiry-sweep.integration.test.ts with every other sweep-running test (suites share one test database).
 */
async function settle<T>(promises: Promise<T>[]) {
  const results = await Promise.allSettled(promises);
  const fulfilled: Awaited<T>[] = [];
  const rejected: unknown[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') fulfilled.push(result.value);
    else rejected.push(result.reason);
  }
  return { fulfilled, rejected };
}

async function acceptedCount(requestId: string): Promise<number> {
  const rows = await queryRows<{ n: number }>(
    getDb(),
    sql`SELECT count(*)::int AS n FROM offers WHERE request_id = ${requestId} AND status = 'accepted'`,
  );
  return rows[0]!.n;
}

describe.skipIf(!dbReachable)('concurrent accepts (spec 018 AC-6, integration)', () => {
  afterAll(async () => {
    await getPool().end();
  });

  beforeEach(() => {
    resetRateLimitState();
  });

  it('(a) same offer, same Idempotency-Key — both return the identical accepted offer', async () => {
    const { customer, providers, requestId } = await seedOfferScenario();
    const offer = await sendOffer(providers[0]!, requestId);
    const key = randomUUID();

    const { fulfilled, rejected } = await settle([acceptOffer(customer.userId, offer.id, key), acceptOffer(customer.userId, offer.id, key)]);
    expect(rejected).toEqual([]);
    expect(fulfilled).toHaveLength(2);
    expect(fulfilled[0]).toMatchObject({ id: offer.id, status: 'accepted' });
    expect(fulfilled[1]).toMatchObject({ id: offer.id, status: 'accepted', decidedAt: fulfilled[0]!.decidedAt });
    expect(await acceptedCount(requestId)).toBe(1);

    const history = await queryRows<{ n: number }>(
      getDb(),
      sql`SELECT count(*)::int AS n FROM offers_status_history WHERE offer_id = ${offer.id} AND to_status = 'accepted'`,
    );
    expect(history[0]!.n).toBe(1);
  });

  it('(b) same offer, different keys — exactly one 200, the other 409 OFFER_ALREADY_DECIDED', async () => {
    const { customer, providers, requestId } = await seedOfferScenario();
    const offer = await sendOffer(providers[0]!, requestId);

    const { fulfilled, rejected } = await settle([
      acceptOffer(customer.userId, offer.id, randomUUID()),
      acceptOffer(customer.userId, offer.id, randomUUID()),
    ]);
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ code: 'OFFER_ALREADY_DECIDED', status: 409 });
    expect(await acceptedCount(requestId)).toBe(1);
  });

  it('(c) two different offers on one request — exactly one accepted, the other 409 REQUEST_ALREADY_CLAIMED', async () => {
    const { customer, providers, requestId } = await seedOfferScenario({ providerCount: 3 });
    const offers = await Promise.all(providers.map((p) => sendOffer(p, requestId)));

    const { fulfilled, rejected } = await settle(offers.map((o) => acceptOffer(customer.userId, o.id, randomUUID())));
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const reason of rejected) expect(reason).toMatchObject({ code: 'REQUEST_ALREADY_CLAIMED', status: 409 });
    expect(await acceptedCount(requestId)).toBe(1);
    expect(await requestStatus(requestId)).toBe('provider_selected');
  });

  it('the partial unique index rejects a second accepted offer on a request even bypassing the lock', async () => {
    const { customer, providers, requestId } = await seedOfferScenario({ providerCount: 2 });
    const a = await sendOffer(providers[0]!, requestId);
    const b = await sendOffer(providers[1]!, requestId);
    await acceptOffer(customer.userId, a.id, randomUUID());

    await expect(
      getDb().execute(sql`
        UPDATE offers SET status = 'accepted', decided_at = clock_timestamp(), accept_idempotency_key = 'bypass'
         WHERE id = ${b.id}
      `),
    ).rejects.toThrow();
    expect((await storedOffer(b.id)).status).toBe('sent');
  });

  it('no booking row is created by any accept race', async () => {
    const { customer, providers, requestId } = await seedOfferScenario({ providerCount: 2 });
    const offers = await Promise.all(providers.map((p) => sendOffer(p, requestId)));
    await settle(offers.map((o) => acceptOffer(customer.userId, o.id, randomUUID())));
    const rows = await queryRows<{ n: number }>(
      getDb(),
      sql`SELECT count(*)::int AS n FROM bookings b JOIN offers o ON o.id = b.offer_id WHERE o.request_id = ${requestId}`,
    );
    expect(rows[0]!.n).toBe(0);
  });
});
