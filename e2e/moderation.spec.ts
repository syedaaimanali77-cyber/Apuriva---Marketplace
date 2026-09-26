/**
 * Spec 038 §6 "E2E" — the whole journey, through the real routes:
 *
 *   admin A suspends an account → admin B approves on spec 009's route → A applies it → the
 *   target's sessions are revoked and a new session is refused everywhere except the allow-list →
 *   the target reads /moderation-actions and appeals → admin C upholds → access is restored.
 *
 * Vitest, not Playwright: this repository has no browser runner, and `e2e/*.spec.ts` is the
 * filename convention spec 005 §6 established for end-to-end coverage.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { POST as CREATE_ACTION } from '@/app/api/v1/admin/moderation-actions/route';
import { POST as EXECUTE_ACTION } from '@/app/api/v1/admin/moderation-actions/[id]/execute/route';
import { POST as APPROVE } from '@/app/api/v1/admin/approvals/[actionId]/approve/route';
import { GET as MY_ACTIONS } from '@/app/api/v1/moderation-actions/route';
import { POST as FILE_APPEAL } from '@/app/api/v1/moderation-actions/[id]/appeals/route';
import { POST as DECIDE_APPEAL } from '@/app/api/v1/admin/moderation-appeals/[id]/decide/route';
import { GET as MY_SESSIONS } from '@/app/api/v1/users/me/sessions/route';
import { loginAgain, registerEmail } from '@/app/api/v1/users/me/privacy-test-support';
import { uniqueEmail } from '@/app/api/v1/auth/test-support';
import {
  adminWithRole,
  asUser,
  isDatabaseReachable,
  json,
  resetModerationForTests,
  useModerationIntegration,
  userStatus,
} from '@/lib/moderation/moderation-test-support';

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('spec 038 end to end', { timeout: 180_000 }, () => {
  beforeEach(() => useModerationIntegration());
  afterEach(() => resetModerationForTests());
  afterAll(async () => {
    await getPool().end();
  });

  it('suspend with four-eyes → refused outside the allow-list → appeal → upheld by a third admin → restored', async () => {
    const [a, b, c] = [await adminWithRole(), await adminWithRole(), await adminWithRole()];
    const email = uniqueEmail();
    await registerEmail(email);
    resetRateLimitState();
    const target = await loginAgain(email);

    const created = await CREATE_ACTION(
      asUser(a, '/admin/moderation-actions', {
        body: { actionType: 'suspension', scope: 'account', targetUserId: target.userId, reason: 'Coordinated payment fraud.', userMessage: 'Contact us via appeal.' },
      }),
    );
    expect(created.status).toBe(202);
    const action = (await json(created)).data;
    expect(await userStatus(target.userId)).toBe('active');

    const approved = await APPROVE(asUser(b, `/admin/approvals/${action.adminActionId}/approve`, { body: {} }));
    expect(approved.status).toBe(200);
    const executed = await EXECUTE_ACTION(asUser(a, `/admin/moderation-actions/${action.id}/execute`));
    expect(executed.status).toBe(200);
    expect(await userStatus(target.userId)).toBe('suspended');

    // The old session is revoked; a new one reaches only the allow-list.
    expect((await MY_SESSIONS(asUser(target, '/users/me/sessions', { method: 'GET' }))).status).toBe(401);
    resetRateLimitState();
    const fresh = await loginAgain(email);
    const refused = await MY_SESSIONS(asUser(fresh, '/users/me/sessions', { method: 'GET' }));
    expect((await json(refused)).code).toBe('ACCOUNT_SUSPENDED');

    const mine = await json(await MY_ACTIONS(asUser(fresh, '/moderation-actions', { method: 'GET' })));
    expect(mine.data[0]).toMatchObject({ id: action.id, actionType: 'suspension', userMessage: 'Contact us via appeal.', appealable: true });
    expect(JSON.stringify(mine)).not.toContain('Coordinated payment fraud.');

    const appeal = await json(await FILE_APPEAL(asUser(fresh, `/moderation-actions/${action.id}/appeals`, { body: { statement: 'My card was stolen.' } })));
    const decided = await DECIDE_APPEAL(asUser(c, `/admin/moderation-appeals/${appeal.data.id}/decide`, { body: { decision: 'upheld', reason: 'Card theft confirmed.' } }));
    expect((await json(decided)).data.status).toBe('upheld');

    expect(await userStatus(target.userId)).toBe('active');
    expect((await MY_SESSIONS(asUser(fresh, '/users/me/sessions', { method: 'GET' }))).status).toBe(200);
  });
});
