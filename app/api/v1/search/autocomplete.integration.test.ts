import { describe, expect, it, beforeEach } from 'vitest';
import { GET as autocomplete } from './autocomplete/route';
import { POST as recordRecent } from './recent/route';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import {
  authenticatedRequest,
  createCategory,
  createProviderProfile,
  createService,
  isDatabaseReachable,
  linkProviderService,
  registerAndLogin,
} from './search-test-support';

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('GET /api/v1/search/autocomplete (spec 013 AC-2, integration)', () => {
  beforeEach(() => {
    resetRateLimitState();
  });

  it('returns no suggestions below the 2-character minimum', async () => {
    const res = await autocomplete(new Request('http://localhost/api/v1/search/autocomplete?q=e'));
    expect((await res.json()).data).toEqual([]);
  });

  it('a guest sees category/service/location suggestions but never a recent_search one', async () => {
    const categoryId = await createCategory({ name: 'Plumbing Zzzq' });
    const res = await autocomplete(new Request('http://localhost/api/v1/search/autocomplete?q=Plumbing%20Zzzq'));
    const { data } = await res.json();
    expect(data.some((s: { type: string }) => s.type === 'recent_search')).toBe(false);
    expect(data.some((s: { type: string; label: string }) => s.type === 'category' && s.label === 'Plumbing Zzzq')).toBe(true);
    void categoryId;
  });

  it("AC-2: a signed-in caller's own recent searches appear, another caller's never do", async () => {
    const owner = await registerAndLogin();
    const other = await registerAndLogin();

    await recordRecent(
      authenticatedRequest('http://localhost/api/v1/search/recent', owner.sessionId, owner.csrfToken, {
        method: 'POST',
        body: { q: 'unique-recent-query-zzz' },
      }),
    );

    const ownerRes = await autocomplete(
      authenticatedRequest('http://localhost/api/v1/search/autocomplete?q=unique-recent-query', owner.sessionId, owner.csrfToken, {
        method: 'GET',
      }),
    );
    const { data: ownerData } = await ownerRes.json();
    expect(ownerData.some((s: { type: string; label: string }) => s.type === 'recent_search' && s.label === 'unique-recent-query-zzz')).toBe(
      true,
    );

    const otherRes = await autocomplete(
      authenticatedRequest('http://localhost/api/v1/search/autocomplete?q=unique-recent-query', other.sessionId, other.csrfToken, {
        method: 'GET',
      }),
    );
    const { data: otherData } = await otherRes.json();
    expect(otherData.some((s: { type: string }) => s.type === 'recent_search')).toBe(false);
  });

  it('caps suggestions at 10 and deduplicates by (type, label)', async () => {
    const categoryId = await createCategory();
    for (let i = 0; i < 15; i++) {
      const serviceId = await createService(categoryId, { name: `Dedup Service ${i}` });
      const { providerProfileId } = await createProviderProfile();
      await linkProviderService(providerProfileId, serviceId);
    }
    const res = await autocomplete(new Request('http://localhost/api/v1/search/autocomplete?q=Dedup%20Service'));
    const { data } = await res.json();
    expect(data.length).toBeLessThanOrEqual(10);
    const keys = data.map((s: { type: string; label: string }) => `${s.type}:${s.label}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
