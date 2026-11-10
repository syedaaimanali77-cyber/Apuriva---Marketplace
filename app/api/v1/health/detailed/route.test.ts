import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import type { DetailedHealthDto } from '@/lib/types/ops';

vi.mock('@/lib/ops/access', () => ({ canReadDetailedHealth: vi.fn(async () => true) }));
vi.mock('@/lib/ops/health', () => ({ buildDetailedHealth: vi.fn() }));

const access = await import('@/lib/ops/access');
const health = await import('@/lib/ops/health');
const { GET } = await import('./route');

const report = (status: DetailedHealthDto['status']): DetailedHealthDto => ({
  status,
  environment: 'production',
  version: '0.1.0',
  commit: null,
  checkedAt: '2026-09-28T12:00:00.000Z',
  dependencies: [{ name: 'database', status: status === 'down' ? 'down' : 'up' }],
});

const request = () => new Request('http://localhost/api/v1/health/detailed', { headers: { 'x-forwarded-for': '192.0.2.10' } });

describe('GET /api/v1/health/detailed status mapping (spec 046 AC-8)', () => {
  beforeEach(() => {
    resetRateLimitState();
    vi.mocked(access.canReadDetailedHealth).mockResolvedValue(true);
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  it.each([
    ['healthy', 200],
    ['degraded', 200],
    ['down', 503],
  ] as const)('%s → %i, same envelope body, never cached', async (status, http) => {
    vi.mocked(health.buildDetailedHealth).mockResolvedValue(report(status));
    const res = await GET(request());
    expect(res.status).toBe(http);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(body.data).toEqual(report(status));
    expect(typeof body.correlationId).toBe('string');
  });

  it('401 UNAUTHENTICATED without monitoring credentials, and builds no report', async () => {
    vi.mocked(access.canReadDetailedHealth).mockResolvedValue(false);
    vi.mocked(health.buildDetailedHealth).mockClear();
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('UNAUTHENTICATED');
    expect(health.buildDetailedHealth).not.toHaveBeenCalled();
  });

  it("429 RATE_LIMITED once the 'default' bucket (100/min) is exhausted", async () => {
    vi.mocked(health.buildDetailedHealth).mockResolvedValue(report('healthy'));
    for (let i = 0; i < 100; i += 1) expect((await GET(request())).status).toBe(200);
    const limited = await GET(request());
    expect(limited.status).toBe(429);
    expect((await limited.json()).code).toBe('RATE_LIMITED');
  });
});
