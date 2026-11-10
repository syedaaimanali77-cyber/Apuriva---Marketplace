/**
 * Spec 034 §3.10 — proactive suggestions (AC-9, AC-15): exactly `upcoming_booking` and
 * `unfinished_request`, derived at read time from REAL bookings/requests (spec 021's payment fixtures
 * and spec 018's offer fixtures), self-expiring, attributed to Ask Apuriva, navigation-only, and off
 * when the preference is off. Provider availability/update suggestions are never produced.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { createBooking } from '@/lib/bookings/create';
import { authorizePayment } from '@/lib/payments/authorize';
import { seedOfferScenario, sendOffer } from '@/lib/offers/offers-test-support';
import {
  createBookingBody,
  freshKey,
  resetPaymentIntegration,
  seedBookingScenario,
  usePaymentIntegration,
  type BookingScenario,
} from '@/lib/payments/payments-test-support';
import { aiRequest, BASE, isDatabaseReachable, json, registerAndLogin, resetAiAssistantState } from './ai-assistant-test-support';

const { GET: SUGGESTIONS } = await import('@/app/api/v1/ai/suggestions/route');
const { PATCH: PREFERENCES } = await import('@/app/api/v1/users/me/ai-preferences/route');

const dbReachable = await isDatabaseReachable();

type Session = { userId: string; sessionId: string; csrfToken: string };

/**
 * A booking built through the REAL spec 015→021 path, scheduled a day ahead (spec 020's
 * `bookings_terms_immutable_trg` forbids moving `scheduled_at` afterwards, so the lead is chosen at
 * creation). `confirm: false` leaves it `pending` — payment not yet authorized.
 */
async function seedBooking(confirm = true): Promise<{ scenario: BookingScenario; bookingId: string }> {
  const scenario = await seedBookingScenario({ leadMinutes: 24 * 60 });
  const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
  if (confirm) await authorizePayment(scenario.customer.userId, booking.id, freshKey());
  resetRateLimitState();
  return { scenario, bookingId: booking.id };
}

async function suggestionsFor(session: Session) {
  return (await json(await SUGGESTIONS(aiRequest(`${BASE}/ai/suggestions`, session)))).data as Array<Record<string, any>>;
}

/**
 * A fingerprint of everything a suggestion could conceivably touch FOR THIS USER — scoped to them,
 * because other test files write to the same tables concurrently.
 */
async function snapshot(userId: string): Promise<string> {
  const rows = await queryRows<Record<string, unknown>>(
    getDb(),
    sql`WITH cp AS (SELECT id FROM customer_profiles WHERE user_id = ${userId})
        SELECT
          (SELECT string_agg(id || ':' || status || ':' || version, ',' ORDER BY id) FROM bookings WHERE customer_profile_id IN (SELECT id FROM cp)) AS bookings,
          (SELECT string_agg(id || ':' || status || ':' || version, ',' ORDER BY id) FROM requests WHERE customer_profile_id IN (SELECT id FROM cp)) AS requests,
          (SELECT count(*)::int FROM payments WHERE booking_id IN (SELECT b.id FROM bookings b WHERE b.customer_profile_id IN (SELECT id FROM cp))) AS payments,
          (SELECT count(*)::int FROM notifications WHERE recipient_user_id = ${userId}) AS notifications,
          (SELECT count(*)::int FROM messages WHERE sender_user_id = ${userId}) AS messages,
          (SELECT count(*)::int FROM ai_conversations WHERE user_id = ${userId}) AS conversations,
          (SELECT (SELECT ai_proactive_suggestions_enabled FROM users WHERE id = ${userId})) AS preference`,
  );
  return JSON.stringify(rows[0]);
}

describe.skipIf(!dbReachable)('spec 034 proactive suggestions (integration)', () => {
  beforeAll(() => usePaymentIntegration());
  beforeEach(() => {
    resetAiAssistantState();
    resetRateLimitState();
  });
  afterAll(() => {
    resetPaymentIntegration();
    resetAiAssistantState();
  });

  it('a user with nothing upcoming or unfinished gets none', async () => {
    expect(await suggestionsFor(await registerAndLogin())).toEqual([]);
  });

  it('suggests the upcoming confirmed booking, attributed to Ask Apuriva and linking to it', async () => {
    const { scenario, bookingId } = await seedBooking();
    const [row] = await queryRows<{ status: string }>(getDb(), sql`SELECT status FROM bookings WHERE id = ${bookingId}`);
    expect(row!.status).toBe('confirmed');

    const suggestions = await suggestionsFor(scenario.customer);
    expect(suggestions).toContainEqual({
      kind: 'upcoming_booking',
      source: 'ask_apuriva',
      text: 'Ask Apuriva suggests reviewing your upcoming booking.',
      link: { type: 'booking', id: bookingId },
    });
  });

  it('a booking that is not confirmed (payment not authorized) is not suggested', async () => {
    const { scenario } = await seedBooking(false);
    expect((await suggestionsFor(scenario.customer)).filter((s) => s.kind === 'upcoming_booking')).toEqual([]);
  });

  it('suggests a request waiting on the customer in offers_open, and stops once it leaves that state', async () => {
    const scenario = await seedOfferScenario({ providerCount: 1 });
    await sendOffer(scenario.providers[0]!, scenario.requestId);
    const [request] = await queryRows<{ status: string }>(getDb(), sql`SELECT status FROM requests WHERE id = ${scenario.requestId}`);
    expect(request!.status).toBe('offers_open');

    expect(await suggestionsFor(scenario.customer)).toEqual([
      {
        kind: 'unfinished_request',
        source: 'ask_apuriva',
        text: 'Ask Apuriva suggests taking a look at your request.',
        link: { type: 'request', id: scenario.requestId },
      },
    ]);

    await getDb().execute(sql`UPDATE requests SET status = 'cancelled' WHERE id = ${scenario.requestId}`);
    expect(await suggestionsFor(scenario.customer)).toEqual([]);
  });

  it('producing suggestions changes no row — navigation only, never an action (AC-15)', async () => {
    const { scenario } = await seedBooking();
    const before = await snapshot(scenario.customer.userId);
    expect((await suggestionsFor(scenario.customer)).length).toBeGreaterThan(0);
    await suggestionsFor(scenario.customer);
    expect(await snapshot(scenario.customer.userId)).toBe(before);
  });

  it('only the two finalized kinds exist, at most one of each', async () => {
    const { scenario } = await seedBooking();
    const kinds = (await suggestionsFor(scenario.customer)).map((s) => s.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const kind of kinds) expect(['upcoming_booking', 'unfinished_request']).toContain(kind);
  });

  it('disabled preference returns none (AC-9)', async () => {
    const { scenario } = await seedBooking();
    expect((await suggestionsFor(scenario.customer)).length).toBeGreaterThan(0);

    const off = await PREFERENCES(
      aiRequest(`${BASE}/users/me/ai-preferences`, scenario.customer, { method: 'PATCH', body: { proactiveSuggestionsEnabled: false } }),
    );
    expect(off.status).toBe(200);
    expect(await suggestionsFor(scenario.customer)).toEqual([]);
  });

  it('returns none when the assistant flag is off', async () => {
    const { scenario } = await seedBooking();
    process.env.AI_CONVERSATIONAL_ASSISTANT_ENABLED = 'false';
    try {
      expect(await suggestionsFor(scenario.customer)).toEqual([]);
    } finally {
      delete process.env.AI_CONVERSATIONAL_ASSISTANT_ENABLED;
    }
  });
});
