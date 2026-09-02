import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET } from './route';

describe('GET /api/v1/cron/sample', () => {
  const originalSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = 'test-cron-secret';
  });

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret;
  });

  it('rejects requests without a valid cron secret', async () => {
    const req = new NextRequest('http://localhost/api/v1/cron/sample');
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('fires the scheduled job when the request carries the correct cron secret', async () => {
    const req = new NextRequest('http://localhost/api/v1/cron/sample', {
      headers: { authorization: 'Bearer test-cron-secret' },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(typeof body.firedAt).toBe('string');
  });
});
