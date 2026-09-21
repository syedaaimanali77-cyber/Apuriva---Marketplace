/**
 * Spec 034 §3.2, §3.3, §4 "Deletion" — normal conversations end to end through the real routes
 * (AC-1, AC-2, AC-8, AC-12). The model output is the real spec 033 sandbox unless a test sets
 * `aiControl.output`.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import {
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
  action,
  type TestSession,
} from './ai-assistant-test-support';

vi.mock('@/lib/ai', async () => (await import('./ai-assistant-test-support')).aiModuleMock());

const { POST: CREATE, GET: LIST, DELETE: CLEAR } = await import('@/app/api/v1/ai/conversations/route');
const { DELETE: DELETE_ONE } = await import('@/app/api/v1/ai/conversations/[id]/route');
const { GET: TRANSCRIPT, POST: SEND } = await import('@/app/api/v1/ai/conversations/[id]/messages/route');
const { AiQuotaExceededError } = await import('@/lib/ai/errors');

const dbReachable = await isDatabaseReachable();

async function startConversation(session: TestSession): Promise<string> {
  const res = await CREATE(aiRequest(`${BASE}/ai/conversations`, session, { method: 'POST', body: {}, idempotencyKey: freshKey() }));
  expect(res.status).toBe(201);
  return (await json(res)).data.id;
}

function sendTurn(session: TestSession, conversationId: string, body: string, idempotencyKey = freshKey()) {
  return SEND(
    aiRequest(`${BASE}/ai/conversations/${conversationId}/messages`, session, { method: 'POST', body: { body }, idempotencyKey }),
  );
}

async function transcript(session: TestSession, conversationId: string) {
  return TRANSCRIPT(aiRequest(`${BASE}/ai/conversations/${conversationId}/messages`, session));
}

describe.skipIf(!dbReachable)('spec 034 conversations (integration)', () => {
  let session: TestSession;

  beforeEach(async () => {
    resetAiAssistantState();
    session = await registerAndLogin();
  });

  afterAll(() => resetAiAssistantState());

  it('persists both halves of a turn in created_at, id order (AC-1)', async () => {
    const id = await startConversation(session);
    const first = await sendTurn(session, id, 'Need an electrician tomorrow');
    expect(first.status).toBe(201);
    expect((await json(first)).data.role).toBe('assistant');
    await sendTurn(session, id, 'In DHA please');

    const body = await json(await transcript(session, id));
    expect(body.data.map((m: { role: string; body: string }) => [m.role, m.role === 'user' ? m.body : 'reply'])).toEqual([
      ['user', 'Need an electrician tomorrow'],
      ['assistant', 'reply'],
      ['user', 'In DHA please'],
      ['assistant', 'reply'],
    ]);
    const times = body.data.map((m: { createdAt: string }) => m.createdAt);
    expect([...times].sort()).toEqual(times);
  });

  it('sends the prior turns and the memory context as input, never system instructions (§3.3)', async () => {
    const id = await startConversation(session);
    aiControl.output = envelope('First reply');
    await sendTurn(session, id, 'Hello');
    await sendTurn(session, id, 'Again');
    const input = JSON.parse(aiControl.calls.at(-1)!.input);
    expect(Object.keys(input).sort()).toEqual(['memory', 'turns']);
    expect(input.turns).toEqual([
      { role: 'user', body: 'Hello' },
      { role: 'assistant', body: 'First reply' },
      { role: 'user', body: 'Again' },
    ]);
  });

  it('a conversation turn never creates or changes a memory entry, even when a proposal comes back (AC-2)', async () => {
    const id = await startConversation(session);
    aiControl.output = envelope('I can remember that.', { key: 'language', value: { language: 'ur-Latn' } });
    const res = await sendTurn(session, id, 'Please reply in Roman Urdu');
    const reply = (await json(res)).data;
    expect(reply.memoryProposal).toEqual({ key: 'language', value: { language: 'ur-Latn' }, valueSummary: 'Roman Urdu' });
    expect((await aiRowCounts(session.userId)).memories).toBe(0);
  });

  it('a replay returns the original reply with 200, stores nothing twice and spends no AI call; a changed body is 409', async () => {
    const id = await startConversation(session);
    const key = freshKey();
    const first = await json(await sendTurn(session, id, 'Same question', key));
    const callsAfterFirst = aiControl.calls.length;

    const replay = await sendTurn(session, id, 'Same question', key);
    expect(replay.status).toBe(200);
    expect((await json(replay)).data.id).toBe(first.data.id);
    expect(aiControl.calls.length).toBe(callsAfterFirst);

    const conflict = await sendTurn(session, id, 'A different question', key);
    expect(conflict.status).toBe(409);
    expect((await json(conflict)).code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    expect((await aiRowCounts(session.userId)).messages).toBe(2);
  });

  it('a degraded turn stores nothing, and a retry with the same key re-attempts cleanly (§3.3 step 4)', async () => {
    const id = await startConversation(session);
    aiControl.error = new AiQuotaExceededError();
    const key = freshKey();
    const degraded = await sendTurn(session, id, 'Hello?', key);
    aiControl.error = null;
    expect(degraded.status).toBe(429);
    expect((await json(degraded)).code).toBe('AI_QUOTA_EXCEEDED');
    expect((await aiRowCounts(session.userId)).messages).toBe(0);

    const retried = await sendTurn(session, id, 'Hello?', key);
    expect(retried.status).toBe(201);
    expect((await aiRowCounts(session.userId)).messages).toBe(2);
  });

  it('validates the turn body: required, non-blank, at most the message-body limit', async () => {
    const id = await startConversation(session);
    for (const body of [{}, { body: '' }, { body: '   ' }, { body: 'x'.repeat(2001) }, { body: 'hi', extra: 1 }]) {
      const res = await SEND(
        aiRequest(`${BASE}/ai/conversations/${id}/messages`, session, { method: 'POST', body, idempotencyKey: freshKey() }),
      );
      expect(res.status).toBe(400);
    }
    expect((await aiRowCounts(session.userId)).messages).toBe(0);
  });

  it('search matches own messages only, case-insensitively, and treats % and _ literally', async () => {
    const id = await startConversation(session);
    await sendTurn(session, id, 'Looking for a PLUMBER in Gulberg');
    await startConversation(session);
    const stranger = await registerAndLogin();
    const theirs = await startConversation(stranger);
    await sendTurn(stranger, theirs, 'plumber for me too');

    const found = await json(await LIST(aiRequest(`${BASE}/ai/conversations?q=plumber`, session)));
    expect(found.data.map((c: { id: string }) => c.id)).toEqual([id]);
    expect(found.data[0].preview).toBe('Looking for a PLUMBER in Gulberg');

    const wildcard = await json(await LIST(aiRequest(`${BASE}/ai/conversations?q=%25`, session)));
    expect(wildcard.data).toEqual([]);

    const tooLong = await LIST(aiRequest(`${BASE}/ai/conversations?q=${'a'.repeat(2001)}`, session));
    expect(tooLong.status).toBe(400);
  });

  it('lists own non-deleted conversations, most recently updated first', async () => {
    const older = await startConversation(session);
    const newer = await startConversation(session);
    await sendTurn(session, older, 'bump');
    const list = await json(await LIST(aiRequest(`${BASE}/ai/conversations`, session)));
    expect(list.data.map((c: { id: string }) => c.id)).toEqual([older, newer]);
    expect(list.page.total).toBe(2);
  });

  it('delete removes messages and keeps activity and memory (AC-8)', async () => {
    const executor = useTestExecutor();
    executor.proposal = action({ riskTier: 'low', actionType: 'search_providers' });
    const id = await startConversation(session);
    await sendTurn(session, id, 'Find me a plumber');
    await getDb().execute(
      sql`INSERT INTO ai_memories (user_id, key, value) VALUES (${session.userId}, 'language', '{"language":"en"}'::jsonb)`,
    );

    const res = await DELETE_ONE(aiRequest(`${BASE}/ai/conversations/${id}`, session, { method: 'DELETE' }));
    expect(res.status).toBe(204);
    expect(await aiRowCounts(session.userId)).toEqual({ conversations: 1, messages: 0, memories: 1, actions: 1 });
    const [row] = await queryRows<{ deleted_at: Date | null }>(getDb(), sql`SELECT deleted_at FROM ai_conversations WHERE id = ${id}`);
    expect(row!.deleted_at).not.toBeNull();

    expect((await transcript(session, id)).status).toBe(404);
    expect((await DELETE_ONE(aiRequest(`${BASE}/ai/conversations/${id}`, session, { method: 'DELETE' }))).status).toBe(404);
    expect((await sendTurn(session, id, 'still there?')).status).toBe(404);
  });

  it('clear history tombstones every conversation and deletes their messages, keeping memory (AC-8)', async () => {
    const a = await startConversation(session);
    const b = await startConversation(session);
    await sendTurn(session, a, 'one');
    await sendTurn(session, b, 'two');
    await getDb().execute(
      sql`INSERT INTO ai_memories (user_id, key, value) VALUES (${session.userId}, 'language', '{"language":"ur"}'::jsonb)`,
    );

    const res = await CLEAR(aiRequest(`${BASE}/ai/conversations`, session, { method: 'DELETE' }));
    expect(res.status).toBe(204);
    const counts = await aiRowCounts(session.userId);
    expect(counts.messages).toBe(0);
    expect(counts.memories).toBe(1);
    expect((await json(await LIST(aiRequest(`${BASE}/ai/conversations`, session)))).data).toEqual([]);
    // Clearing an already-empty history is still a success.
    expect((await CLEAR(aiRequest(`${BASE}/ai/conversations`, session, { method: 'DELETE' }))).status).toBe(204);
  });

  it('a non-owner gets the same 404 as a missing conversation, for every conversation route', async () => {
    const id = await startConversation(session);
    await sendTurn(session, id, 'mine');
    const stranger = await registerAndLogin();
    expect((await transcript(stranger, id)).status).toBe(404);
    expect((await sendTurn(stranger, id, 'hijack')).status).toBe(404);
    expect((await DELETE_ONE(aiRequest(`${BASE}/ai/conversations/${id}`, stranger, { method: 'DELETE' }))).status).toBe(404);
    expect((await transcript(session, 'not-a-uuid')).status).toBe(404);
    expect((await aiRowCounts(session.userId)).messages).toBe(2);
  });

  it('starting a conversation is idempotent (replay 200) and takes an empty body only', async () => {
    const key = freshKey();
    const first = await CREATE(aiRequest(`${BASE}/ai/conversations`, session, { method: 'POST', body: {}, idempotencyKey: key }));
    const replay = await CREATE(aiRequest(`${BASE}/ai/conversations`, session, { method: 'POST', body: {}, idempotencyKey: key }));
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect((await json(replay)).data.id).toBe((await json(first)).data.id);
    const changed = await CREATE(aiRequest(`${BASE}/ai/conversations`, session, { method: 'POST', body: { x: 1 }, idempotencyKey: key }));
    expect(changed.status).toBe(400);
    expect((await aiRowCounts(session.userId)).conversations).toBe(1);
  });
});
