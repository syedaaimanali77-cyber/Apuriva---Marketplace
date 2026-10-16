import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { csrfCookieFrom, sessionCookieFrom } from '@/app/api/v1/auth/test-support';
import { countRows, enterDemoEnvironment, isDatabaseReachable } from '@/lib/demo/demo-test-support';
import { demoLoginRequest } from '../demo-route-test-support';
import { POST } from './route';

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('POST /api/v1/demo/login (spec 045 D1, AC-1)', () => {
  let restore: () => void;
  beforeAll(() => {
    restore = enterDemoEnvironment();
  });
  afterAll(() => restore?.());
  beforeEach(() => resetRateLimitState());

  for (const persona of ['customer', 'provider'] as const) {
    it(`provisions a fresh set and signs the visitor in as its ${persona} persona through completeLogin, with no signup`, async () => {
      const res = (await POST(demoLoginRequest({ persona }))) as NextResponse;
      expect(res.status).toBe(200);
      const { data } = (await res.json()) as { data: { userId: string; sessionId: string; mfaRequired: boolean; roles: string[] } };

      // The same cookies every login route sets.
      expect(sessionCookieFrom(res)).toBe(data.sessionId);
      expect(csrfCookieFrom(res)).toBeTruthy();
      expect(data.mfaRequired).toBe(false);

      const [user] = await queryRows<{ is_demo: boolean; demo_set_id: string | null; password_hash: string | null; has_provider: boolean; has_admin: boolean }>(
        getDb(),
        sql`SELECT u.is_demo, u.demo_set_id, u.password_hash,
                   EXISTS (SELECT 1 FROM provider_profiles pp WHERE pp.user_id = u.id) AS has_provider,
                   EXISTS (SELECT 1 FROM admin_profiles ap WHERE ap.user_id = u.id) AS has_admin
              FROM users u WHERE u.id = ${data.userId}`,
      );
      expect(user!.is_demo).toBe(true);
      expect(user!.demo_set_id).not.toBeNull();
      // No demo password exists: the visitor's only credential is the session D1 issued (§3.3).
      expect(user!.password_hash).toBeNull();
      expect(user!.has_provider).toBe(persona === 'provider');
      expect(user!.has_admin).toBe(false);

      // Spec 005's choke point recorded the login, with X-1's `demo` method.
      const [event] = await queryRows<{ metadata: { method: string; mfaPending: boolean } }>(
        getDb(),
        sql`SELECT metadata FROM security_events WHERE user_id = ${data.userId} AND event_type = 'auth.login_succeeded'`,
      );
      expect(event!.metadata).toMatchObject({ method: 'demo', mfaPending: false });

      const [session] = await queryRows<{ user_id: string; mfa_satisfied: boolean }>(
        getDb(),
        sql`SELECT user_id, mfa_satisfied FROM sessions WHERE id = ${data.sessionId}`,
      );
      expect(session).toMatchObject({ user_id: data.userId, mfa_satisfied: true });
    }, 60_000);
  }

  it('gives two visitors two independent sets', async () => {
    const [a, b] = await Promise.all([
      POST(demoLoginRequest({ persona: 'customer' }, '203.0.113.21')),
      POST(demoLoginRequest({ persona: 'customer' }, '203.0.113.22')),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const ids = await Promise.all([a, b].map(async (res) => ((await res.json()) as { data: { userId: string } }).data.userId));
    const sets = await queryRows<{ demo_set_id: string }>(getDb(), sql`SELECT demo_set_id FROM users WHERE id IN (${ids[0]}, ${ids[1]})`);
    expect(new Set(sets.map((row) => row.demo_set_id)).size).toBe(2);
  }, 60_000);

  it.each([[{ persona: 'admin' }], [{ persona: 'super_admin' }], [{}], [{ persona: 42 }]])(
    'refuses %j with 400 VALIDATION_ERROR (spec 004 AC-3) on `persona`, writing nothing — there is no admin persona (D-2)',
    async (body) => {
      const users = await countRows('users');
      const res = await POST(demoLoginRequest(body));
      expect(res.status).toBe(400);
      const json = (await res.json()) as { code: string; errors: { field: string }[] };
      expect(json.code).toBe('VALIDATION_ERROR');
      expect(json.errors.map((e) => e.field)).toEqual(['persona']);
      expect(await countRows('users')).toBe(users);
    },
  );

  it('never creates an admin account or an admin session: no demo user has an admin profile or role', async () => {
    const [row] = await queryRows<{ n: number }>(
      getDb(),
      sql`SELECT count(*)::int AS n FROM admin_profiles ap JOIN users u ON u.id = ap.user_id WHERE u.demo_set_id IS NOT NULL`,
    );
    expect(row!.n).toBe(0);
  });
});
