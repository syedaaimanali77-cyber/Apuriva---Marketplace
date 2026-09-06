import { beforeEach, describe, expect, it } from 'vitest';
import { GET, DELETE as DELETE_ALL } from './route';
import { DELETE as DELETE_ONE } from './[id]/route';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import {
  authenticatedRequest,
  authenticatedRequestWithStepUp,
  getStepUpToken,
  isDatabaseReachable,
  loginAgain,
  registerAndLogin,
  uniqueEmail,
  registerEmail,
} from '../privacy-test-support';

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('sessions (spec 008 AC-1/AC-2, integration)', () => {
  beforeEach(() => {
    resetRateLimitState();
  });

  it('AC-1: lists only the caller\'s own sessions, with the current one flagged and coarse-only location', async () => {
    const session = await registerAndLogin();

    const res = await GET(authenticatedRequest('http://localhost/api/v1/users/me/sessions', session.sessionId, session.csrfToken, { method: 'GET' }));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].isCurrent).toBe(true);
    expect(data[0].approxLocation).toBeNull();
    expect(data[0]).not.toHaveProperty('ipHash');
  });

  it('GET /sessions never returns another user\'s sessions', async () => {
    const a = await registerAndLogin();
    await registerAndLogin();

    const res = await GET(authenticatedRequest('http://localhost/api/v1/users/me/sessions', a.sessionId, a.csrfToken, { method: 'GET' }));
    const { data } = await res.json();
    expect(data).toHaveLength(1);
  });

  it('AC-1: a single-session logout revokes only that session', async () => {
    const email = uniqueEmail();
    await registerEmail(email);
    resetRateLimitState();
    const session = await loginAgain(email);
    resetRateLimitState();
    const other = await loginAgain(email);

    const del = await DELETE_ONE(
      authenticatedRequest(`http://localhost/api/v1/users/me/sessions/${other.sessionId}`, session.sessionId, session.csrfToken, {
        method: 'DELETE',
      }),
    );
    expect(del.status).toBe(204);

    const list = await GET(authenticatedRequest('http://localhost/api/v1/users/me/sessions', session.sessionId, session.csrfToken, { method: 'GET' }));
    const { data } = await list.json();
    expect(data.map((s: { id: string }) => s.id)).not.toContain(other.sessionId);
    expect(data.map((s: { id: string }) => s.id)).toContain(session.sessionId);
  });

  it('cannot revoke another user\'s session — returns 404, not that session\'s state', async () => {
    const a = await registerAndLogin();
    const b = await registerAndLogin();

    const res = await DELETE_ONE(
      authenticatedRequest(`http://localhost/api/v1/users/me/sessions/${b.sessionId}`, a.sessionId, a.csrfToken, { method: 'DELETE' }),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NOT_FOUND');
  });

  it('a nonexistent session id returns the identical 404 as another user\'s session id', async () => {
    const a = await registerAndLogin();
    const res = await DELETE_ONE(
      authenticatedRequest('http://localhost/api/v1/users/me/sessions/00000000-0000-0000-0000-000000000000', a.sessionId, a.csrfToken, {
        method: 'DELETE',
      }),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NOT_FOUND');
  });

  it('AC-2/AC-5: logging out all other devices requires fresh step-up', async () => {
    const session = await registerAndLogin();
    const res = await DELETE_ALL(
      authenticatedRequest('http://localhost/api/v1/users/me/sessions', session.sessionId, session.csrfToken, { method: 'DELETE' }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('STEP_UP_REQUIRED');
  });

  it('AC-2: logout-all revokes every OTHER session but the current one survives', async () => {
    const email = uniqueEmail();
    await registerEmail(email);
    resetRateLimitState();
    const session = await loginAgain(email);
    resetRateLimitState();
    const other1 = await loginAgain(email);
    resetRateLimitState();
    const other2 = await loginAgain(email);

    const stepUpToken = await getStepUpToken(session, 'logout_all_other_devices');
    const res = await DELETE_ALL(
      authenticatedRequestWithStepUp('http://localhost/api/v1/users/me/sessions', session, stepUpToken, { method: 'DELETE' }),
    );
    expect(res.status).toBe(204);

    const list = await GET(authenticatedRequest('http://localhost/api/v1/users/me/sessions', session.sessionId, session.csrfToken, { method: 'GET' }));
    const { data } = await list.json();
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe(session.sessionId);

    // The other sessions are actually revoked server-side, not just hidden from the list.
    const otherList = await GET(authenticatedRequest('http://localhost/api/v1/users/me/sessions', other1.sessionId, other1.csrfToken, { method: 'GET' }));
    expect(otherList.status).toBe(401);
    void other2;
  });
});
