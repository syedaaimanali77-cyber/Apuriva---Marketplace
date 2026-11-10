/**
 * Spec 034 §6 "E2E (Vitest)".
 *
 * `e2e/*.spec.ts` is a configured VITEST pattern (vitest.config.ts `include`), not Playwright — there
 * is no browser runner in this repository and this spec does not add one. What makes this end to end
 * is that each test walks a whole journey, in order, through the real route handlers and the real
 * `*_test` database: a conversation from first message to deletion; a high-risk proposal that cannot
 * run without the structured confirmation; a temporary conversation that leaves nothing behind.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  action,
  aiRequest,
  aiRowCounts,
  BASE,
  freshKey,
  isDatabaseReachable,
  json,
  registerAndLogin,
  resetAiAssistantState,
  useTestExecutor,
} from '@/lib/ai-assistant/ai-assistant-test-support';

vi.mock('@/lib/ai', async () => (await import('@/lib/ai-assistant/ai-assistant-test-support')).aiModuleMock());

const conversations = await import('@/app/api/v1/ai/conversations/route');
const one = await import('@/app/api/v1/ai/conversations/[id]/route');
const messages = await import('@/app/api/v1/ai/conversations/[id]/messages/route');
const confirm = await import('@/app/api/v1/ai/conversations/[id]/confirm/route');
const temporary = await import('@/app/api/v1/ai/temporary-turns/route');
const activity = await import('@/app/api/v1/ai/activity/route');

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('Ask Apuriva, end to end (spec 034)', { timeout: 120_000 }, () => {
  beforeEach(() => resetAiAssistantState());
  afterAll(() => resetAiAssistantState());

  it('a signed-in user starts a conversation, gets a reply, sees it in history, and deletes it', async () => {
    const session = await registerAndLogin();

    const created = await conversations.POST(aiRequest(`${BASE}/ai/conversations`, session, { method: 'POST', body: {}, idempotencyKey: freshKey() }));
    expect(created.status).toBe(201);
    const id = (await json(created)).data.id;

    const turn = await messages.POST(
      aiRequest(`${BASE}/ai/conversations/${id}/messages`, session, { method: 'POST', body: { body: 'I need an AC technician' }, idempotencyKey: freshKey() }),
    );
    expect(turn.status).toBe(201);
    expect((await json(turn)).data.role).toBe('assistant');

    const history = await json(await conversations.GET(aiRequest(`${BASE}/ai/conversations`, session)));
    expect(history.data).toEqual([expect.objectContaining({ id, preview: 'I need an AC technician' })]);

    const search = await json(await conversations.GET(aiRequest(`${BASE}/ai/conversations?q=technician`, session)));
    expect(search.data.map((c: { id: string }) => c.id)).toEqual([id]);

    expect((await one.DELETE(aiRequest(`${BASE}/ai/conversations/${id}`, session, { method: 'DELETE' }))).status).toBe(204);
    expect((await json(await conversations.GET(aiRequest(`${BASE}/ai/conversations`, session)))).data).toEqual([]);
    expect((await aiRowCounts(session.userId)).messages).toBe(0);
  });

  it('a high-risk proposal from a test executor cannot run without the structured confirmation', async () => {
    const executor = useTestExecutor();
    const booking = action({ riskTier: 'high', actionType: 'create_booking', actionLabel: 'Book AC repair with Ali Raza', confirmationId: 'conf-e2e' });
    executor.proposal = booking;
    executor.confirmations.set('conf-e2e', booking);
    executor.labels.set('create_booking', booking.actionLabel);
    const session = await registerAndLogin();
    const id = (await json(await conversations.POST(aiRequest(`${BASE}/ai/conversations`, session, { method: 'POST', body: {}, idempotencyKey: freshKey() })))).data
      .id;

    const reply = (
      await json(
        await messages.POST(aiRequest(`${BASE}/ai/conversations/${id}/messages`, session, { method: 'POST', body: { body: 'Book it' }, idempotencyKey: freshKey() })),
      )
    ).data;
    expect(reply.pendingConfirmation).toMatchObject({ riskTier: 'high', confirmationId: 'conf-e2e' });

    // Saying yes in the conversation does nothing.
    executor.proposal = null;
    await messages.POST(aiRequest(`${BASE}/ai/conversations/${id}/messages`, session, { method: 'POST', body: { body: 'yes' }, idempotencyKey: freshKey() }));
    expect(executor.count('execute')).toBe(0);
    expect((await json(await activity.GET(aiRequest(`${BASE}/ai/activity`, session)))).data).toEqual([]);

    // The explicit, structured confirmation runs it — once.
    const confirmed = await confirm.POST(
      aiRequest(`${BASE}/ai/conversations/${id}/confirm`, session, { method: 'POST', body: { confirmationId: 'conf-e2e' }, idempotencyKey: freshKey() }),
    );
    expect(confirmed.status).toBe(200);
    expect(executor.count('execute')).toBe(1);
    const entries = (await json(await activity.GET(aiRequest(`${BASE}/ai/activity`, session)))).data;
    expect(entries).toEqual([
      expect.objectContaining({ actionLabel: 'Book AC repair with Ali Raza', requiredConfirmation: true, result: 'succeeded', reversible: false }),
    ]);
  });

  it('a temporary conversation leaves no history, no memory and no activity', async () => {
    const executor = useTestExecutor();
    executor.proposal = action({ riskTier: 'low' });
    const session = await registerAndLogin();
    const turns = [{ role: 'user', body: 'Private: how much is a deep clean?' }];
    const first = await temporary.POST(aiRequest(`${BASE}/ai/temporary-turns`, session, { method: 'POST', body: { turns } }));
    const reply = (await json(first)).data.body as string;
    await temporary.POST(
      aiRequest(`${BASE}/ai/temporary-turns`, session, {
        method: 'POST',
        body: { turns: [...turns, { role: 'assistant', body: reply }, { role: 'user', body: 'And for two rooms?' }] },
      }),
    );

    expect(await aiRowCounts(session.userId)).toEqual({ conversations: 0, messages: 0, memories: 0, actions: 0 });
    expect(executor.calls).toEqual([]);
    expect((await json(await conversations.GET(aiRequest(`${BASE}/ai/conversations?q=deep`, session)))).data).toEqual([]);
  });
});
