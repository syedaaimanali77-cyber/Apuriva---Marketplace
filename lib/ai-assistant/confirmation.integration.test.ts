/**
 * Spec 034 §3.4, §3.5 — risk tiers and confirmation against a TEST executor (AC-4 – AC-7). Specs
 * 035/036 are unbuilt; the executor's real authorization is theirs to test (§6).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { ApiRouteError } from '@/lib/api/errors';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import {
  action,
  aiControl,
  aiRequest,
  aiRowCounts,
  BASE,
  envelope,
  freshKey,
  isDatabaseReachable,
  json,
  registerAndLogin,
  resetAiAssistantState,
  useTestExecutor,
  type TestExecutor,
  type TestSession,
} from './ai-assistant-test-support';

vi.mock('@/lib/ai', async () => (await import('./ai-assistant-test-support')).aiModuleMock());

const { POST: CREATE } = await import('@/app/api/v1/ai/conversations/route');
const { POST: SEND } = await import('@/app/api/v1/ai/conversations/[id]/messages/route');
const { POST: CONFIRM } = await import('@/app/api/v1/ai/conversations/[id]/confirm/route');

const dbReachable = await isDatabaseReachable();

async function actionRows(conversationId: string) {
  return queryRows<{ risk_tier: string; required_confirmation: boolean; result: string; action_type: string }>(
    getDb(),
    sql`SELECT risk_tier, required_confirmation, result, action_type FROM ai_actions WHERE ai_conversation_id = ${conversationId}`,
  );
}

describe.skipIf(!dbReachable)('spec 034 risk tiers and confirmation (integration)', () => {
  let session: TestSession;
  let conversationId: string;
  let executor: TestExecutor;

  async function turn(body = 'Please do it') {
    const res = await SEND(
      aiRequest(`${BASE}/ai/conversations/${conversationId}/messages`, session, { method: 'POST', body: { body }, idempotencyKey: freshKey() }),
    );
    return (await json(res)).data;
  }

  function confirm(confirmationId: string, idempotencyKey = freshKey(), as: TestSession = session) {
    return CONFIRM(
      aiRequest(`${BASE}/ai/conversations/${conversationId}/confirm`, as, { method: 'POST', body: { confirmationId }, idempotencyKey }),
    );
  }

  beforeEach(async () => {
    resetAiAssistantState();
    executor = useTestExecutor();
    session = await registerAndLogin();
    const res = await CREATE(aiRequest(`${BASE}/ai/conversations`, session, { method: 'POST', body: {}, idempotencyKey: freshKey() }));
    conversationId = (await json(res)).data.id;
  });

  afterAll(() => resetAiAssistantState());

  it('with the default inert port nothing is proposed and every confirmation is 404', async () => {
    resetAiAssistantState();
    const reply = await turn();
    expect(reply.pendingConfirmation).toBeUndefined();
    expect((await confirm('anything')).status).toBe(404);
    expect((await aiRowCounts(session.userId)).actions).toBe(0);
  });

  it('a low-risk action runs without confirmation (AC-4)', async () => {
    executor.proposal = action({ riskTier: 'low', actionType: 'search_providers' });
    const reply = await turn('Find plumbers');
    expect(reply.pendingConfirmation).toBeUndefined();
    expect(executor.count('execute')).toBe(1);
    expect(await actionRows(conversationId)).toEqual([
      { risk_tier: 'low', required_confirmation: false, result: 'succeeded', action_type: 'search_providers' },
    ]);
  });

  it('medium-risk waits for an explicit confirm request (AC-5)', async () => {
    const proposed = action({ riskTier: 'medium', actionType: 'send_message', actionLabel: 'Send a message to Ali', confirmationId: 'conf-m' });
    executor.proposal = proposed;
    executor.confirmations.set('conf-m', proposed);

    const reply = await turn('Message Ali');
    expect(reply.pendingConfirmation).toEqual({
      confirmationId: 'conf-m',
      riskTier: 'medium',
      actionLabel: 'Send a message to Ali',
      parameters: proposed.parameters,
    });
    expect(executor.count('execute')).toBe(0);
    expect(await actionRows(conversationId)).toEqual([]);

    const res = await confirm('conf-m');
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ riskTier: 'medium', requiredConfirmation: true, result: 'succeeded' });
    expect(executor.count('execute')).toBe(1);
  });

  it('a typed "yes" never confirms', async () => {
    const proposed = action({ riskTier: 'medium', confirmationId: 'conf-yes' });
    executor.proposal = proposed;
    executor.confirmations.set('conf-yes', proposed);
    await turn('Message Ali');
    executor.proposal = null;
    aiControl.output = envelope('Okay!');
    for (const body of ['yes', 'Yes, confirm', 'I confirm conf-yes']) await turn(body);
    expect(executor.count('execute')).toBe(0);
    expect(await actionRows(conversationId)).toEqual([]);
  });

  it('high-risk requires the structured confirmation and never runs from the turn itself (AC-6)', async () => {
    const proposed = action({ riskTier: 'high', actionType: 'create_booking', confirmationId: 'conf-h' });
    executor.proposal = proposed;
    executor.confirmations.set('conf-h', proposed);
    const reply = await turn('Book it');
    expect(reply.pendingConfirmation.riskTier).toBe('high');
    expect(reply.pendingConfirmation.parameters).toEqual(proposed.parameters);
    expect(executor.count('execute')).toBe(0);

    const res = await confirm('conf-h');
    expect((await json(res)).data).toMatchObject({ riskTier: 'high', requiredConfirmation: true, result: 'succeeded' });
  });

  it('stale parameters are rejected with the executor’s own error, unchanged, and nothing is recorded', async () => {
    executor.staleError = new ApiRouteError('MCP_CONFIRMATION_STALE', 'The confirmed parameters changed.', { status: 409 });
    const res = await confirm('conf-stale');
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe('MCP_CONFIRMATION_STALE');
    expect(executor.count('execute')).toBe(0);
    expect(await actionRows(conversationId)).toEqual([]);
  });

  it('restricted is never offered, never executed and never recorded (AC-7)', async () => {
    const proposed = action({ riskTier: 'restricted', actionType: 'ban_user', confirmationId: 'conf-r' });
    executor.proposal = proposed;
    executor.confirmations.set('conf-r', proposed);
    const reply = await turn('Ban them');
    expect(reply.pendingConfirmation).toBeUndefined();
    expect((await confirm('conf-r')).status).toBe(404);
    expect(executor.count('execute')).toBe(0);
    expect(await actionRows(conversationId)).toEqual([]);
  });

  it('a low-risk action cannot be "confirmed" into existence', async () => {
    executor.confirmations.set('conf-low', action({ riskTier: 'low' }));
    expect((await confirm('conf-low')).status).toBe(404);
    expect(executor.count('execute')).toBe(0);
  });

  it('a confirmation retry returns the original result instead of executing twice; a different body is 409', async () => {
    const proposed = action({ riskTier: 'medium', confirmationId: 'conf-replay' });
    executor.confirmations.set('conf-replay', proposed);
    executor.labels.set(proposed.actionType, proposed.actionLabel);
    const key = freshKey();
    const first = await confirm('conf-replay', key);
    const replay = await confirm('conf-replay', key);
    expect(replay.status).toBe(200);
    expect((await json(replay)).data.id).toBe((await json(first)).data.id);
    expect(executor.count('execute')).toBe(1);
    expect((await confirm('conf-other', key)).status).toBe(409);
  });

  it('an executor failure is recorded only as the confirmed result; a throw leaves "outcome unknown", never success', async () => {
    const proposed = action({ riskTier: 'medium', confirmationId: 'conf-fail' });
    executor.confirmations.set('conf-fail', proposed);
    executor.outcome = { succeeded: false };
    expect((await json(await confirm('conf-fail'))).data.result).toBe('failed');

    executor.confirmations.set('conf-crash', proposed);
    executor.outcome = new Error('executor crashed');
    expect((await confirm('conf-crash')).status).toBe(500);
    const results = (await actionRows(conversationId)).map((r) => r.result).sort();
    expect(results).toEqual(['failed', 'pending']);
  });

  it('confirming requires the caller’s own conversation: another user gets 404', async () => {
    const proposed = action({ riskTier: 'medium', confirmationId: 'conf-own' });
    executor.confirmations.set('conf-own', proposed);
    const stranger = await registerAndLogin();
    expect((await confirm('conf-own', freshKey(), stranger)).status).toBe(404);
    expect(executor.count('execute')).toBe(0);
  });

  it('passes the caller, session and stored conversation to the executor', async () => {
    executor.proposal = action({ riskTier: 'low' });
    await turn();
    const ctx = executor.calls.find((c) => c.method === 'interpretTurn')!.args[0] as Record<string, string>;
    expect(ctx).toEqual({ userId: session.userId, sessionId: session.sessionId, conversationId });
  });
});
