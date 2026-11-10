import { describe, expect, it, beforeEach } from 'vitest';
import { POST as register } from './register/route';
import { POST as stepUp } from './step-up/route';
import { verifyAndConsumeStepUpToken } from '@/lib/auth/step-up';
import { CSRF_COOKIE_NAME } from '@/lib/auth/csrf';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { authenticatedRequest, isDatabaseReachable, uniqueEmail } from './test-support';

/** Spec 005 AC-6, traceability: `step-up.integration.test.ts`. */
const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('sensitive action requires step-up (spec 005 AC-6, integration)', () => {
  beforeEach(() => {
    resetRateLimitState();
  });

  async function registerAndLogin(): Promise<{ sessionId: string; csrfToken: string }> {
    const res = await register(
      new Request('http://localhost/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email: uniqueEmail(), password: 'correct horse battery staple' }),
      }),
    );
    const { data } = await res.json();
    const csrfCookie = res.cookies.get(CSRF_COOKIE_NAME)?.value!;
    return { sessionId: data.sessionId, csrfToken: csrfCookie };
  }

  it('issues a step-up token bound to the named action for an otherwise-valid session', async () => {
    const { sessionId, csrfToken } = await registerAndLogin();

    const res = await stepUp(
      authenticatedRequest('http://localhost/api/v1/auth/step-up', sessionId, csrfToken, {
        body: { action: 'change_payout_method' },
      }),
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(typeof data.stepUpToken).toBe('string');
    expect(typeof data.expiresAt).toBe('string');

    // The token verifies for the exact (session, action) pair it was issued for ...
    expect(verifyAndConsumeStepUpToken(sessionId, 'change_payout_method', data.stepUpToken)).toBe(true);
  });

  it('a step-up token is single-use — verifying it twice fails the second time', async () => {
    const { sessionId, csrfToken } = await registerAndLogin();
    const res = await stepUp(
      authenticatedRequest('http://localhost/api/v1/auth/step-up', sessionId, csrfToken, {
        body: { action: 'change_payout_method' },
      }),
    );
    const { data } = await res.json();

    expect(verifyAndConsumeStepUpToken(sessionId, 'change_payout_method', data.stepUpToken)).toBe(true);
    expect(verifyAndConsumeStepUpToken(sessionId, 'change_payout_method', data.stepUpToken)).toBe(false);
  });

  it('a step-up token does not verify for a different action than it was issued for', async () => {
    const { sessionId, csrfToken } = await registerAndLogin();
    const res = await stepUp(
      authenticatedRequest('http://localhost/api/v1/auth/step-up', sessionId, csrfToken, {
        body: { action: 'change_payout_method' },
      }),
    );
    const { data } = await res.json();

    expect(verifyAndConsumeStepUpToken(sessionId, 'delete_account', data.stepUpToken)).toBe(false);
  });

  it('requires the action field', async () => {
    const { sessionId, csrfToken } = await registerAndLogin();
    const res = await stepUp(
      authenticatedRequest('http://localhost/api/v1/auth/step-up', sessionId, csrfToken, { body: {} }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
  });
});
