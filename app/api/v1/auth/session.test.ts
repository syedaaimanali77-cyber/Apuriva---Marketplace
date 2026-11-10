import { describe, expect, it, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { sessions } from '@/lib/db/schema';
import { POST as register } from './register/route';
import { POST as stepUp } from './step-up/route';
import { POST as logout } from './logout/route';
import { requireSession, requireCsrf, getOptionalSession } from '@/lib/auth/require-session';
import { deriveCsrfToken, verifyCsrfToken, CSRF_HEADER_NAME } from '@/lib/auth/csrf';
import { SESSION_COOKIE_NAME, revokeSession, validateAndRefreshSession } from '@/lib/auth/session';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { authenticatedRequest, isDatabaseReachable, uniqueEmail } from './test-support';

/** Spec 005 AC-7, traceability: `session.test.ts::server is sole authority`. */
const dbReachable = await isDatabaseReachable();

const PASSWORD = 'correct horse battery staple';

async function registerUser(): Promise<{ sessionId: string; userId: string; csrfToken: string }> {
  const res = await register(
    new Request('http://localhost/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: uniqueEmail(), password: PASSWORD }),
    }),
  );
  const { data } = await res.json();
  return { sessionId: data.sessionId, userId: data.userId, csrfToken: deriveCsrfToken(data.sessionId) };
}

/**
 * AC-7 in its purest form: these assertions need no database at all, because the guarantee is
 * that the *client* can never assert its own authentication state. A claim is only ever believed
 * after the server recomputes it.
 */
describe('server is sole authority — client-supplied claims (spec 005 AC-7)', () => {
  it('a CSRF token the client invents is never accepted, however well-formed', () => {
    const sessionId = randomUUID();
    expect(verifyCsrfToken(sessionId, 'a'.repeat(64))).toBe(false);
    expect(verifyCsrfToken(sessionId, '')).toBe(false);
    expect(verifyCsrfToken(sessionId, null)).toBe(false);
    expect(verifyCsrfToken(sessionId, undefined)).toBe(false);
    // Not even a valid token for a *different* session.
    expect(verifyCsrfToken(sessionId, deriveCsrfToken(randomUUID()))).toBe(false);
    // Only the server's own derivation passes.
    expect(verifyCsrfToken(sessionId, deriveCsrfToken(sessionId))).toBe(true);
  });

  it('the CSRF token is derived server-side from the session id, never accepted from the client', () => {
    const sessionId = randomUUID();
    // Deterministic for the server (no storage needed) but unguessable without the secret.
    expect(deriveCsrfToken(sessionId)).toBe(deriveCsrfToken(sessionId));
    expect(deriveCsrfToken(sessionId)).not.toBe(deriveCsrfToken(randomUUID()));
    expect(deriveCsrfToken(sessionId)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('requireCsrf reads the X-CSRF-Token header only — a cookie-only echo does not satisfy it', () => {
    const sessionId = randomUUID();
    const token = deriveCsrfToken(sessionId);

    const cookieOnly = new Request('http://localhost/x', {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionId}; apuriva_csrf=${token}` },
    });
    // A cross-site request can carry cookies but cannot set a custom header — that asymmetry is
    // the entire double-submit guarantee, so a cookie-only request must fail.
    expect(() => requireCsrf(cookieOnly, sessionId)).toThrow();

    const withHeader = new Request('http://localhost/x', {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionId}`, [CSRF_HEADER_NAME]: token },
    });
    expect(() => requireCsrf(withHeader, sessionId)).not.toThrow();
  });
});

describe.skipIf(!dbReachable)('server is sole authority — session state (spec 005 AC-7, integration)', () => {
  beforeEach(() => {
    resetRateLimitState();
  });

  it('no session cookie means no session, whatever the request body or headers claim', async () => {
    const forged = new Request('http://localhost/api/v1/auth/step-up', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Every one of these is a client-side assertion of identity. None may be believed.
        'x-user-id': randomUUID(),
        'x-authenticated': 'true',
        'x-roles': 'admin',
        [CSRF_HEADER_NAME]: deriveCsrfToken(randomUUID()),
      },
      body: JSON.stringify({ action: 'change_payout_method', authenticated: true, roles: ['admin'] }),
    });

    const res = await stepUp(forged);
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('UNAUTHENTICATED');
  });

  it('a well-formed but non-existent session id is rejected', async () => {
    const fabricated = randomUUID();
    const res = await stepUp(
      authenticatedRequest('http://localhost/api/v1/auth/step-up', fabricated, deriveCsrfToken(fabricated), {
        body: { action: 'change_payout_method' },
      }),
    );
    expect(res.status).toBe(401);

    const req = new Request('http://localhost/x', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fabricated}` },
    });
    await expect(requireSession(req)).rejects.toThrow();
    expect(await getOptionalSession(req)).toBeNull();
  });

  it('a revoked session stops working immediately, even though the client still holds the cookie', async () => {
    const { sessionId, csrfToken } = await registerUser();

    const before = await stepUp(
      authenticatedRequest('http://localhost/api/v1/auth/step-up', sessionId, csrfToken, {
        body: { action: 'change_payout_method' },
      }),
    );
    expect(before.status).toBe(200);

    await revokeSession(sessionId, 'test_revocation');

    const after = await stepUp(
      authenticatedRequest('http://localhost/api/v1/auth/step-up', sessionId, csrfToken, {
        body: { action: 'change_payout_method' },
      }),
    );
    expect(after.status).toBe(401);
    expect(await validateAndRefreshSession(sessionId)).toEqual({ valid: false, reason: 'revoked' });
  });

  it('an expired session is rejected on the server even if the cookie is replayed verbatim', async () => {
    const { sessionId, csrfToken } = await registerUser();

    // Age the session past both its lifetime and the sliding inactivity window, server-side.
    const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    await getDb()
      .update(sessions)
      .set({ issuedAt: longAgo, expiresAt: longAgo })
      .where(eq(sessions.id, sessionId));

    expect(await validateAndRefreshSession(sessionId)).toEqual({ valid: false, reason: 'expired' });

    const res = await stepUp(
      authenticatedRequest('http://localhost/api/v1/auth/step-up', sessionId, csrfToken, {
        body: { action: 'change_payout_method' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('logout revokes server-side — the cookie the client keeps is worthless afterwards', async () => {
    const { sessionId, csrfToken } = await registerUser();

    const res = await logout(
      authenticatedRequest('http://localhost/api/v1/auth/logout', sessionId, csrfToken),
    );
    expect(res.status).toBe(204);

    const [row] = await getDb().select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row!.revokedAt).toBeInstanceOf(Date);

    const replayed = await stepUp(
      authenticatedRequest('http://localhost/api/v1/auth/step-up', sessionId, csrfToken, {
        body: { action: 'change_payout_method' },
      }),
    );
    expect(replayed.status).toBe(401);
  });

  it('one user cannot act as another by swapping in a session id they do not own', async () => {
    const victim = await registerUser();
    const attacker = await registerUser();

    // Attacker pairs the victim's session cookie with their own (correctly derived) CSRF token.
    const res = await stepUp(
      authenticatedRequest('http://localhost/api/v1/auth/step-up', victim.sessionId, attacker.csrfToken, {
        body: { action: 'change_payout_method' },
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('CSRF_TOKEN_INVALID');

    // And the identity a request resolves to always comes from the session row, never the client.
    const resolved = await requireSession(
      new Request('http://localhost/x', { headers: { cookie: `${SESSION_COOKIE_NAME}=${victim.sessionId}` } }),
    );
    expect(resolved.userId).toBe(victim.userId);
    expect(resolved.userId).not.toBe(attacker.userId);
  });

  it('the session cookie is httpOnly, so client script can never read or forge it', async () => {
    const res = await register(
      new Request('http://localhost/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email: uniqueEmail(), password: PASSWORD }),
      }),
    );
    const cookie = res.cookies.get(SESSION_COOKIE_NAME);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.secure).toBe(true);
    expect(cookie?.sameSite).toBe('lax');
  });
});
