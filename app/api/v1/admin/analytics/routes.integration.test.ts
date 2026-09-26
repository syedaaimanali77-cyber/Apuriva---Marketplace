import { NextRequest } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkRateLimit, resetRateLimitState } from '@/lib/api/rate-limit';
import { OPENAPI_ROUTES } from '@/lib/api/openapi-registry';
import { authenticatedRequest } from '@/app/api/v1/auth/test-support';
import { adminWithRole, isDatabaseReachable } from '@/lib/admin-dashboard/admin-dashboard-test-support';
import type { TestAdmin } from '@/app/api/v1/admin/admin-rbac-test-support';
import type {
  FunnelReportDto,
  MatchingFairnessDto,
  ProviderPerformanceDto,
  RetentionReportDto,
  RevenueReportDto,
  ServiceTrendsReportDto,
  SupplyDemandReportDto,
} from '@/lib/types/analytics';
import { GET as FUNNEL } from './funnel/route';
import { GET as REVENUE } from './revenue/route';
import { GET as SUPPLY_DEMAND } from './supply-demand/route';
import { GET as PROVIDER_PERFORMANCE } from './provider-performance/route';
import { GET as MATCHING_FAIRNESS } from './matching-fairness/route';
import { GET as RETENTION } from './retention/route';
import { GET as SERVICE_TRENDS } from './service-trends/route';
import { GET as RETENTION_SWEEP } from '@/app/api/v1/cron/analytics-retention-sweep/route';

const dbReachable = await isDatabaseReachable();
const BASE = 'http://localhost/api/v1/admin/analytics';

const HANDLERS = {
  funnel: FUNNEL,
  revenue: REVENUE,
  'supply-demand': SUPPLY_DEMAND,
  'provider-performance': PROVIDER_PERFORMANCE,
  'matching-fairness': MATCHING_FAIRNESS,
  retention: RETENTION,
  'service-trends': SERVICE_TRENDS,
} as const;

function get(admin: TestAdmin, url: string): Request {
  return authenticatedRequest(url, admin.sessionId, admin.csrfToken, { method: 'GET' });
}

describe('analytics routes in OpenAPI (spec 040 §3.5)', () => {
  it('registers exactly the seven GET reports — no write method, no ingestion endpoint, no cron', () => {
    const analytics = OPENAPI_ROUTES.filter((r) => r.path.startsWith('/admin/analytics') || r.path.startsWith('/analytics'));
    expect(analytics.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      Object.keys(HANDLERS)
        .map((name) => `GET /admin/analytics/${name}`)
        .sort(),
    );
    expect(OPENAPI_ROUTES.some((r) => r.path.includes('analytics-retention-sweep'))).toBe(false);
    expect(OPENAPI_ROUTES.some((r) => r.path === '/admin/ai/usage')).toBe(true); // AI usage is reused, not duplicated
  });
});

/** Spec 040 §3.5 — envelopes, ranges, paging, validation and rate limiting. */
describe.skipIf(!dbReachable)('analytics report routes (spec 040 §3.5)', { timeout: 120_000 }, () => {
  let admin: TestAdmin;

  beforeAll(async () => {
    admin = await adminWithRole('analytics_admin');
  });

  beforeEach(() => resetRateLimitState());

  it('each report returns the success envelope with its period; the default window is the last 30 days', async () => {
    const before = Date.now();
    const res = await FUNNEL(get(admin, `${BASE}/funnel`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: FunnelReportDto; correlationId: string };
    expect(typeof body.correlationId).toBe('string');
    expect(body.data.stages.map((s) => s.stage)).toEqual(['discover', 'request', 'offer', 'booking', 'complete']);
    const span = Date.parse(body.data.periodEnd) - Date.parse(body.data.periodStart);
    expect(span).toBe(30 * 86_400_000);
    expect(Date.parse(body.data.periodEnd)).toBeGreaterThanOrEqual(before - 1000);
  });

  it('an explicit range is echoed back; every single-object report carries its DTO shape', async () => {
    const q = 'from=2090-01-01&to=2090-02-01';
    const period = { periodStart: '2090-01-01T00:00:00.000Z', periodEnd: '2090-02-01T00:00:00.000Z' };
    const revenue = (await (await REVENUE(get(admin, `${BASE}/revenue?${q}`))).json()) as { data: RevenueReportDto };
    expect(revenue.data).toEqual({ currencies: [], ...period });
    const fairness = (await (await MATCHING_FAIRNESS(get(admin, `${BASE}/matching-fairness?${q}`))).json()) as { data: MatchingFairnessDto };
    expect(fairness.data).toMatchObject({ notifications: 0, boostedShare: null, topDecileExposureShare: null, ...period });
    const retention = (await (await RETENTION(get(admin, `${BASE}/retention?${q}`))).json()) as { data: RetentionReportDto };
    expect(retention.data).toMatchObject({ previousPeriodStart: '2089-12-01T00:00:00.000Z', retentionRate: null, ...period });
    const trends = (await (await SERVICE_TRENDS(get(admin, `${BASE}/service-trends?${q}`))).json()) as { data: ServiceTrendsReportDto };
    expect(trends.data).toMatchObject({ services: [], ...period });
    const supply = (await (await SUPPLY_DEMAND(get(admin, `${BASE}/supply-demand?${q}`))).json()) as { data: SupplyDemandReportDto };
    expect(supply.data).toMatchObject(period);
    expect(supply.data.services.every((s) => s.demand === 0)).toBe(true);
  });

  it('provider performance uses the paged envelope and honours limit/offset', async () => {
    const res = await PROVIDER_PERFORMANCE(get(admin, `${BASE}/provider-performance?from=2090-01-01&to=2090-02-01&limit=5&offset=10`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: ProviderPerformanceDto[]; page: { limit: number; offset: number; total: number; nextOffset: number | null } };
    expect(body.data).toEqual([]);
    expect(body.page).toEqual({ limit: 5, offset: 10, total: 0, nextOffset: null });
  });

  it('400 VALIDATION_ERROR for a malformed, inverted or over-long range, on every route', async () => {
    for (const [name, handler] of Object.entries(HANDLERS)) {
      for (const q of ['from=yesterday', 'from=2026-02-01&to=2026-01-01', 'from=2024-01-01&to=2026-01-01']) {
        const res = await handler(get(admin, `${BASE}/${name}?${q}`));
        expect(res.status, `${name}?${q}`).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe('VALIDATION_ERROR');
      }
    }
  });

  it('every route is rate-limited by the default bucket (429)', async () => {
    for (let i = 0; i < 100; i += 1) checkRateLimit('default', admin.userId);
    for (const [name, handler] of Object.entries(HANDLERS)) {
      expect((await handler(get(admin, `${BASE}/${name}`))).status, name).toBe(429);
    }
  });
});

describe.skipIf(!dbReachable)('GET /api/v1/cron/analytics-retention-sweep (spec 040 §4)', () => {
  const savedSecret = process.env.CRON_SECRET;
  const URL_ = 'http://localhost/api/v1/cron/analytics-retention-sweep';

  afterEach(() => {
    if (savedSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = savedSecret;
  });

  it('refuses a missing, wrong or unconfigured cron secret', async () => {
    process.env.CRON_SECRET = 'correct-secret';
    expect((await RETENTION_SWEEP(new NextRequest(URL_))).status).toBe(401);
    expect((await RETENTION_SWEEP(new NextRequest(URL_, { headers: { authorization: 'Bearer wrong' } }))).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await RETENTION_SWEEP(new NextRequest(URL_, { headers: { authorization: 'Bearer correct-secret' } }))).status).toBe(401);
  });

  it('runs the sweep with the right secret and reports what it did', async () => {
    process.env.CRON_SECRET = 'correct-secret';
    const res = await RETENTION_SWEEP(new NextRequest(URL_, { headers: { authorization: 'Bearer correct-secret' } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; eventsDeleted: number; eventsDeattributed: number };
    expect(body.status).toBe('ok');
    expect(Number.isInteger(body.eventsDeleted)).toBe(true);
    expect(Number.isInteger(body.eventsDeattributed)).toBe(true);
  });

  it('is scheduled daily in vercel.json', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const vercel = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as { crons: { path: string; schedule: string }[] };
    const entry = vercel.crons.find((c) => c.path === '/api/v1/cron/analytics-retention-sweep');
    expect(entry?.schedule).toMatch(/^\d+ \d+ \* \* \*$/);
  });
});
