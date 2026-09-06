import { NextRequest } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isDatabaseReachable } from '@/lib/db/test-support';
import { requestExport } from '@/lib/privacy/export';
import { registerTestFileAssetStorage, seedUser } from '@/lib/privacy/test-support';
import { GET } from './route';

const dbReachable = await isDatabaseReachable();

describe('GET /api/v1/cron/data-export-sweep', () => {
  const originalSecret = process.env.CRON_SECRET;

  // Test double standing in for spec 027's not-yet-implemented FileAsset storage capability —
  // spec 008's sweep depends on it rather than implementing one itself.
  beforeAll(() => {
    registerTestFileAssetStorage();
  });

  beforeEach(() => {
    process.env.CRON_SECRET = 'test-cron-secret';
  });

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret;
  });

  it('rejects requests without a valid cron secret', async () => {
    const req = new NextRequest('http://localhost/api/v1/cron/data-export-sweep');
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it.skipIf(!dbReachable)('fires the sweep and processes a pending export when the secret is correct', async () => {
    const userId = await seedUser();
    await requestExport(userId);

    const req = new NextRequest('http://localhost/api/v1/cron/data-export-sweep', {
      headers: { authorization: 'Bearer test-cron-secret' },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.processed).toBeGreaterThanOrEqual(1);
  });
});
