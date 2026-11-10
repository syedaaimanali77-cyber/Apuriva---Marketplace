/**
 * Spec 034 §3.2/§3.10 — `GET`/`PATCH /api/v1/users/me/ai-preferences`: default on, toggle persists,
 * validation, CSRF, guest `401`, and never gated by the assistant flag (a privacy control).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { aiRequest, BASE, isDatabaseReachable, json, registerAndLogin, resetAiAssistantState, type TestSession } from '@/lib/ai-assistant/ai-assistant-test-support';

const { GET, PATCH } = await import('./route');

const dbReachable = await isDatabaseReachable();
const URL = `${BASE}/users/me/ai-preferences`;

describe.skipIf(!dbReachable)('spec 034 AI preferences route (integration)', () => {
  let session: TestSession;

  beforeEach(async () => {
    resetAiAssistantState();
    session = await registerAndLogin();
  });

  afterAll(() => delete process.env.AI_CONVERSATIONAL_ASSISTANT_ENABLED);

  it('defaults to proactive suggestions on', async () => {
    expect((await json(await GET(aiRequest(URL, session)))).data).toEqual({ proactiveSuggestionsEnabled: true });
  });

  it('toggle persists', async () => {
    const res = await PATCH(aiRequest(URL, session, { method: 'PATCH', body: { proactiveSuggestionsEnabled: false } }));
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({ proactiveSuggestionsEnabled: false });
    expect((await json(await GET(aiRequest(URL, session)))).data).toEqual({ proactiveSuggestionsEnabled: false });
  });

  it('validates the body', async () => {
    for (const body of [{}, { proactiveSuggestionsEnabled: 'no' }, { proactiveSuggestionsEnabled: true, extra: 1 }]) {
      expect((await PATCH(aiRequest(URL, session, { method: 'PATCH', body }))).status).toBe(400);
    }
  });

  it('requires a session and, for PATCH, the CSRF token', async () => {
    expect((await GET(aiRequest(URL, null))).status).toBe(401);
    expect((await PATCH(aiRequest(URL, null, { method: 'PATCH', body: { proactiveSuggestionsEnabled: false } }))).status).toBe(401);
    expect((await PATCH(aiRequest(URL, session, { method: 'PATCH', body: { proactiveSuggestionsEnabled: false }, csrf: false }))).status).toBe(403);
  });

  it('keeps working with the assistant flag off', async () => {
    process.env.AI_CONVERSATIONAL_ASSISTANT_ENABLED = 'false';
    try {
      expect((await PATCH(aiRequest(URL, session, { method: 'PATCH', body: { proactiveSuggestionsEnabled: false } }))).status).toBe(200);
    } finally {
      delete process.env.AI_CONVERSATIONAL_ASSISTANT_ENABLED;
    }
  });
});
