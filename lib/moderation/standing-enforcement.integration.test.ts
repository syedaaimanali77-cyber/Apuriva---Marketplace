import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { getOptionalSession } from '@/lib/auth/require-session';
import { createRequest } from '@/lib/requests/create';
import { createOffer } from '@/lib/offers/create';
import { acceptOffer } from '@/lib/offers/decide';
import { reviseOffer } from '@/lib/negotiation/revise';
import { createChangeRequest } from '@/lib/negotiation/change-requests';
import { createBooking } from '@/lib/bookings/create';
import { offerBody, seedOfferScenario, sendOffer } from '@/lib/offers/offers-test-support';
import { createBookingBody, seedBookingScenario } from '@/lib/bookings/bookings-test-support';
import { GET as listMySessions } from '@/app/api/v1/users/me/sessions/route';
import { GET as getMe } from '@/app/api/v1/users/me/route';
import { GET as listMyModerationActions } from '@/app/api/v1/moderation-actions/route';
import { loginAgain, registerEmail } from '@/app/api/v1/users/me/privacy-test-support';
import { uniqueEmail } from '@/app/api/v1/auth/test-support';
import { executeReversal, requestReversal } from './actions';
import {
  adminWithRole,
  approve,
  asUser,
  initiate,
  initiateApproveExecute,
  isDatabaseReachable,
  json,
  openSessionCount,
  resetModerationForTests,
  useModerationIntegration,
  type TestSession,
} from './moderation-test-support';

const dbReachable = await isDatabaseReachable();

afterAll(async () => {
  await getPool().end();
});

/** A user whose email we know, so a fresh session can be minted after a revocation. */
async function knownUser(): Promise<{ email: string; session: TestSession }> {
  const email = uniqueEmail();
  await registerEmail(email);
  resetRateLimitState();
  return { email, session: await loginAgain(email) };
}

/** Spec 038 §3.5 — X-1 (spec 005 session gate) and X-3…X-5 (marketplace entry points). */
describe.skipIf(!dbReachable)('account standing enforcement (spec 038 §3.5)', { timeout: 180_000 }, () => {
  beforeEach(() => useModerationIntegration());
  afterEach(() => resetModerationForTests());

  it('X-1: suspension revokes every session; a new session reaches only the allow-list', async () => {
    const [a, b] = [await adminWithRole(), await adminWithRole()];
    const { email, session } = await knownUser();
    expect(await openSessionCount(session.userId)).toBeGreaterThan(0);

    await initiateApproveExecute(a, b, { actionType: 'suspension', scope: 'account', targetUserId: session.userId });
    expect(await openSessionCount(session.userId)).toBe(0);
    expect((await listMySessions(asUser(session, '/users/me/sessions', { method: 'GET' }))).status).toBe(401);

    resetRateLimitState();
    const fresh = await loginAgain(email);
    const refused = await listMySessions(asUser(fresh, '/users/me/sessions', { method: 'GET' }));
    expect(refused.status).toBe(403);
    expect((await json(refused)).code).toBe('ACCOUNT_SUSPENDED');

    expect((await getMe(asUser(fresh, '/users/me', { method: 'GET' }))).status).toBe(200);
    expect((await listMyModerationActions(asUser(fresh, '/moderation-actions', { method: 'GET' }))).status).toBe(200);

    const optional = await getOptionalSession(
      new Request('http://localhost/x', { headers: { cookie: `${SESSION_COOKIE_NAME}=${fresh.sessionId}` } }),
    );
    expect(optional).toBeNull();
  });

  it('X-1: a banned account is refused with ACCOUNT_BANNED; reversal restores access on the next request', async () => {
    const [a, b] = [await adminWithRole(), await adminWithRole()];
    const { email, session } = await knownUser();
    const ban = await initiateApproveExecute(a, b, { actionType: 'ban', scope: 'account', targetUserId: session.userId });

    resetRateLimitState();
    const fresh = await loginAgain(email);
    const refused = await listMySessions(asUser(fresh, '/users/me/sessions', { method: 'GET' }));
    expect((await json(refused)).code).toBe('ACCOUNT_BANNED');

    const requested = await requestReversal({ adminUserId: a.userId, actionId: ban.id, reason: 'Wrong account.', correlationId: null });
    await approve(b, requested.reversalAdminActionId!);
    await executeReversal({ adminUserId: a.userId, actionId: ban.id, correlationId: null });
    expect((await listMySessions(asUser(fresh, '/users/me/sessions', { method: 'GET' }))).status).toBe(200);
  });

  it('X-1: a restriction keeps sessions and normal session access', async () => {
    const admin = await adminWithRole();
    const { session } = await knownUser();
    const before = await openSessionCount(session.userId);
    await initiate(admin, { actionType: 'restriction', scope: 'account', targetUserId: session.userId });
    expect(await openSessionCount(session.userId)).toBe(before);
    expect((await listMySessions(asUser(session, '/users/me/sessions', { method: 'GET' }))).status).toBe(200);
  });

  it('X-3: a restricted account creates no request', async () => {
    const admin = await adminWithRole();
    const { session } = await knownUser();
    await initiate(admin, { actionType: 'restriction', scope: 'account', targetUserId: session.userId });
    await expect(createRequest(session.userId, randomUUID(), {})).rejects.toMatchObject({ code: 'ACCOUNT_RESTRICTED', status: 403 });
  });

  it('X-4: a restricted provider account sends and revises no offer; a sanctioned profile sends none either', async () => {
    const admin = await adminWithRole();
    const scenario = await seedOfferScenario({ providerCount: 2 });
    const [p1, p2] = scenario.providers as [(typeof scenario.providers)[0], (typeof scenario.providers)[0]];
    const sent = await sendOffer(p1, scenario.requestId);

    await initiate(admin, { actionType: 'restriction', scope: 'account', targetUserId: p1.userId });
    await expect(createOffer(p1.userId, p1.providerProfileId, randomUUID(), offerBody(scenario.requestId))).rejects.toMatchObject({
      code: 'ACCOUNT_RESTRICTED',
    });
    await expect(
      reviseOffer(p1.userId, p1.providerProfileId, sent.id, randomUUID(), { priceAmountMinorUnits: 300_000, currencyCode: 'PKR', includedItems: ['Labour'] }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_RESTRICTED' });

    await initiate(admin, { actionType: 'restriction', scope: 'provider_profile', targetUserId: p2.userId, providerProfileId: p2.providerProfileId });
    await expect(createOffer(p2.userId, p2.providerProfileId, randomUUID(), offerBody(scenario.requestId))).rejects.toMatchObject({
      code: 'PROVIDER_NOT_IN_GOOD_STANDING',
      details: { standing: 'restricted' },
    });
  });

  it('X-4: a restricted customer accepts no offer and raises no change request', async () => {
    const admin = await adminWithRole();
    const scenario = await seedOfferScenario();
    const sent = await sendOffer(scenario.providers[0]!, scenario.requestId);
    await initiate(admin, { actionType: 'restriction', scope: 'account', targetUserId: scenario.customer.userId });
    await expect(acceptOffer(scenario.customer.userId, sent.id, randomUUID())).rejects.toMatchObject({ code: 'ACCOUNT_RESTRICTED' });
    await expect(createChangeRequest(scenario.customer.userId, sent.id, randomUUID(), { note: 'Could you do it cheaper?' })).rejects.toMatchObject({
      code: 'ACCOUNT_RESTRICTED',
    });
  });

  it('X-5: neither a restricted customer nor a sanctioned provider profile enters a booking', async () => {
    const admin = await adminWithRole();
    const first = await seedBookingScenario();
    await initiate(admin, { actionType: 'restriction', scope: 'account', targetUserId: first.customer.userId });
    await expect(createBooking(first.customer.userId, randomUUID(), createBookingBody(first.offerId))).rejects.toMatchObject({
      code: 'ACCOUNT_RESTRICTED',
    });

    resetRateLimitState();
    const second = await seedBookingScenario();
    await initiate(admin, {
      actionType: 'restriction',
      scope: 'provider_profile',
      targetUserId: second.provider.userId,
      providerProfileId: second.provider.providerProfileId,
    });
    await expect(createBooking(second.customer.userId, randomUUID(), createBookingBody(second.offerId))).rejects.toMatchObject({
      code: 'PROVIDER_NOT_IN_GOOD_STANDING',
    });
  });
});
