import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { sweepDeletions } from '@/lib/privacy/deletion';
import { getDb } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { users } from '@/lib/db/schema';
import { GET, POST } from './route';
import { POST as CANCEL } from './cancel/route';
import { authenticatedRequest, authenticatedRequestWithStepUp, getStepUpToken, isDatabaseReachable, registerAndLogin } from '../privacy-test-support';
import { seedBooking } from '@/lib/privacy/test-support';

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('account deletion (spec 008 AC-4, integration)', () => {
  beforeEach(() => {
    resetRateLimitState();
  });

  it('POST requires fresh step-up', async () => {
    const session = await registerAndLogin();
    const res = await POST(authenticatedRequest('http://localhost/api/v1/users/me/deletion', session.sessionId, session.csrfToken));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('STEP_UP_REQUIRED');
  });

  it('AC-4: a successful request enters Deletion Pending with a grace period', async () => {
    const session = await registerAndLogin();
    const token = await getStepUpToken(session, 'request_account_deletion');
    const res = await POST(authenticatedRequestWithStepUp('http://localhost/api/v1/users/me/deletion', session, token));
    expect(res.status).toBe(202);
    expect((await res.json()).data.gracePeriodEndsAt).toBeTruthy();

    const status = await GET(authenticatedRequest('http://localhost/api/v1/users/me/deletion', session.sessionId, session.csrfToken, { method: 'GET' }));
    const { data } = await status.json();
    expect(data.lifecycleStatus).toBe('deletion_pending');
    expect(data.deletionGraceEndsAt).toBeTruthy();
  });

  it('AC-4: an active booking blocks deletion with 422, no pending state entered', async () => {
    const session = await registerAndLogin();
    await seedBooking(session.userId, 'in_progress');

    const token = await getStepUpToken(session, 'request_account_deletion');
    const res = await POST(authenticatedRequestWithStepUp('http://localhost/api/v1/users/me/deletion', session, token));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('ACTIVE_BOOKING_BLOCKS_DELETION');

    const status = await GET(authenticatedRequest('http://localhost/api/v1/users/me/deletion', session.sessionId, session.csrfToken, { method: 'GET' }));
    expect((await status.json()).data.lifecycleStatus).toBe('active');
  });

  it('a duplicate deletion request while pending returns 409 DELETION_ALREADY_PENDING', async () => {
    const session = await registerAndLogin();
    const token1 = await getStepUpToken(session, 'request_account_deletion');
    await POST(authenticatedRequestWithStepUp('http://localhost/api/v1/users/me/deletion', session, token1));

    const token2 = await getStepUpToken(session, 'request_account_deletion');
    const res = await POST(authenticatedRequestWithStepUp('http://localhost/api/v1/users/me/deletion', session, token2));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('DELETION_ALREADY_PENDING');
  });

  it('cancellation works for the caller\'s own pending deletion, restoring active', async () => {
    const session = await registerAndLogin();
    const token = await getStepUpToken(session, 'request_account_deletion');
    await POST(authenticatedRequestWithStepUp('http://localhost/api/v1/users/me/deletion', session, token));

    const res = await CANCEL(authenticatedRequest('http://localhost/api/v1/users/me/deletion/cancel', session.sessionId, session.csrfToken));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ lifecycleStatus: 'active' });

    const status = await GET(authenticatedRequest('http://localhost/api/v1/users/me/deletion', session.sessionId, session.csrfToken, { method: 'GET' }));
    expect((await status.json()).data.lifecycleStatus).toBe('active');
  });

  it('cancellation is rejected when nothing is pending', async () => {
    const session = await registerAndLogin();
    const res = await CANCEL(authenticatedRequest('http://localhost/api/v1/users/me/deletion/cancel', session.sessionId, session.csrfToken));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('DELETION_NOT_PENDING');
  });

  it('cancellation cannot undo deletion once the scheduled sweep has anonymized the account', async () => {
    const session = await registerAndLogin();
    const token = await getStepUpToken(session, 'request_account_deletion');
    await POST(authenticatedRequestWithStepUp('http://localhost/api/v1/users/me/deletion', session, token));

    await getDb().update(users).set({ deletionGraceEndsAt: new Date(Date.now() - 1000) }).where(eq(users.id, session.userId));
    await sweepDeletions();

    const res = await CANCEL(authenticatedRequest('http://localhost/api/v1/users/me/deletion/cancel', session.sessionId, session.csrfToken));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('DELETION_NOT_PENDING');
  });
});
