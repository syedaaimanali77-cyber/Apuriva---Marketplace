/**
 * Account → Profile — `GET/PATCH /api/v1/users/me/profile` and `GET/PATCH /api/v1/providers/me/profile`, against
 * the isolated `*_test` database: reads, display-name set/clear, trimming, validation (control characters, the
 * 60-character boundary, unknown fields), CSRF, authentication, provider-mode authorization, `expectedVersion`
 * conflicts — and the customer's display name reaching the existing messaging and booking flows.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { aiRequest, BASE, isDatabaseReachable, json, registerAndLogin } from '@/lib/ai-assistant/ai-assistant-test-support';
import { registerProvider } from '@/app/api/v1/providers/availability-test-support';
import { seedBookingScenario } from '@/lib/bookings/bookings-test-support';
import { createBooking } from '@/lib/bookings/create';
import { createBookingBody, futureLocalSlot } from '@/lib/bookings/bookings-test-support';
import { listBookings } from '@/lib/bookings/read';
import { getDb } from '@/lib/db';
import { getConversation } from '@/lib/messaging/conversations';

const user = await import('./route');
const provider = await import('@/app/api/v1/providers/me/profile/route');

const dbReachable = await isDatabaseReachable();
const USER_URL = `${BASE}/users/me/profile`;
const PROVIDER_URL = `${BASE}/providers/me/profile`;

type Session = Awaited<ReturnType<typeof registerAndLogin>>;
const patchUser = (session: Session | null, body: unknown, csrf = true) => user.PATCH(aiRequest(USER_URL, session, { method: 'PATCH', body, csrf }));
const patchProvider = (session: Session | null, body: unknown, csrf = true) =>
  provider.PATCH(aiRequest(PROVIDER_URL, session, { method: 'PATCH', body, csrf }));

describe.skipIf(!dbReachable)('Account profile routes (integration)', () => {
  it('GET returns no display name yet, and the account email read-only with its verified state', async () => {
    const session = await registerAndLogin();
    const res = await user.GET(aiRequest(USER_URL, session));
    expect(res.status).toBe(200);
    const { data } = await json(res);
    expect(data).toMatchObject({ displayName: null, phoneNumber: null, phoneVerified: false, version: 1 });
    expect(typeof data.email).toBe('string');
    expect(typeof data.emailVerified).toBe('boolean');
  });

  it('sets the display name (trimmed, any script), then clears it, bumping the version each time', async () => {
    const session = await registerAndLogin();
    let res = await patchUser(session, { displayName: '  عائشہ خان  ', expectedVersion: 1 });
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ displayName: 'عائشہ خان', version: 2 });
    expect((await json(await user.GET(aiRequest(USER_URL, session)))).data.displayName).toBe('عائشہ خان');

    res = await patchUser(session, { displayName: 'Ayesha ki Dukaan', expectedVersion: 2 });
    expect((await json(res)).data).toMatchObject({ displayName: 'Ayesha ki Dukaan', version: 3 });

    res = await patchUser(session, { displayName: '   ', expectedVersion: 3 });
    expect((await json(res)).data).toMatchObject({ displayName: null, version: 4 });
    res = await patchUser(session, { displayName: null, expectedVersion: 4 });
    expect((await json(res)).data).toMatchObject({ displayName: null, version: 5 });
  });

  it('validates: control characters, 61 characters, missing fields, unknown fields → 400; exactly 60 is accepted', async () => {
    const session = await registerAndLogin();
    for (const body of [
      { displayName: 'Ali\nKhan', expectedVersion: 1 },
      { displayName: 'a'.repeat(61), expectedVersion: 1 },
      { displayName: 42, expectedVersion: 1 },
      { expectedVersion: 1 },
      { displayName: 'Ali' },
      { displayName: 'Ali', expectedVersion: 'one' },
      { displayName: 'Ali', expectedVersion: 1, email: 'new@example.com' },
    ]) {
      expect((await patchUser(session, body)).status, JSON.stringify(body)).toBe(400);
    }
    const res = await patchUser(session, { displayName: 'a'.repeat(60), expectedVersion: 1 });
    expect(res.status).toBe(200);
    expect((await json(res)).data.displayName).toHaveLength(60);
  });

  it('refuses a stale expectedVersion with 409 and leaves the name unchanged', async () => {
    const session = await registerAndLogin();
    expect((await patchUser(session, { displayName: 'First', expectedVersion: 1 })).status).toBe(200);
    const stale = await patchUser(session, { displayName: 'Second', expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect((await json(stale)).code).toBe('CONFLICT');
    expect((await json(await user.GET(aiRequest(USER_URL, session)))).data).toMatchObject({ displayName: 'First', version: 2 });
  });

  it('requires a session (401) and, for PATCH, the CSRF token (403)', async () => {
    const session = await registerAndLogin();
    expect((await user.GET(aiRequest(USER_URL, null))).status).toBe(401);
    expect((await patchUser(null, { displayName: 'Ali', expectedVersion: 1 })).status).toBe(401);
    expect((await patchUser(session, { displayName: 'Ali', expectedVersion: 1 }, false)).status).toBe(403);
    expect((await json(await user.GET(aiRequest(USER_URL, session)))).data.displayName).toBeNull();
  });

  it('the provider business name: provider mode only, validated, versioned and CSRF-protected', async () => {
    const owner = await registerProvider();
    const before = (await json(await provider.GET(aiRequest(PROVIDER_URL, owner)))).data;
    expect(before).toMatchObject({ businessName: null });

    const saved = await patchProvider(owner, { businessName: '  Ali Plumbing  ', expectedVersion: before.version });
    expect(saved.status).toBe(200);
    expect((await json(saved)).data).toEqual({ businessName: 'Ali Plumbing', version: before.version + 1 });
    expect((await patchProvider(owner, { businessName: 'Stale', expectedVersion: before.version })).status).toBe(409);
    expect((await patchProvider(owner, { businessName: 'b'.repeat(61), expectedVersion: before.version + 1 })).status).toBe(400);
    expect((await patchProvider(owner, { businessName: 'Ali\u0000', expectedVersion: before.version + 1 })).status).toBe(400);
    expect((await patchProvider(owner, { businessName: 'x', expectedVersion: before.version + 1 }, false)).status).toBe(403);
    expect((await provider.GET(aiRequest(PROVIDER_URL, null))).status).toBe(401);

    // Published immediately: the stored value is what search, offers, messaging and bookings read.
    const rows = (await getDb().execute(sql`SELECT business_name FROM provider_profiles WHERE user_id = ${owner.userId}`)).rows as Array<{ business_name: string }>;
    expect(rows[0]!.business_name).toBe('Ali Plumbing');
  });

  it('a customer-mode session cannot read or edit a business name (403), even its own', async () => {
    const customer = await registerAndLogin();
    expect((await provider.GET(aiRequest(PROVIDER_URL, customer))).status).toBe(403);
    expect((await patchProvider(customer, { businessName: 'Mine', expectedVersion: 1 })).status).toBe(403);
  });

  it('the customer display name reaches the existing flows: the provider’s booking list and the booking conversation', async () => {
    const scenario = await seedBookingScenario({ leadMinutes: 24 * 60 });
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId, futureLocalSlot(1)));
    expect((await patchUser(scenario.customer, { displayName: 'Ayesha', expectedVersion: 1 })).status).toBe(200);

    const providerList = await listBookings(scenario.provider.userId, 'provider', { limit: 50, offset: 0 });
    expect(providerList.data.find((b) => b.id === booking.id)?.counterpartyName).toBe('Ayesha');

    const conversation = await getConversation({ userId: scenario.provider.userId, activeMode: 'provider' }, booking.id);
    const customerParticipant = conversation.participants.find((p) => p.role === 'customer');
    expect(customerParticipant?.displayName).toBe('Ayesha');
    // Never the account's phone or email.
    expect(JSON.stringify(conversation.participants)).not.toMatch(/@|\+92/);
  });
});
