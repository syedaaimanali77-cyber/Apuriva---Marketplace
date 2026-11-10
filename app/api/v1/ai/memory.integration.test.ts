/**
 * Spec 034 §3.2/§3.9 route guards for memory: session, CSRF, guest `401`, the closed allow-list at
 * the route (AC-19), `201`/`200`, and privacy rights that survive the flag being off.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  aiRequest,
  aiRowCounts,
  BASE,
  freshKey,
  isDatabaseReachable,
  json,
  registerAndLogin,
  resetAiAssistantState,
  type TestSession,
} from '@/lib/ai-assistant/ai-assistant-test-support';

vi.mock('@/lib/ai', async () => (await import('@/lib/ai-assistant/ai-assistant-test-support')).aiModuleMock());

const conversations = await import('./conversations/route');
const memory = await import('./memory/route');
const memoryOne = await import('./memory/[id]/route');

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('spec 034 memory routes (integration)', () => {
  let session: TestSession;
  let conversationId: string;

  beforeEach(async () => {
    resetAiAssistantState();
    session = await registerAndLogin();
    const res = await conversations.POST(aiRequest(`${BASE}/ai/conversations`, session, { method: 'POST', body: {}, idempotencyKey: freshKey() }));
    conversationId = (await json(res)).data.id;
  });

  afterAll(() => {
    delete process.env.AI_CONVERSATIONAL_ASSISTANT_ENABLED;
    resetAiAssistantState();
  });

  it('guest gets 401 and nothing is stored, on every memory route', async () => {
    for (const res of await Promise.all([
      memory.GET(aiRequest(`${BASE}/ai/memory`, null)),
      memory.POST(aiRequest(`${BASE}/ai/memory`, null, { method: 'POST', body: { conversationId, key: 'language', value: { language: 'en' } } })),
      memory.DELETE(aiRequest(`${BASE}/ai/memory`, null, { method: 'DELETE' })),
      memoryOne.DELETE(aiRequest(`${BASE}/ai/memory/${conversationId}`, null, { method: 'DELETE' })),
    ])) {
      expect(res.status).toBe(401);
    }
    expect((await aiRowCounts(session.userId)).memories).toBe(0);
  });

  it('confirm, delete and reset require the CSRF token', async () => {
    for (const res of await Promise.all([
      memory.POST(aiRequest(`${BASE}/ai/memory`, session, { method: 'POST', body: { conversationId, key: 'language', value: { language: 'en' } }, csrf: false })),
      memory.DELETE(aiRequest(`${BASE}/ai/memory`, session, { method: 'DELETE', csrf: false })),
      memoryOne.DELETE(aiRequest(`${BASE}/ai/memory/${conversationId}`, session, { method: 'DELETE', csrf: false })),
    ])) {
      expect(res.status).toBe(403);
    }
  });

  it('a non-allow-listed key is 400 at the route (AC-19)', async () => {
    for (const key of ['preferred_provider_characteristics', 'communication_preferences']) {
      const res = await memory.POST(aiRequest(`${BASE}/ai/memory`, session, { method: 'POST', body: { conversationId, key, value: {} } }));
      expect(res.status).toBe(400);
    }
  });

  it('201 on a new key, 200 when the key already existed; takes no Idempotency-Key', async () => {
    const body = { conversationId, key: 'language', value: { language: 'en' } };
    expect((await memory.POST(aiRequest(`${BASE}/ai/memory`, session, { method: 'POST', body }))).status).toBe(201);
    expect((await memory.POST(aiRequest(`${BASE}/ai/memory`, session, { method: 'POST', body }))).status).toBe(200);
    expect((await aiRowCounts(session.userId)).memories).toBe(1);
  });

  it('with the flag off, confirming is 503 but view, delete and reset still work', async () => {
    await memory.POST(aiRequest(`${BASE}/ai/memory`, session, { method: 'POST', body: { conversationId, key: 'language', value: { language: 'en' } } }));
    process.env.AI_CONVERSATIONAL_ASSISTANT_ENABLED = 'false';
    try {
      const confirmed = await memory.POST(
        aiRequest(`${BASE}/ai/memory`, session, { method: 'POST', body: { conversationId, key: 'preferred_area', value: { city: 'Lahore' } } }),
      );
      expect(confirmed.status).toBe(503);
      const list = await json(await memory.GET(aiRequest(`${BASE}/ai/memory`, session)));
      expect(list.data).toHaveLength(1);
      expect((await memoryOne.DELETE(aiRequest(`${BASE}/ai/memory/${list.data[0].id}`, session, { method: 'DELETE' }))).status).toBe(204);
      expect((await memory.DELETE(aiRequest(`${BASE}/ai/memory`, session, { method: 'DELETE' }))).status).toBe(204);
    } finally {
      delete process.env.AI_CONVERSATIONAL_ASSISTANT_ENABLED;
    }
  });

  it('confirmation without a stored conversation is 404', async () => {
    const res = await memory.POST(
      aiRequest(`${BASE}/ai/memory`, session, { method: 'POST', body: { conversationId: 'temporary', key: 'language', value: { language: 'en' } } }),
    );
    expect(res.status).toBe(404);
  });
});
