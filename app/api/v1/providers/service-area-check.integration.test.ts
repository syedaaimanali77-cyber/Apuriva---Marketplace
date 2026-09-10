import { describe, expect, it, beforeEach } from 'vitest';
import { GET as serviceAreaCheck } from './[id]/service-area-check/route';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { getPool } from '@/lib/db';
import { isDatabaseReachable } from '../location/location-test-support';

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('GET /api/v1/providers/{id}/service-area-check (spec 012 AC-5, integration)', () => {
  beforeEach(() => {
    resetRateLimitState();
  });

  async function seedProviderProfile(): Promise<string> {
    const client = await getPool().connect();
    try {
      const { rows: userRows } = await client.query<{ id: string }>('INSERT INTO users DEFAULT VALUES RETURNING id');
      const { rows: providerRows } = await client.query<{ id: string }>(
        'INSERT INTO provider_profiles (user_id) VALUES ($1) RETURNING id',
        [userRows[0]!.id],
      );
      return providerRows[0]!.id;
    } finally {
      client.release();
    }
  }

  it('excludes nothing for a provider with no declared service area configured yet (spec 016 dependency)', async () => {
    const providerId = await seedProviderProfile();
    const res = await serviceAreaCheck(
      new Request(`http://localhost/api/v1/providers/${providerId}/service-area-check?lat=31.5204&lng=74.3587`),
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.inServiceArea).toBe(true);
  });

  it('never returns the provider\'s own coordinates', async () => {
    const providerId = await seedProviderProfile();
    const res = await serviceAreaCheck(
      new Request(`http://localhost/api/v1/providers/${providerId}/service-area-check?lat=31.5204&lng=74.3587`),
    );
    const { data } = await res.json();
    expect(data.latitude).toBeUndefined();
    expect(data.longitude).toBeUndefined();
  });

  it('404s for a nonexistent provider', async () => {
    const res = await serviceAreaCheck(
      new Request('http://localhost/api/v1/providers/00000000-0000-0000-0000-000000000000/service-area-check?lat=31.5&lng=74.3'),
    );
    expect(res.status).toBe(404);
  });

  it('400s for missing/invalid lat/lng query parameters', async () => {
    const providerId = await seedProviderProfile();
    const res = await serviceAreaCheck(new Request(`http://localhost/api/v1/providers/${providerId}/service-area-check`));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
  });
});
