// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AdminAnalyticsPage from './page';
import type { AiUsageSummaryDto } from '@/lib/types/ai';
import type {
  FunnelReportDto,
  MatchingFairnessDto,
  ProviderPerformanceDto,
  RetentionReportDto,
  RevenueReportDto,
  ServiceTrendsReportDto,
  SupplyDemandReportDto,
} from '@/lib/types/analytics';

const PERIOD = { periodStart: '2026-08-29T00:00:00.000Z', periodEnd: '2026-09-28T00:00:00.000Z' };
const P1 = '11111111-1111-4111-8111-111111111111';

const FUNNEL: FunnelReportDto = {
  ...PERIOD,
  stages: [
    { stage: 'discover', count: 1200, conversionFromPrevious: null },
    { stage: 'request', count: 300, conversionFromPrevious: 0.25 },
    { stage: 'offer', count: 450, conversionFromPrevious: 1.5 },
    { stage: 'booking', count: 90, conversionFromPrevious: 0.2 },
    { stage: 'complete', count: 60, conversionFromPrevious: 0.6667 },
  ],
};
const REVENUE: RevenueReportDto = {
  ...PERIOD,
  currencies: [
    {
      currencyCode: 'PKR',
      lineCount: 3,
      grossMinorUnits: 1_000_000,
      refundsMinorUnits: 100_000,
      feeMinorUnits: 100_000,
      feeReversalMinorUnits: 10_000,
      netFeeMinorUnits: 90_000,
      providerNetMinorUnits: 810_000,
    },
    {
      currencyCode: 'USD',
      lineCount: 1,
      grossMinorUnits: 5_000,
      refundsMinorUnits: 0,
      feeMinorUnits: 500,
      feeReversalMinorUnits: 0,
      netFeeMinorUnits: 500,
      providerNetMinorUnits: 4_500,
    },
  ],
};
const SUPPLY: SupplyDemandReportDto = {
  ...PERIOD,
  services: [{ serviceId: 's1', serviceName: 'Plumbing', demand: 12, supply: 4, demandPerProvider: 3 }],
};
const PROVIDER_ROW: ProviderPerformanceDto = {
  providerProfileId: P1,
  notifications: 40,
  exposureShare: 0.25,
  responseTimeMinutes: 12.5,
  completionRate: 0.9,
  averageRating: 4.6,
  ratingCount: 18,
};
const FAIRNESS: MatchingFairnessDto = {
  ...PERIOD,
  notifications: 160,
  boostedNotifications: 24,
  boostedShare: 0.15,
  configuredExplorationCap: 0.2,
  distinctProvidersNotified: 30,
  topDecileExposureShare: 0.4,
};
const RETENTION: RetentionReportDto = {
  ...PERIOD,
  previousPeriodStart: '2026-07-30T00:00:00.000Z',
  previousActiveCustomers: 200,
  currentActiveCustomers: 240,
  retainedCustomers: 80,
  retentionRate: 0.4,
};
const TRENDS: ServiceTrendsReportDto = {
  ...PERIOD,
  previousPeriodStart: '2026-07-30T00:00:00.000Z',
  services: [{ serviceId: 's1', serviceName: 'Electrical', currentRequests: 30, previousRequests: 20, changeRate: 0.5 }],
};
const AI: AiUsageSummaryDto = {
  from: PERIOD.periodStart,
  to: PERIOD.periodEnd,
  totalRequests: 1000,
  succeededRequests: 990,
  rejectedRequests: 5,
  failedRequests: 5,
  cachedRequests: 250,
  totalTokens: 64_000,
  estimatedCostMinorUnits: 0,
  currencyCode: 'PKR',
  byTask: {} as AiUsageSummaryDto['byTask'],
  byProvider: {},
  costAlertThresholds: { dailyMinorUnits: 0, monthlyMinorUnits: 0, dailyTokens: 0 },
};

type Reply = { status: number; body: unknown };
const ok = (data: unknown, page?: unknown): Reply => ({ status: 200, body: { data, ...(page ? { page } : {}) } });
const forbidden: Reply = { status: 403, body: { code: 'FORBIDDEN', message: 'You do not have access to this report.' } };

const SUCCESS: Record<string, Reply> = {
  funnel: ok(FUNNEL),
  revenue: ok(REVENUE),
  'supply-demand': ok(SUPPLY),
  'provider-performance': ok([PROVIDER_ROW], { limit: 20, offset: 0, total: 1, nextOffset: null }),
  'matching-fairness': ok(FAIRNESS),
  retention: ok(RETENTION),
  'service-trends': ok(TRENDS),
  'ai/usage': ok(AI),
};

function reportKey(url: string): string {
  const path = new URL(url, 'http://localhost').pathname;
  return path.startsWith('/api/v1/admin/analytics/') ? path.slice('/api/v1/admin/analytics/'.length) : path.slice('/api/v1/admin/'.length);
}

function stubFetch(replies: Record<string, Reply | (() => Reply)>) {
  const fetchMock = vi.fn(async (url: string) => {
    const entry = replies[reportKey(url)] ?? { status: 500, body: { code: 'INTERNAL', message: 'unexpected' } };
    const reply = typeof entry === 'function' ? entry() : entry;
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const section = (name: RegExp) => within(screen.getByRole('region', { name }));

/** Spec 040 §5 — the Analytics page: seven sections over one range, and every documented state. */
describe('AdminAnalyticsPage (spec 040 §5, AC-2)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('success: all seven sections render their aggregates from one shared range', async () => {
    const fetchMock = stubFetch(SUCCESS);
    render(<AdminAnalyticsPage />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Analytics' })).toBeInTheDocument();
    await screen.findByText('Plumbing');

    expect(section(/^Funnel$/).getByText('1,200')).toBeInTheDocument();
    expect(section(/^Funnel$/).getByText('150.0%')).toBeInTheDocument(); // a period ratio > 1 is shown as-is
    expect(section(/^Funnel$/).getByText(/not a cohort/i)).toBeInTheDocument();

    const revenue = section(/^Revenue$/);
    expect(revenue.getByText('PKR')).toBeInTheDocument();
    expect(revenue.getByText('USD')).toBeInTheDocument();

    expect(section(/Supply and demand/).getByText('3')).toBeInTheDocument();
    expect(section(/Provider performance/).getByText(P1)).toBeInTheDocument();
    expect(section(/Provider performance/).getByText('25.0%')).toBeInTheDocument();
    expect(section(/Matching fairness/).getByText('15.0%')).toBeInTheDocument();
    expect(section(/Matching fairness/).getByText(/Configured cap 20.0%/)).toBeInTheDocument();
    expect(section(/^Retention$/).getByText('40.0%')).toBeInTheDocument();
    expect(section(/Service trends/).getByText('Electrical')).toBeInTheDocument();
    expect(section(/AI usage/).getByText('64,000')).toBeInTheDocument();

    // Every section asked for the same window; AI usage reuses spec 033's route.
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(8);
    expect(urls.some((u) => u.startsWith('/api/v1/admin/ai/usage?'))).toBe(true);
    const ranges = new Set(urls.map((u) => new URL(u, 'http://localhost').searchParams.get('from')));
    expect(ranges.size).toBe(1);

    for (const cell of document.querySelectorAll('td')) {
      expect(cell).not.toHaveTextContent('undefined');
      expect(cell).not.toHaveTextContent('NaN');
    }
  });

  it('loading: a skeleton per section before data arrives', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    render(<AdminAnalyticsPage />);
    expect(screen.getAllByRole('region')).toHaveLength(8);
    expect(screen.queryAllByRole('table')).toHaveLength(0);
  });

  it('forbidden: a 403 section says so, and the others still render', async () => {
    stubFetch({ ...SUCCESS, revenue: forbidden, 'ai/usage': forbidden });
    render(<AdminAnalyticsPage />);
    await screen.findByText('Plumbing');
    expect(section(/^Revenue$/).getByText("You don't have access to this report")).toBeInTheDocument();
    expect(section(/AI usage/).getByText("You don't have access to this report")).toBeInTheDocument();
    expect(section(/^Funnel$/).getByText('1,200')).toBeInTheDocument();
  });

  it('empty: a section with no data shows "No activity in this period"', async () => {
    stubFetch({
      ...SUCCESS,
      'service-trends': ok({ ...TRENDS, services: [] }),
      'provider-performance': ok([], { limit: 20, offset: 0, total: 0, nextOffset: null }),
    });
    render(<AdminAnalyticsPage />);
    await screen.findByText('Plumbing');
    expect(section(/Service trends/).getByText('No activity in this period')).toBeInTheDocument();
    expect(section(/Provider performance/).getByText('No activity in this period')).toBeInTheDocument();
    // No CSV for an empty list.
    expect(section(/Provider performance/).queryByRole('button', { name: /Export CSV/ })).toBeNull();
  });

  it('error: a failed section offers retry, which refetches with the same range', async () => {
    let calls = 0;
    const fetchMock = stubFetch({
      ...SUCCESS,
      funnel: () => {
        calls += 1;
        return calls === 1 ? { status: 500, body: { code: 'INTERNAL', message: 'Something broke.' } } : ok(FUNNEL);
      },
    });
    render(<AdminAnalyticsPage />);
    const funnel = await waitFor(() => {
      const region = section(/^Funnel$/);
      region.getByRole('button', { name: /retry|try again/i });
      return region;
    });
    const firstUrl = String(fetchMock.mock.calls.find((c) => String(c[0]).includes('/funnel'))![0]);
    await userEvent.click(funnel.getByRole('button', { name: /retry|try again/i }));
    expect(await section(/^Funnel$/).findByText('1,200')).toBeInTheDocument();
    const funnelUrls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/funnel'));
    expect(funnelUrls).toHaveLength(2);
    expect(funnelUrls[1]).toBe(firstUrl);
  });

  it('range: applying new dates refetches every section with from inclusive and to exclusive', async () => {
    const fetchMock = stubFetch(SUCCESS);
    render(<AdminAnalyticsPage />);
    await screen.findByText('Plumbing');
    fetchMock.mockClear();

    const from = screen.getByLabelText('From');
    const to = screen.getByLabelText('To');
    await userEvent.clear(from);
    await userEvent.type(from, '2026-01-01');
    await userEvent.clear(to);
    await userEvent.type(to, '2026-01-31');
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(8));
    for (const [url] of fetchMock.mock.calls) {
      const params = new URL(String(url), 'http://localhost').searchParams;
      expect(params.get('from')).toBe('2026-01-01');
      expect(params.get('to')).toBe('2026-02-01');
    }
  });

  it('range: an inverted range is flagged and cannot be applied', async () => {
    stubFetch(SUCCESS);
    render(<AdminAnalyticsPage />);
    await screen.findByText('Plumbing');
    const from = screen.getByLabelText('From');
    await userEvent.clear(from);
    await userEvent.type(from, '2099-01-01');
    expect(screen.getByText('Choose a start date on or before the end date.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
  });

  it('CSV: provider performance exports the rows already shown', async () => {
    stubFetch(SUCCESS);
    const created: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob);
      return 'blob:analytics';
    });
    const saved = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    render(<AdminAnalyticsPage />);
    await screen.findByText(P1);
    await userEvent.click(section(/Provider performance/).getByRole('button', { name: /Export CSV/ }));

    expect(click).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
    URL.createObjectURL = saved.create;
    URL.revokeObjectURL = saved.revoke;
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(created[0]!);
    });
    expect(text.split('\n')).toEqual([
      'providerProfileId,notifications,exposureShare,responseTimeMinutes,completionRate,averageRating,ratingCount',
      `${P1},40,0.25,12.5,0.9,4.6,18`,
    ]);
  });

  it('paging: provider performance moves through pages with offset', async () => {
    const fetchMock = stubFetch({
      ...SUCCESS,
      'provider-performance': ok([PROVIDER_ROW], { limit: 20, offset: 0, total: 25, nextOffset: 20 }),
    });
    render(<AdminAnalyticsPage />);
    await screen.findByText(P1);
    await userEvent.click(section(/Provider performance/).getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/provider-performance') && String(c[0]).includes('offset=20'))).toBe(true),
    );
  });
});
