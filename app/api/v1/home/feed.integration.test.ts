import { describe, expect, it, beforeEach } from 'vitest';
import { getPool } from '@/lib/db';
import { GET as getHome } from './route';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import {
  authenticatedRequest,
  createCategory,
  createProviderProfile,
  createService,
  isDatabaseReachable,
  linkProviderService,
  registerAndLogin,
} from '@/app/api/v1/search/search-test-support';

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('GET /api/v1/home (spec 014, integration)', () => {
  beforeEach(() => {
    resetRateLimitState();
  });

  it('AC-1: a guest gets curated_popular content, never an empty screen', async () => {
    const categoryId = await createCategory();
    const serviceId = await createService(categoryId, { name: 'Guest Curated Service' });
    const { providerProfileId } = await createProviderProfile();
    await linkProviderService(providerProfileId, serviceId);

    const res = await getHome(new Request('http://localhost/api/v1/home'));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.activeBooking).toBeUndefined();
    expect(data.sections).toHaveLength(1);
    expect(data.sections[0].type).toBe('curated_popular');
    expect(data.sections[0].items.length).toBeGreaterThan(0);
  });

  it('AC-1: a new logged-in user (no RecentSearch rows) gets curated_popular', async () => {
    const user = await registerAndLogin();
    const categoryId = await createCategory();
    const serviceId = await createService(categoryId, { name: 'New User Curated Service' });
    const { providerProfileId } = await createProviderProfile();
    await linkProviderService(providerProfileId, serviceId);

    const res = await getHome(
      authenticatedRequest('http://localhost/api/v1/home', user.sessionId, user.csrfToken, { method: 'GET' }),
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.sections[0].type).toBe('curated_popular');
  });

  it('AC-2: a returning user (has a RecentSearch row) gets recent_relevant sourced from it', async () => {
    const user = await registerAndLogin();
    const categoryId = await createCategory();
    const serviceId = await createService(categoryId, { name: 'Recently Searched Plumbing' });
    const { providerProfileId } = await createProviderProfile({ businessName: 'Recent Provider' });
    await linkProviderService(providerProfileId, serviceId);
    await getPool().query('INSERT INTO recent_searches (user_id, service_id) VALUES ($1, $2)', [user.userId, serviceId]);

    const res = await getHome(
      authenticatedRequest('http://localhost/api/v1/home', user.sessionId, user.csrfToken, { method: 'GET' }),
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.sections[0]).toMatchObject({ type: 'recent_relevant', reason: 'Based on your recent searches' });
    expect(data.sections[0].items[0]).toMatchObject({ serviceId, providerId: providerProfileId });
  });

  it('never includes a saved_providers section — no owning entity exists yet (§8 risk 2)', async () => {
    const res = await getHome(new Request('http://localhost/api/v1/home'));
    const { data } = await res.json();
    expect(data.sections.some((s: { type: string }) => s.type === 'saved_providers')).toBe(false);
  });

  it('AC-7: personalization opt-out falls back to curated_popular even with recent-search history', async () => {
    const user = await registerAndLogin();
    const categoryId = await createCategory();
    const serviceId = await createService(categoryId, { name: 'Opted Out Service' });
    const { providerProfileId } = await createProviderProfile();
    await linkProviderService(providerProfileId, serviceId);
    await getPool().query('INSERT INTO recent_searches (user_id, service_id) VALUES ($1, $2)', [user.userId, serviceId]);
    await getPool().query('UPDATE customer_profiles SET personalization_enabled = false WHERE user_id = $1', [user.userId]);

    const res = await getHome(
      authenticatedRequest('http://localhost/api/v1/home', user.sessionId, user.csrfToken, { method: 'GET' }),
    );
    const { data } = await res.json();
    expect(data.sections[0].type).toBe('curated_popular');
  });

  it('rate-limits repeated calls under the home domain', async () => {
    let lastStatus = 200;
    for (let i = 0; i < 61; i++) {
      const res = await getHome(new Request('http://localhost/api/v1/home', { headers: { 'x-forwarded-for': '203.0.113.10' } }));
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});
