/** Spec 034 §3.2/§3.10 route guards for `GET /ai/suggestions`: session only, and never a write. */
import { beforeEach, describe, expect, it } from 'vitest';
import { aiRequest, BASE, isDatabaseReachable, json, registerAndLogin, resetAiAssistantState } from '@/lib/ai-assistant/ai-assistant-test-support';

const { GET } = await import('./suggestions/route');

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('spec 034 suggestions route (integration)', () => {
  beforeEach(() => resetAiAssistantState());

  it('guest gets 401 (AC-12)', async () => {
    expect((await GET(aiRequest(`${BASE}/ai/suggestions`, null))).status).toBe(401);
  });

  it('a signed-in user gets a 200 list (empty with nothing upcoming)', async () => {
    const res = await GET(aiRequest(`${BASE}/ai/suggestions`, await registerAndLogin()));
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual([]);
  });

  it('exports only GET: suggestions cannot be written or triggered', async () => {
    const route = await import('./suggestions/route');
    expect(Object.keys(route).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k))).toEqual(['GET']);
  });
});
