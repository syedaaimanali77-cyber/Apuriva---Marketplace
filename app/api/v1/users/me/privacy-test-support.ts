import { POST as register } from '@/app/api/v1/auth/register/route';
import { POST as login } from '@/app/api/v1/auth/login/route';
import { POST as stepUp } from '@/app/api/v1/auth/step-up/route';
import { authenticatedRequest, csrfCookieFrom, sessionCookieFrom, uniqueEmail } from '@/app/api/v1/auth/test-support';

export { isDatabaseReachable, authenticatedRequest, uniqueEmail } from '@/app/api/v1/auth/test-support';

const TEST_PASSWORD = 'correct horse battery staple';

export interface TestSession {
  userId: string;
  sessionId: string;
  csrfToken: string;
}

/** Registers a fresh unique account and returns its session — shared across spec 008's route
 * integration tests, mirroring the pattern in app/api/v1/auth/step-up.integration.test.ts. */
export async function registerAndLogin(): Promise<TestSession> {
  const email = uniqueEmail();
  const res = await register(
    new Request('http://localhost/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password: TEST_PASSWORD }),
    }),
  );
  const { data } = await res.json();
  const csrfToken = csrfCookieFrom(res)!;
  return { userId: data.userId, sessionId: data.sessionId, csrfToken };
}

/** A second session for the SAME account (spec 008 AC-2 needs two live sessions to test
 * logout-all) — `POST /auth/login` again with the same credentials. */
export async function loginAgain(email: string): Promise<TestSession> {
  const res = await login(
    new Request('http://localhost/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: TEST_PASSWORD }),
    }),
  );
  const { data } = await res.json();
  const csrfToken = csrfCookieFrom(res)!;
  return { userId: data.userId, sessionId: data.sessionId, csrfToken };
}

export function registerEmail(email: string, password = TEST_PASSWORD) {
  return register(
    new Request('http://localhost/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  );
}

/** Mints a spec-005 step-up token bound to (sessionId, action) — the header a sensitive spec 008
 * endpoint requires (lib/auth/step-up.ts `requireStepUp`). */
export async function getStepUpToken(session: TestSession, action: string): Promise<string> {
  const res = await stepUp(authenticatedRequest('http://localhost/api/v1/auth/step-up', session.sessionId, session.csrfToken, { body: { action } }));
  const { data } = await res.json();
  return data.stepUpToken as string;
}

export function authenticatedRequestWithStepUp(
  url: string,
  session: TestSession,
  stepUpToken: string,
  init?: { method?: string; body?: unknown },
): Request {
  const base = authenticatedRequest(url, session.sessionId, session.csrfToken, init);
  const headers = new Headers(base.headers);
  headers.set('x-step-up-token', stepUpToken);
  return new Request(base, { headers });
}

export { sessionCookieFrom };
