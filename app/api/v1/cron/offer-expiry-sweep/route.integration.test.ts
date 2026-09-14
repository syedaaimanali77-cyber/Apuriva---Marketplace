import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it } from 'vitest';
import { GET } from './route';

/**
 * Spec 018 §3 "Background expiry" — cron authentication only. The authorized path actually runs the
 * sweep, so it is tested in lib/offers/expiry-sweep.integration.test.ts with every other sweep-running
 * test (suites share one test database). No database is touched here: a rejected call never sweeps.
 */
describe('GET /api/v1/cron/offer-expiry-sweep auth (spec 018 AC-3)', () => {
  const previous = process.env.CRON_SECRET;

  afterEach(() => {
    process.env.CRON_SECRET = previous;
  });

  it('rejects a missing or wrong CRON_SECRET with 401', async () => {
    process.env.CRON_SECRET = 'expected-secret';
    const missing = await GET(new NextRequest('http://localhost/api/v1/cron/offer-expiry-sweep'));
    expect(missing.status).toBe(401);

    const wrong = await GET(
      new NextRequest('http://localhost/api/v1/cron/offer-expiry-sweep', { headers: { authorization: 'Bearer nope' } }),
    );
    expect(wrong.status).toBe(401);
    expect((await wrong.json()).error.code).toBe('UNAUTHORIZED');
  });

  it('rejects every call when CRON_SECRET is not configured', async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(
      new NextRequest('http://localhost/api/v1/cron/offer-expiry-sweep', { headers: { authorization: 'Bearer undefined' } }),
    );
    expect(res.status).toBe(401);
  });
});
