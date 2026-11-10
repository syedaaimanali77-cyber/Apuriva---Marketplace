import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { adminProfiles } from '@/lib/db/schema';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { GET, PATCH } from './route';
import { authenticatedRequest, authenticatedRequestWithStepUp, getStepUpToken, isDatabaseReachable, registerAndLogin } from '../privacy-test-support';

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('MFA control (spec 008 D, integration)', () => {
  beforeEach(() => {
    resetRateLimitState();
  });

  it('GET reports mfaEnabled: false for a plain (non-admin, unenrolled) account', async () => {
    const session = await registerAndLogin();
    const res = await GET(authenticatedRequest('http://localhost/api/v1/users/me/mfa', session.sessionId, session.csrfToken, { method: 'GET' }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.mfaEnabled).toBe(false);
  });

  it('PATCH requires fresh step-up — missing token returns 403 STEP_UP_REQUIRED', async () => {
    const session = await registerAndLogin();
    const res = await PATCH(
      authenticatedRequest('http://localhost/api/v1/users/me/mfa', session.sessionId, session.csrfToken, {
        method: 'PATCH',
        body: { enabled: true },
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('STEP_UP_REQUIRED');
  });

  it('PATCH rejects a stale/already-used step-up token', async () => {
    const session = await registerAndLogin();
    const stepUpToken = await getStepUpToken(session, 'toggle_mfa');

    // Consume it once.
    await PATCH(authenticatedRequestWithStepUp('http://localhost/api/v1/users/me/mfa', session, stepUpToken, { method: 'PATCH', body: { enabled: false } }));
    // Replay — already consumed.
    const res = await PATCH(authenticatedRequestWithStepUp('http://localhost/api/v1/users/me/mfa', session, stepUpToken, { method: 'PATCH', body: { enabled: false } }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('STEP_UP_REQUIRED');
  });

  it(
    'KNOWN DEPENDENCY LIMITATION (not a bug): spec 005 has no non-admin MFA enrollment yet, so ' +
      'enabling MFA for such an account is rejected with a specific error, never faked as success',
    async () => {
      const session = await registerAndLogin();
      const stepUpToken = await getStepUpToken(session, 'toggle_mfa');
      const res = await PATCH(
        authenticatedRequestWithStepUp('http://localhost/api/v1/users/me/mfa', session, stepUpToken, {
          method: 'PATCH',
          body: { enabled: true },
        }),
      );
      expect(res.status).toBe(422);
      expect((await res.json()).code).toBe('MFA_ENROLLMENT_REQUIRED');

      // Confirm no state was silently written — the account is still reported as unenrolled/off,
      // not left in some fabricated "enabled" state.
      const status = await GET(authenticatedRequest('http://localhost/api/v1/users/me/mfa', session.sessionId, session.csrfToken, { method: 'GET' }));
      expect((await status.json()).data.mfaEnabled).toBe(false);
    },
  );

  it('disabling MFA when it is already off is an idempotent no-op success', async () => {
    const session = await registerAndLogin();
    const stepUpToken = await getStepUpToken(session, 'toggle_mfa');
    const res = await PATCH(
      authenticatedRequestWithStepUp('http://localhost/api/v1/users/me/mfa', session, stepUpToken, { method: 'PATCH', body: { enabled: false } }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.mfaEnabled).toBe(false);
  });

  it('disabling MFA for an admin account (mandatory, spec 005 AC-5) is rejected', async () => {
    const session = await registerAndLogin();
    await getDb().insert(adminProfiles).values({ userId: session.userId, totpSecretEncrypted: 'ciphertext-stub' });

    const stepUpToken = await getStepUpToken(session, 'toggle_mfa');
    const res = await PATCH(
      authenticatedRequestWithStepUp('http://localhost/api/v1/users/me/mfa', session, stepUpToken, { method: 'PATCH', body: { enabled: false } }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('MFA_DISABLE_NOT_ALLOWED');

    const [admin] = await getDb().select().from(adminProfiles).where(eq(adminProfiles.userId, session.userId));
    expect(admin!.totpSecretEncrypted).toBe('ciphertext-stub');
  });

  it('GET reflects true once already enrolled (e.g. an admin account)', async () => {
    const session = await registerAndLogin();
    await getDb().insert(adminProfiles).values({ userId: session.userId, totpSecretEncrypted: 'ciphertext-stub' });

    const res = await GET(authenticatedRequest('http://localhost/api/v1/users/me/mfa', session.sessionId, session.csrfToken, { method: 'GET' }));
    expect((await res.json()).data.mfaEnabled).toBe(true);
  });

  it('rejects a non-boolean enabled field', async () => {
    const session = await registerAndLogin();
    const stepUpToken = await getStepUpToken(session, 'toggle_mfa');
    const res = await PATCH(
      authenticatedRequestWithStepUp('http://localhost/api/v1/users/me/mfa', session, stepUpToken, { method: 'PATCH', body: { enabled: 'yes' } }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
  });
});
