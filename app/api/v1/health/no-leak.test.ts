import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({
  getPool: () => ({
    query: async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:5432 (password authentication failed for user "apuriva")');
    },
  }),
}));

const { GET } = await import('./route');

/**
 * Spec 046 X-1 — `GET /api/v1/health` keeps spec 001's liveness contract (200 while the process
 * serves, `db.connected` reported in the body) but no longer returns the database error text to an
 * anonymous caller; the detail goes to the platform log as `health.db_unreachable`.
 */
describe('GET /api/v1/health with the database down (spec 046 X-1)', () => {
  it('still answers 200 with db.connected false, and leaks no error detail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.db).toEqual({ connected: false, latencyMs: null });
    expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|password|apuriva/);

    const logged = warn.mock.calls.map(([line]) => JSON.parse(String(line)) as { event: string; error: string });
    expect(logged).toEqual([expect.objectContaining({ event: 'health.db_unreachable' })]);
    expect(logged[0]!.error).toContain('ECONNREFUSED');
    warn.mockRestore();
  });
});
