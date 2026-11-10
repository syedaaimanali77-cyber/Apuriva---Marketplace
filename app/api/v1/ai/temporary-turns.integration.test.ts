/**
 * Spec 034 §3.2/§3.11 route guards for `POST /ai/temporary-turns`: session (guest `401`), CSRF, NO
 * `Idempotency-Key`, `200` (it creates nothing), and `503` with either flag off.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  aiRequest,
  aiRowCounts,
  BASE,
  isDatabaseReachable,
  json,
  registerAndLogin,
  resetAiAssistantState,
  type TestSession,
} from '@/lib/ai-assistant/ai-assistant-test-support';

vi.mock('@/lib/ai', async () => (await import('@/lib/ai-assistant/ai-assistant-test-support')).aiModuleMock());

const { POST } = await import('./temporary-turns/route');

const dbReachable = await isDatabaseReachable();
const BODY = { turns: [{ role: 'user', body: 'Is this private?' }] };

describe.skipIf(!dbReachable)('spec 034 temporary-turn route (integration)', () => {
  let session: TestSession;

  beforeEach(async () => {
    resetAiAssistantState();
    session = await registerAndLogin();
  });

  afterAll(() => {
    delete process.env.AI_CONVERSATIONAL_ASSISTANT_ENABLED;
    resetAiAssistantState();
  });

  it('guest gets 401 (AC-12)', async () => {
    const res = await POST(aiRequest(`${BASE}/ai/temporary-turns`, null, { method: 'POST', body: BODY }));
    expect(res.status).toBe(401);
  });

  it('requires the CSRF token', async () => {
    const res = await POST(aiRequest(`${BASE}/ai/temporary-turns`, session, { method: 'POST', body: BODY, csrf: false }));
    expect(res.status).toBe(403);
  });

  it('takes no Idempotency-Key and returns 200 with only { role, body }', async () => {
    const res = await POST(aiRequest(`${BASE}/ai/temporary-turns`, session, { method: 'POST', body: BODY }));
    expect(res.status).toBe(200);
    expect(Object.keys((await json(res)).data).sort()).toEqual(['body', 'role']);
    expect(await aiRowCounts(session.userId)).toEqual({ conversations: 0, messages: 0, memories: 0, actions: 0 });
  });

  it('returns 503 with the Ask Apuriva flag off', async () => {
    process.env.AI_CONVERSATIONAL_ASSISTANT_ENABLED = 'false';
    try {
      const res = await POST(aiRequest(`${BASE}/ai/temporary-turns`, session, { method: 'POST', body: BODY }));
      expect(res.status).toBe(503);
      expect((await json(res)).code).toBe('AI_PROVIDER_UNAVAILABLE');
    } finally {
      delete process.env.AI_CONVERSATIONAL_ASSISTANT_ENABLED;
    }
  });
});
