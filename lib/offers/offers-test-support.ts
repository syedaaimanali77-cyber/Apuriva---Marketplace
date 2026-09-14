import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { providerServices, requests, services } from '@/lib/db/schema';
import { runMatching } from '@/lib/matching/run';
import {
  allWeekAlwaysOpen,
  registerProvider,
  seedCustomerWithAddress,
  seedProviderService,
  seedSubmittedRequest,
  seedWeeklyHours,
  type ProviderFixture,
  type TestSession,
} from '@/lib/matching/matching-test-support';
import { queryRows } from './db';
import { createOffer } from './create';

export {
  authenticatedRequest,
  isDatabaseReachable,
  registerCustomer,
  registerProvider,
  sessionGet,
  sessionMutate,
  type ProviderFixture,
  type TestSession,
} from '@/lib/matching/matching-test-support';

/**
 * Spec 018 §6 fixtures. A submitted request run through spec 017's real `runMatching`, so every provider
 * here is genuinely distributed (`notified_at` set) — no match rows are faked. Catalog/address rows are
 * seeded at the DB layer, the same test-setup shortcut every other domain's test-support uses.
 *
 * Timing strategy: no sleeps and no mocked clock. `shiftOfferWindow` moves an offer's window relative to
 * the DATABASE clock in one statement (both columns from one `clock_timestamp()` read), so the
 * `expires_at = sent_at + 2 minutes` CHECK still holds and every boundary is exact.
 */
export interface OfferScenario {
  customer: TestSession & { addressId: string };
  providers: ProviderFixture[];
  requestId: string;
  serviceId: string;
}

export async function seedOfferScenario(options?: {
  providerCount?: number;
  pricingModel?: 'quote' | 'custom' | 'fixed' | 'package' | 'hourly';
}): Promise<OfferScenario> {
  const providerCount = options?.providerCount ?? 1;
  const first = await registerProvider();
  const { serviceId } = await seedProviderService(first.providerProfileId);
  await getDb().update(services).set({ pricingModel: options?.pricingModel ?? 'quote' }).where(eq(services.id, serviceId));
  await seedWeeklyHours(first.providerProfileId, allWeekAlwaysOpen());

  const providers = [first];
  for (let i = 1; i < providerCount; i += 1) {
    const extra = await registerProvider();
    await seedWeeklyHours(extra.providerProfileId, allWeekAlwaysOpen());
    await getDb().insert(providerServices).values({ providerProfileId: extra.providerProfileId, serviceId, durationMinutes: 60 });
    providers.push(extra);
  }

  const customer = await seedCustomerWithAddress();
  const request = await seedSubmittedRequest(customer.userId, serviceId, customer.addressId);
  await runMatching(request.id);
  return { customer, providers, requestId: request.id, serviceId };
}

export function offerBody(requestId: string, overrides?: Record<string, unknown>): Record<string, unknown> {
  return { requestId, priceAmountMinorUnits: 320_000, currencyCode: 'PKR', includedItems: ['Labour'], ...overrides };
}

export async function sendOffer(provider: ProviderFixture, requestId: string, overrides?: Record<string, unknown>) {
  const { offer } = await createOffer(provider.userId, provider.providerProfileId, randomUUID(), offerBody(requestId, overrides));
  return offer;
}

/** Places the offer's window so that `sent_at` was `msAgo` milliseconds before the database clock now. */
export async function shiftOfferWindow(offerId: string, msAgo: number): Promise<void> {
  await getDb().execute(sql`
    UPDATE offers o
       SET sent_at = c.t - (${msAgo} * interval '1 millisecond'),
           expires_at = c.t - (${msAgo} * interval '1 millisecond') + interval '2 minutes'
      FROM (SELECT clock_timestamp() AS t) c
     WHERE o.id = ${offerId}
  `);
}

export async function storedOffer(offerId: string) {
  const [row] = await queryRows<{
    status: string;
    sent_at: Date;
    expires_at: Date;
    decided_at: Date | null;
    accept_idempotency_key: string | null;
    window_ok: boolean;
  }>(
    getDb(),
    sql`SELECT status, sent_at, expires_at, decided_at, accept_idempotency_key,
               (expires_at - sent_at = interval '2 minutes') AS window_ok
          FROM offers WHERE id = ${offerId}`,
  );
  return row!;
}

export async function offerHistory(offerId: string) {
  return queryRows<{ from_status: string | null; to_status: string; actor_user_id: string | null }>(
    getDb(),
    sql`SELECT from_status, to_status, actor_user_id FROM offers_status_history WHERE offer_id = ${offerId} ORDER BY occurred_at, created_at`,
  );
}

export async function requestStatus(requestId: string): Promise<string> {
  const [row] = await getDb().select({ status: requests.status }).from(requests).where(eq(requests.id, requestId));
  return row!.status;
}

/** Condition-based wait on the DATABASE clock (never a fixed sleep): resolves once the DB clock has passed `instant`. */
export async function waitForDatabaseClockPast(instant: Date, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await queryRows<{ past: boolean }>(getDb(), sql`SELECT clock_timestamp() > ${instant.toISOString()}::timestamptz AS past`);
    if (row?.past) return;
    if (Date.now() > deadline) throw new Error('database clock did not pass the expected instant');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
