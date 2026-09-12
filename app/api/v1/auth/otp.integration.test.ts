import { describe, expect, it, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { users, securityEvents } from '@/lib/db/schema';
import { POST as requestOtp } from './otp/request/route';
import { POST as verifyOtp } from './otp/verify/route';
import { getSandboxSmsProvider } from '@/lib/auth/sms-otp-provider';
import { OTP_MAX_ATTEMPTS, resetOtpStoreState } from '@/lib/auth/otp-store';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { CSRF_COOKIE_NAME } from '@/lib/auth/csrf';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { isDatabaseReachable, uniquePhoneNumber } from './test-support';

/** Spec 005 AC-1 and AC-2, traceability: `otp.integration.test.ts`. */
const dbReachable = await isDatabaseReachable();

/** Drives the real `otp/request` route and reads the code back out of the sandbox SMS provider. */
async function requestCodeFor(phoneNumber: string): Promise<{ requestId: string; code: string }> {
  const res = await requestOtp(
    new Request('http://localhost/api/v1/auth/otp/request', {
      method: 'POST',
      body: JSON.stringify({ phoneNumber }),
    }),
  );
  expect(res.status).toBe(200);
  const { data } = await res.json();
  const code = getSandboxSmsProvider().getLastSentCode(phoneNumber);
  expect(code).toMatch(/^\d{6}$/);
  return { requestId: data.requestId, code: code! };
}

function verifyRequest(body: unknown): Request {
  return new Request('http://localhost/api/v1/auth/otp/verify', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe.skipIf(!dbReachable)('phone + OTP authentication (spec 005 AC-1/AC-2, integration)', () => {
  beforeEach(() => {
    resetRateLimitState();
    resetOtpStoreState();
    getSandboxSmsProvider().reset();
  });

  describe('AC-1: verifies and creates session', () => {
    it('creates an account and issues a session on first successful verification of a new number', async () => {
      const phoneNumber = uniquePhoneNumber();
      const { requestId, code } = await requestCodeFor(phoneNumber);

      const res = await verifyOtp(verifyRequest({ requestId, code }));
      expect(res.status).toBe(200);

      const { data } = await res.json();
      expect(data.userId).toEqual(expect.any(String));
      expect(data.sessionId).toEqual(expect.any(String));
      // A phone signup is not an admin account, so the session is immediately usable (AC-5 only
      // forces a second factor for admins).
      expect(data.mfaRequired).toBe(false);
      expect(data.roles).toContain('customer');

      // The session cookie is the httpOnly bearer; its CSRF pair is deliberately readable (§3).
      expect(res.cookies.get(SESSION_COOKIE_NAME)?.value).toBe(data.sessionId);
      expect(res.cookies.get(SESSION_COOKIE_NAME)?.httpOnly).toBe(true);
      expect(res.cookies.get(CSRF_COOKIE_NAME)?.value).toEqual(expect.any(String));
      expect(res.cookies.get(CSRF_COOKIE_NAME)?.httpOnly).toBe(false);

      const [user] = await getDb().select().from(users).where(eq(users.phoneNumber, phoneNumber));
      expect(user).toBeDefined();
      expect(user!.phoneVerifiedAt).toBeInstanceOf(Date);
      // Phone signup never sets a password — the account exists on the phone factor alone.
      expect(user!.passwordHash).toBeNull();
    });

    it('logs the existing user in on a later OTP round trip, without creating a second account', async () => {
      const phoneNumber = uniquePhoneNumber();

      const first = await requestCodeFor(phoneNumber);
      const firstRes = await verifyOtp(verifyRequest({ requestId: first.requestId, code: first.code }));
      const { data: firstData } = await firstRes.json();

      const second = await requestCodeFor(phoneNumber);
      const secondRes = await verifyOtp(verifyRequest({ requestId: second.requestId, code: second.code }));
      expect(secondRes.status).toBe(200);
      const { data: secondData } = await secondRes.json();

      // Same identity, fresh session.
      expect(secondData.userId).toBe(firstData.userId);
      expect(secondData.sessionId).not.toBe(firstData.sessionId);

      const rows = await getDb().select({ id: users.id }).from(users).where(eq(users.phoneNumber, phoneNumber));
      expect(rows).toHaveLength(1);
    });

    it('is idempotent on requestId — a consumed request cannot be replayed', async () => {
      const phoneNumber = uniquePhoneNumber();
      const { requestId, code } = await requestCodeFor(phoneNumber);

      expect((await verifyOtp(verifyRequest({ requestId, code }))).status).toBe(200);

      const replay = await verifyOtp(verifyRequest({ requestId, code }));
      expect(replay.status).toBe(409);
      expect((await replay.json()).code).toBe('OTP_ALREADY_USED');
    });

    it('rejects a malformed phone number before sending anything', async () => {
      const res = await requestOtp(
        new Request('http://localhost/api/v1/auth/otp/request', {
          method: 'POST',
          body: JSON.stringify({ phoneNumber: 'not-a-phone' }),
        }),
      );
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('VALIDATION_ERROR');
    });
  });

  describe('AC-2: rate limits after 5 failures', () => {
    it(`returns 401 for each of the first ${OTP_MAX_ATTEMPTS} wrong codes, then 429 RATE_LIMITED`, async () => {
      const phoneNumber = uniquePhoneNumber();
      const { requestId, code } = await requestCodeFor(phoneNumber);
      // Guarantee the wrong code never accidentally equals the real one.
      const wrongCode = code === '000000' ? '111111' : '000000';

      for (let attempt = 1; attempt <= OTP_MAX_ATTEMPTS; attempt += 1) {
        const res = await verifyOtp(verifyRequest({ requestId, code: wrongCode }));
        expect(res.status, `attempt ${attempt} should still be a plain auth failure`).toBe(401);
        expect((await res.json()).code).toBe('UNAUTHENTICATED');
      }

      const blocked = await verifyOtp(verifyRequest({ requestId, code: wrongCode }));
      expect(blocked.status).toBe(429);
      expect((await blocked.json()).code).toBe('RATE_LIMITED');
    });

    it('stays locked even once the correct code is supplied — the attempt budget is per request, not per code', async () => {
      const phoneNumber = uniquePhoneNumber();
      const { requestId, code } = await requestCodeFor(phoneNumber);
      const wrongCode = code === '000000' ? '111111' : '000000';

      for (let attempt = 0; attempt < OTP_MAX_ATTEMPTS; attempt += 1) {
        await verifyOtp(verifyRequest({ requestId, code: wrongCode }));
      }

      const withCorrectCode = await verifyOtp(verifyRequest({ requestId, code }));
      expect(withCorrectCode.status).toBe(429);

      // No account was created off the back of a locked-out request.
      const rows = await getDb().select({ id: users.id }).from(users).where(eq(users.phoneNumber, phoneNumber));
      expect(rows).toHaveLength(0);
    });

    it('logs a security event when the attempt budget is exhausted (AC-2, second half)', async () => {
      const phoneNumber = uniquePhoneNumber();
      const { requestId, code } = await requestCodeFor(phoneNumber);
      const wrongCode = code === '000000' ? '111111' : '000000';

      for (let attempt = 0; attempt < OTP_MAX_ATTEMPTS; attempt += 1) {
        await verifyOtp(verifyRequest({ requestId, code: wrongCode }));
      }

      const events = await getDb()
        .select()
        .from(securityEvents)
        .where(eq(securityEvents.eventType, 'auth.otp_rate_limited'));

      const forThisRequest = events.filter(
        (event) => (event.metadata as { requestId?: string } | null)?.requestId === requestId,
      );
      expect(forThisRequest.length).toBeGreaterThanOrEqual(1);
      expect(forThisRequest[0]!.severity).toBe('warning');
    });

    it('requires both requestId and code', async () => {
      const res = await verifyOtp(verifyRequest({}));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(body.errors.map((e: { field: string }) => e.field).sort()).toEqual(['code', 'requestId']);
    });
  });
});
