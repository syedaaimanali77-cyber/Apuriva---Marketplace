/**
 * Spec 034 §3.2, §3.8 — activity history (AC-10, AC-11): plain language, time, related entity, result
 * and confirmation flag; never a raw tool identifier; survives the conversation's deletion; no Undo.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  action,
  aiRequest,
  BASE,
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

const { POST: CREATE, DELETE: CLEAR } = await import('@/app/api/v1/ai/conversations/route');
const { POST: SEND } = await import('@/app/api/v1/ai/conversations/[id]/messages/route');
const { GET: ACTIVITY } = await import('@/app/api/v1/ai/activity/route');

const dbReachable = await isDatabaseReachable();
const REQUEST_ID = '11111111-2222-4333-8444-555555555555';

describe.skipIf(!dbReachable)('spec 034 activity history (integration)', () => {
  let session: TestSession;
  let executor: TestExecutor;
  let conversationId: string;

  beforeEach(async () => {
    resetAiAssistantState();
    executor = useTestExecutor();
    session = await registerAndLogin();
    const res = await CREATE(aiRequest(`${BASE}/ai/conversations`, session, { method: 'POST', body: {}, idempotencyKey: freshKey() }));
    conversationId = (await json(res)).data.id;
  });

  afterAll(() => resetAiAssistantState());

  async function runLowRisk(actionType: string, related: { type: 'request' | 'booking'; id: string } | null = null) {
    executor.proposal = action({ riskTier: 'low', actionType, related });
    await SEND(
      aiRequest(`${BASE}/ai/conversations/${conversationId}/messages`, session, { method: 'POST', body: { body: 'go' }, idempotencyKey: freshKey() }),
    );
  }

  async function activity(as: TestSession = session) {
    return json(await ACTIVITY(aiRequest(`${BASE}/ai/activity`, as)));
  }

  it('entry carries label, time, related entity, result and confirmation flag, never a tool id (AC-10)', async () => {
    executor.labels.set('search_providers', 'Searched for electricians');
    await runLowRisk('search_providers', { type: 'request', id: REQUEST_ID });

    const body = await activity();
    expect(body.data).toHaveLength(1);
    const [entry] = body.data;
    expect(entry).toMatchObject({
      conversationId,
      actionLabel: 'Searched for electricians',
      riskTier: 'low',
      requiredConfirmation: false,
      result: 'succeeded',
      related: { type: 'request', id: REQUEST_ID },
      reversible: false,
    });
    expect(Date.parse(entry.createdAt)).not.toBeNaN();
    expect(JSON.stringify(body)).not.toContain('search_providers');
  });

  it('an action whose tool declares no plain-language label is not shown (§8 risk 6)', async () => {
    await runLowRisk('unlabelled_tool');
    expect((await activity()).data).toEqual([]);
  });

  it('every entry is irreversible: there is no Undo to offer (AC-11, §3.8)', async () => {
    executor.labels.set('a', 'Did A');
    await runLowRisk('a');
    expect((await activity()).data.every((e: { reversible: boolean }) => e.reversible === false)).toBe(true);
  });

  it('newest first, and survives clearing conversation history', async () => {
    executor.labels.set('first', 'First');
    executor.labels.set('second', 'Second');
    await runLowRisk('first');
    await runLowRisk('second');
    await CLEAR(aiRequest(`${BASE}/ai/conversations`, session, { method: 'DELETE' }));
    expect((await activity()).data.map((e: { actionLabel: string }) => e.actionLabel)).toEqual(['Second', 'First']);
  });

  it('is the caller’s own: another user sees none of it', async () => {
    executor.labels.set('mine', 'Mine');
    await runLowRisk('mine');
    const stranger = await registerAndLogin();
    expect((await activity(stranger)).data).toEqual([]);
  });

  it('a throwing executor leaves the row pending ("outcome unknown"), never a success', async () => {
    executor.labels.set('flaky', 'Checked availability');
    executor.outcome = new Error('lost connection');
    await runLowRisk('flaky');
    expect((await activity()).data[0]).toMatchObject({ actionLabel: 'Checked availability', result: 'pending' });
  });
});
