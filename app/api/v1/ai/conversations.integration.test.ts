/**
 * Spec 034 §3.2 route guards for the conversation routes: session, CSRF, `Idempotency-Key`, guest
 * `401` (AC-12), non-owner `404`, `201`/`200` replay, and the flag: creating routes `503` while reads
 * and deletes keep working (§9 — privacy rights are never flag-gated).
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
const one = await import('./conversations/[id]/route');
const messages = await import('./conversations/[id]/messages/route');
const confirm = await import('./conversations/[id]/confirm/route');
const activity = await import('./activity/route');

const dbReachable = await isDatabaseReachable();
const SOME_ID = '00000000-0000-4000-8000-000000000001';

describe.skipIf(!dbReachable)('spec 034 conversation routes (integration)', () => {
  let session: TestSession;

  beforeEach(async () => {
    resetAiAssistantState();
    session = await registerAndLogin();
  });

  afterAll(() => {
    delete process.env.AI_CONVERSATIONAL_ASSISTANT_ENABLED;
    delete process.env.AI_ASSISTANT_ENABLED;
    resetAiAssistantState();
  });

  it('guest gets 401 and nothing is stored, on every route (AC-12)', async () => {
    const calls: Array<Promise<Response>> = [
      conversations.POST(aiRequest(`${BASE}/ai/conversations`, null, { method: 'POST', body: {}, idempotencyKey: freshKey() })),
      conversations.GET(aiRequest(`${BASE}/ai/conversations`, null)),
      conversations.DELETE(aiRequest(`${BASE}/ai/conversations`, null, { method: 'DELETE' })),
      one.DELETE(aiRequest(`${BASE}/ai/conversations/${SOME_ID}`, null, { method: 'DELETE' })),
      messages.GET(aiRequest(`${BASE}/ai/conversations/${SOME_ID}/messages`, null)),
      messages.POST(aiRequest(`${BASE}/ai/conversations/${SOME_ID}/messages`, null, { method: 'POST', body: { body: 'hi' }, idempotencyKey: freshKey() })),
      confirm.POST(aiRequest(`${BASE}/ai/conversations/${SOME_ID}/confirm`, null, { method: 'POST', body: { confirmationId: 'x' }, idempotencyKey: freshKey() })),
      activity.GET(aiRequest(`${BASE}/ai/activity`, null)),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.status).toBe(401);
      expect((await json(res)).code).toBe('UNAUTHENTICATED');
    }
  });

  it('state-changing routes require the CSRF token', async () => {
    const noCsrf = { csrf: false } as const;
    const responses = await Promise.all([
      conversations.POST(aiRequest(`${BASE}/ai/conversations`, session, { method: 'POST', body: {}, idempotencyKey: freshKey(), ...noCsrf })),
      conversations.DELETE(aiRequest(`${BASE}/ai/conversations`, session, { method: 'DELETE', ...noCsrf })),
      one.DELETE(aiRequest(`${BASE}/ai/conversations/${SOME_ID}`, session, { method: 'DELETE', ...noCsrf })),
      messages.POST(
        aiRequest(`${BASE}/ai/conversations/${SOME_ID}/messages`, session, { method: 'POST', body: { body: 'hi' }, idempotencyKey: freshKey(), ...noCsrf }),
      ),
      confirm.POST(
        aiRequest(`${BASE}/ai/conversations/${SOME_ID}/confirm`, session, { method: 'POST', body: { confirmationId: 'x' }, idempotencyKey: freshKey(), ...noCsrf }),
      ),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(403);
      expect((await json(res)).code).toBe('CSRF_TOKEN_INVALID');
    }
    expect((await aiRowCounts(session.userId)).conversations).toBe(0);
  });

  it('the three creating POSTs require an Idempotency-Key', async () => {
    const created = await conversations.POST(aiRequest(`${BASE}/ai/conversations`, session, { method: 'POST', body: {}, idempotencyKey: freshKey() }));
    const id = (await json(created)).data.id;
    for (const res of await Promise.all([
      conversations.POST(aiRequest(`${BASE}/ai/conversations`, session, { method: 'POST', body: {} })),
      messages.POST(aiRequest(`${BASE}/ai/conversations/${id}/messages`, session, { method: 'POST', body: { body: 'hi' } })),
      confirm.POST(aiRequest(`${BASE}/ai/conversations/${id}/confirm`, session, { method: 'POST', body: { confirmationId: 'x' } })),
    ])) {
      expect(res.status).toBe(400);
      expect((await json(res)).errors[0].field).toBe('Idempotency-Key');
    }
  });

  it('201 on creation, 200 with the original on replay', async () => {
    const key = freshKey();
    const first = await conversations.POST(aiRequest(`${BASE}/ai/conversations`, session, { method: 'POST', body: {}, idempotencyKey: key }));
    const again = await conversations.POST(aiRequest(`${BASE}/ai/conversations`, session, { method: 'POST', body: {}, idempotencyKey: key }));
    expect([first.status, again.status]).toEqual([201, 200]);
    expect((await json(again)).data.id).toBe((await json(first)).data.id);
  });

  it('non-owner gets 404', async () => {
    const created = await conversations.POST(aiRequest(`${BASE}/ai/conversations`, session, { method: 'POST', body: {}, idempotencyKey: freshKey() }));
    const id = (await json(created)).data.id;
    const stranger = await registerAndLogin();
    expect((await messages.GET(aiRequest(`${BASE}/ai/conversations/${id}/messages`, stranger))).status).toBe(404);
    expect((await one.DELETE(aiRequest(`${BASE}/ai/conversations/${id}`, stranger, { method: 'DELETE' }))).status).toBe(404);
  });

  it.each([
    ['AI_CONVERSATIONAL_ASSISTANT_ENABLED', 'the Ask Apuriva flag'],
    ['AI_ASSISTANT_ENABLED', "spec 033's platform kill switch"],
  ])('with %s off (%s), creating routes return 503 while reads and deletes still work', async (variable) => {
    const created = await conversations.POST(aiRequest(`${BASE}/ai/conversations`, session, { method: 'POST', body: {}, idempotencyKey: freshKey() }));
    const id = (await json(created)).data.id;
    await messages.POST(aiRequest(`${BASE}/ai/conversations/${id}/messages`, session, { method: 'POST', body: { body: 'before' }, idempotencyKey: freshKey() }));

    process.env[variable] = 'false';
    try {
      for (const res of await Promise.all([
        conversations.POST(aiRequest(`${BASE}/ai/conversations`, session, { method: 'POST', body: {}, idempotencyKey: freshKey() })),
        messages.POST(aiRequest(`${BASE}/ai/conversations/${id}/messages`, session, { method: 'POST', body: { body: 'hi' }, idempotencyKey: freshKey() })),
        confirm.POST(aiRequest(`${BASE}/ai/conversations/${id}/confirm`, session, { method: 'POST', body: { confirmationId: 'x' }, idempotencyKey: freshKey() })),
      ])) {
        expect(res.status).toBe(503);
        expect((await json(res)).code).toBe('AI_PROVIDER_UNAVAILABLE');
      }
      expect((await conversations.GET(aiRequest(`${BASE}/ai/conversations?q=before`, session))).status).toBe(200);
      expect((await messages.GET(aiRequest(`${BASE}/ai/conversations/${id}/messages`, session))).status).toBe(200);
      expect((await activity.GET(aiRequest(`${BASE}/ai/activity`, session))).status).toBe(200);
      expect((await one.DELETE(aiRequest(`${BASE}/ai/conversations/${id}`, session, { method: 'DELETE' }))).status).toBe(204);
      expect((await conversations.DELETE(aiRequest(`${BASE}/ai/conversations`, session, { method: 'DELETE' }))).status).toBe(204);
    } finally {
      delete process.env[variable];
    }
  });
});
