/**
 * Spec 034 §3.9 — AI memory end to end (AC-2, AC-3, AC-8, AC-13, AC-19): propose-then-confirm, the
 * closed allow-list enforced three times (envelope, route, database), view/delete/reset, and
 * independence from conversation history.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
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
  seedPublishedCategory,
  type TestSession,
} from './ai-assistant-test-support';

vi.mock('@/lib/ai', async () => (await import('./ai-assistant-test-support')).aiModuleMock());

const { POST: CREATE, DELETE: CLEAR } = await import('@/app/api/v1/ai/conversations/route');
const { DELETE: DELETE_CONVERSATION } = await import('@/app/api/v1/ai/conversations/[id]/route');
const { POST: SEND } = await import('@/app/api/v1/ai/conversations/[id]/messages/route');
const { GET: LIST_MEMORY, POST: CONFIRM_MEMORY, DELETE: RESET_MEMORY } = await import('@/app/api/v1/ai/memory/route');
const { DELETE: DELETE_MEMORY } = await import('@/app/api/v1/ai/memory/[id]/route');

const dbReachable = await isDatabaseReachable();

async function startConversation(session: TestSession): Promise<string> {
  const res = await CREATE(aiRequest(`${BASE}/ai/conversations`, session, { method: 'POST', body: {}, idempotencyKey: freshKey() }));
  return (await json(res)).data.id;
}

function confirm(session: TestSession, body: unknown) {
  return CONFIRM_MEMORY(aiRequest(`${BASE}/ai/memory`, session, { method: 'POST', body }));
}

async function memory(session: TestSession) {
  return (await json(await LIST_MEMORY(aiRequest(`${BASE}/ai/memory`, session)))).data as Array<Record<string, any>>;
}

describe.skipIf(!dbReachable)('spec 034 AI memory (integration)', () => {
  let session: TestSession;
  let conversationId: string;

  beforeEach(async () => {
    resetAiAssistantState();
    session = await registerAndLogin();
    conversationId = await startConversation(session);
  });

  afterAll(() => resetAiAssistantState());

  it('a proposal is not stored until confirmed; confirming stores exactly the proposed key and value (AC-13)', async () => {
    aiControl.output = envelope('Shall I remember that?', { key: 'preferred_area', value: { city: 'Lahore', area: 'DHA' } });
    const res = await SEND(
      aiRequest(`${BASE}/ai/conversations/${conversationId}/messages`, session, {
        method: 'POST',
        body: { body: 'I usually need help in DHA Lahore' },
        idempotencyKey: freshKey(),
      }),
    );
    const proposal = (await json(res)).data.memoryProposal;
    expect(proposal).toEqual({ key: 'preferred_area', value: { city: 'Lahore', area: 'DHA' }, valueSummary: 'DHA, Lahore' });
    expect(await memory(session)).toEqual([]);

    const confirmed = await confirm(session, { conversationId, key: proposal.key, value: proposal.value });
    expect(confirmed.status).toBe(201);
    const [item] = await memory(session);
    expect(item).toMatchObject({ key: 'preferred_area', value: { city: 'Lahore', area: 'DHA' }, valueSummary: 'DHA, Lahore' });
  });

  it('a typed "yes" in the conversation never saves anything — only the explicit request does', async () => {
    aiControl.output = envelope('Remember Urdu?', { key: 'language', value: { language: 'ur' } });
    for (const body of ['Reply in Urdu', 'yes', 'Yes, remember that']) {
      await SEND(
        aiRequest(`${BASE}/ai/conversations/${conversationId}/messages`, session, { method: 'POST', body: { body }, idempotencyKey: freshKey() }),
      );
    }
    expect((await aiRowCounts(session.userId)).memories).toBe(0);
  });

  it('a proposal for a draft (unpublished) category is dropped, so it is never shown', async () => {
    const draft = await seedPublishedCategory('draft');
    aiControl.output = envelope('OK', { key: 'preferred_category', value: { categoryId: draft.id } });
    const res = await SEND(
      aiRequest(`${BASE}/ai/conversations/${conversationId}/messages`, session, { method: 'POST', body: { body: 'plumbing' }, idempotencyKey: freshKey() }),
    );
    expect((await json(res)).data.memoryProposal).toBeUndefined();
  });

  it('a published category is remembered and rendered by name; an unpublished one is 400', async () => {
    const published = await seedPublishedCategory('published');
    const res = await confirm(session, { conversationId, key: 'preferred_category', value: { categoryId: published.id } });
    expect(res.status).toBe(201);
    expect((await memory(session))[0]!.valueSummary).toBe(published.name);

    const draft = await seedPublishedCategory('draft');
    expect((await confirm(session, { conversationId, key: 'preferred_category', value: { categoryId: draft.id } })).status).toBe(400);
  });

  it('rejects every key outside the allow-list with 400, including provider-characteristic and communication-preference keys (AC-19)', async () => {
    for (const key of ['preferred_provider_characteristics', 'communication_preferences', 'notes']) {
      const res = await confirm(session, { conversationId, key, value: { anything: 'x' } });
      expect(res.status).toBe(400);
      expect((await json(res)).code).toBe('VALIDATION_ERROR');
    }
    expect((await aiRowCounts(session.userId)).memories).toBe(0);
  });

  it('the database CHECK refuses a non-allow-listed key even if application validation were bypassed (AC-19)', async () => {
    await expect(
      getDb().execute(
        sql`INSERT INTO ai_memories (user_id, key, value) VALUES (${session.userId}, 'communication_preferences', '{"channel":"sms"}'::jsonb)`,
      ),
    ).rejects.toThrow();
    await expect(
      getDb().execute(
        sql`INSERT INTO ai_memories (user_id, key, value) VALUES (${session.userId}, 'preferred_provider_characteristics', '{}'::jsonb)`,
      ),
    ).rejects.toThrow();
  });

  it('rejects an invalid value for an allowed key, and unexpected body fields', async () => {
    for (const body of [
      { conversationId, key: 'preferred_area', value: { city: 'Lahore', street: '12 Main Blvd' } },
      { conversationId, key: 'language', value: { language: 'fr' } },
      { conversationId, key: 'language', value: { language: 'en' }, remember: true },
      { key: 'language', value: { language: 'en' } },
    ]) {
      expect((await confirm(session, body)).status).toBe(400);
    }
  });

  it('confirmation requires a stored, non-deleted conversation the caller owns — never a temporary one (AC-14)', async () => {
    const value = { language: 'en' };
    expect((await confirm(session, { conversationId: '00000000-0000-4000-8000-000000000000', key: 'language', value })).status).toBe(404);
    expect((await confirm(session, { conversationId: 'temporary', key: 'language', value })).status).toBe(404);

    const stranger = await registerAndLogin();
    expect((await confirm(stranger, { conversationId, key: 'language', value })).status).toBe(404);

    await DELETE_CONVERSATION(aiRequest(`${BASE}/ai/conversations/${conversationId}`, session, { method: 'DELETE' }));
    expect((await confirm(session, { conversationId, key: 'language', value })).status).toBe(404);
    expect((await aiRowCounts(session.userId)).memories).toBe(0);
  });

  it('a preference holds one value: re-confirming the same key replaces it with 200', async () => {
    expect((await confirm(session, { conversationId, key: 'language', value: { language: 'en' } })).status).toBe(201);
    expect((await confirm(session, { conversationId, key: 'language', value: { language: 'ur' } })).status).toBe(200);
    const items = await memory(session);
    expect(items).toHaveLength(1);
    expect(items[0]!.value).toEqual({ language: 'ur' });
    expect(items[0]!.valueSummary).toBe('Urdu');
  });

  it('delete and reset take effect in the same request (AC-3)', async () => {
    await confirm(session, { conversationId, key: 'language', value: { language: 'en' } });
    await confirm(session, { conversationId, key: 'preferred_area', value: { city: 'Karachi' } });
    const [first] = await memory(session);

    const deleted = await DELETE_MEMORY(aiRequest(`${BASE}/ai/memory/${first!.id}`, session, { method: 'DELETE' }));
    expect(deleted.status).toBe(204);
    expect(await memory(session)).toHaveLength(1);

    const reset = await RESET_MEMORY(aiRequest(`${BASE}/ai/memory`, session, { method: 'DELETE' }));
    expect(reset.status).toBe(204);
    expect(await memory(session)).toEqual([]);
  });

  it('memory is not someone else’s to delete: another user’s entry is 404', async () => {
    await confirm(session, { conversationId, key: 'language', value: { language: 'en' } });
    const [item] = await memory(session);
    const stranger = await registerAndLogin();
    expect((await DELETE_MEMORY(aiRequest(`${BASE}/ai/memory/${item!.id}`, stranger, { method: 'DELETE' }))).status).toBe(404);
    expect(await memory(session)).toHaveLength(1);
  });

  it('memory and history are independent: clearing history keeps memory, resetting memory keeps conversations (AC-8)', async () => {
    await confirm(session, { conversationId, key: 'language', value: { language: 'en' } });
    await CLEAR(aiRequest(`${BASE}/ai/conversations`, session, { method: 'DELETE' }));
    expect(await memory(session)).toHaveLength(1);

    const another = await startConversation(session);
    await RESET_MEMORY(aiRequest(`${BASE}/ai/memory`, session, { method: 'DELETE' }));
    const [row] = (await getDb().execute(sql`SELECT deleted_at FROM ai_conversations WHERE id = ${another}`)).rows as Array<{
      deleted_at: Date | null;
    }>;
    expect(row!.deleted_at).toBeNull();
  });

  it('memory is sent to the model as { key, valueSummary } context on the next turn', async () => {
    await confirm(session, { conversationId, key: 'preferred_area', value: { city: 'Lahore', area: 'DHA' } });
    await SEND(
      aiRequest(`${BASE}/ai/conversations/${conversationId}/messages`, session, { method: 'POST', body: { body: 'Hi' }, idempotencyKey: freshKey() }),
    );
    const input = JSON.parse(aiControl.calls.at(-1)!.input);
    expect(input.memory).toEqual([{ key: 'preferred_area', valueSummary: 'DHA, Lahore' }]);
  });
});
