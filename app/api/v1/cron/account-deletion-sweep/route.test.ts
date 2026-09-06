import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { isDatabaseReachable } from '@/lib/db/test-support';
import { seedUser } from '@/lib/privacy/test-support';
import { GET } from './route';

const dbReachable = await isDatabaseReachable();

describe('GET /api/v1/cron/account-deletion-sweep', () => {
  const originalSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = 'test-cron-secret';
  });

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret;
  });

  it('rejects requests without a valid cron secret', async () => {
    const req = new NextRequest('http://localhost/api/v1/cron/account-deletion-sweep');
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it.skipIf(!dbReachable)('fires the sweep and anonymizes an account past its grace period', async () => {
    const userId = await seedUser();
    await getDb()
      .update(users)
      .set({ lifecycleStatus: 'deletion_pending', deletionGraceEndsAt: new Date(Date.now() - 1000) })
      .where(eq(users.id, userId));

    const req = new NextRequest('http://localhost/api/v1/cron/account-deletion-sweep', {
      headers: { authorization: 'Bearer test-cron-secret' },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.processed).toBeGreaterThanOrEqual(1);

    const [row] = await getDb().select().from(users).where(eq(users.id, userId));
    expect(row!.lifecycleStatus).toBe('deleted');
  });
});
