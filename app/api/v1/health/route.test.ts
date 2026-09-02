import { afterAll, describe, expect, it } from 'vitest';
import { GET } from './route';
import { getPool } from '@/lib/db';

describe('GET /api/v1/health', () => {
  afterAll(async () => {
    await getPool().end();
  });

  it('responds 200 with process/build status, even when the database is unreachable', async () => {
    const res = await GET();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(typeof body.version).toBe('string');
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(body.db).toBeDefined();
    expect(typeof body.db.connected).toBe('boolean');
  });
});
