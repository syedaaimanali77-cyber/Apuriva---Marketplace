'use client';

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Alert, Button, Card, EmptyState, ErrorState, Input, Skeleton, Table } from '@/components';
import type { TableColumn } from '@/components';
// Imported from its own module, as spec 033's AI usage page does: `components/StatBlock.tsx` is the
// app-facing layer (never `ui/` internals), independent of in-flight work on the barrel.
import { StatBlock } from '@/components/StatBlock';
import { providerPerformanceCsv } from '@/lib/analytics/csv';
import type { AiUsageSummaryDto } from '@/lib/types/ai';
import type {
  FunnelReportDto,
  MatchingFairnessDto,
  ProviderPerformanceDto,
  RetentionReportDto,
  RevenueCurrencyTotalsDto,
  RevenueReportDto,
  ServiceTrendRowDto,
  ServiceTrendsReportDto,
  SupplyDemandReportDto,
  SupplyDemandRowDto,
} from '@/lib/types/analytics';
import { formatMoney as formatLocaleMoney, formatNumber as formatLocaleNumber } from '@/lib/i18n/format';
import styles from '../admin.module.css';

const DAY_MS = 86_400_000;
const DEFAULT_RANGE_DAYS = 30;

interface DateRange {
  /** `YYYY-MM-DD`, inclusive. */
  from: string;
  /** `YYYY-MM-DD`, inclusive as shown; sent to the API as the next day (W's `to` is exclusive). */
  to: string;
}

interface PageInfo {
  limit: number;
  offset: number;
  total: number;
  nextOffset: number | null;
}

type ReportState<T> =
  | { status: 'loading' }
  | { status: 'forbidden' }
  | { status: 'error'; message: string | null }
  | { status: 'ready'; data: T; page?: PageInfo };

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function defaultRange(now: Date = new Date()): DateRange {
  return { from: isoDate(new Date(now.getTime() - (DEFAULT_RANGE_DAYS - 1) * DAY_MS)), to: isoDate(now) };
}

/** The query string every section shares: `from` inclusive, `to` exclusive (the day after the shown end). */
function rangeQuery(range: DateRange): string {
  const toExclusive = isoDate(new Date(new Date(`${range.to}T00:00:00Z`).getTime() + DAY_MS));
  return `from=${range.from}&to=${toExclusive}`;
}

/** Spec 042 X-11: the shared locale formatters. Admin screens stay English (§5.1), so always `'en'`. */
function formatMoney(minorUnits: number, currencyCode: string): string {
  return formatLocaleMoney(minorUnits, currencyCode, 'en');
}

function formatPercent(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value: number | null): string {
  return value === null ? '—' : formatLocaleNumber(value, 'en');
}

/**
 * One section's fetch. Authorization is decided server-side (spec 009's `resolvePermission`); a `403`
 * is shown as "no access" for that section only, never as a client-side role check.
 */
function useReport<T>(path: string, query: string): [ReportState<T>, () => void] {
  const [state, setState] = useState<ReportState<T>>({ status: 'loading' });
  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const res = await fetch(`${path}?${query}`, { credentials: 'same-origin' });
      const json = await res.json().catch(() => ({}));
      if (res.status === 403) return setState({ status: 'forbidden' });
      if (!res.ok) return setState({ status: 'error', message: (json as { message?: string }).message ?? null });
      setState({ status: 'ready', data: json.data as T, page: json.page as PageInfo | undefined });
    } catch {
      setState({ status: 'error', message: null });
    }
  }, [path, query]);
  useEffect(() => {
    load();
  }, [load]);
  return [state, load];
}

function ReportSection<T>({
  id,
  title,
  description,
  state,
  onRetry,
  isEmpty,
  action,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  state: ReportState<T>;
  onRetry: () => void;
  isEmpty: (data: T) => boolean;
  action?: ReactNode;
  children: (data: T, page?: PageInfo) => ReactNode;
}) {
  let body: ReactNode;
  if (state.status === 'loading') {
    body = (
      <Card>
        <Skeleton lines={4} />
      </Card>
    );
  } else if (state.status === 'forbidden') {
    body = <Alert tone="info">You don&apos;t have access to this report</Alert>;
  } else if (state.status === 'error') {
    body = <ErrorState compact description={state.message ?? undefined} onRetry={onRetry} />;
  } else if (isEmpty(state.data)) {
    body = <EmptyState compact icon="chart-column" title="No activity in this period" />;
  } else {
    body = children(state.data, state.page);
  }
  return (
    <section aria-labelledby={`${id}-heading`} className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 id={`${id}-heading`} className={styles.sectionTitle}>
          {title}
        </h2>
        {state.status === 'ready' && !isEmpty(state.data) ? action : null}
      </div>
      {description ? <p className={styles.sectionDescription}>{description}</p> : null}
      {body}
    </section>
  );
}

const statGrid = { display: 'grid', gap: 'var(--space-3)', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' };

function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Spec 040 §5 — the admin Analytics section (master §123): funnel, revenue, supply/demand, provider
 * performance with matching fairness, retention, service trends and AI usage over one shared range.
 * Every figure is an aggregate computed server-side (§3.6); there are no charts (no design-system
 * primitive), so figures are tables and stat blocks.
 */
export default function AdminAnalyticsPage() {
  const [draft, setDraft] = useState<DateRange>(() => defaultRange());
  const [range, setRange] = useState<DateRange>(draft);
  const [providerOffset, setProviderOffset] = useState(0);
  const invalidRange = draft.from === '' || draft.to === '' || draft.from > draft.to;
  const query = rangeQuery(range);

  const [funnel, retryFunnel] = useReport<FunnelReportDto>('/api/v1/admin/analytics/funnel', query);
  const [revenue, retryRevenue] = useReport<RevenueReportDto>('/api/v1/admin/analytics/revenue', query);
  const [supply, retrySupply] = useReport<SupplyDemandReportDto>('/api/v1/admin/analytics/supply-demand', query);
  const [providers, retryProviders] = useReport<ProviderPerformanceDto[]>(
    '/api/v1/admin/analytics/provider-performance',
    `${query}&offset=${providerOffset}`,
  );
  const [fairness, retryFairness] = useReport<MatchingFairnessDto>('/api/v1/admin/analytics/matching-fairness', query);
  const [retention, retryRetention] = useReport<RetentionReportDto>('/api/v1/admin/analytics/retention', query);
  const [trends, retryTrends] = useReport<ServiceTrendsReportDto>('/api/v1/admin/analytics/service-trends', query);
  const [aiUsage, retryAiUsage] = useReport<AiUsageSummaryDto>('/api/v1/admin/ai/usage', query);

  function apply(event: FormEvent) {
    event.preventDefault();
    if (invalidRange) return;
    setProviderOffset(0);
    setRange(draft);
  }

  const revenueColumns: TableColumn<RevenueCurrencyTotalsDto>[] = [
    { key: 'currencyCode', header: 'Currency', render: (r) => r.currencyCode },
    { key: 'gross', header: 'Gross', numeric: true, align: 'end', render: (r) => formatMoney(r.grossMinorUnits, r.currencyCode) },
    { key: 'refunds', header: 'Refunds', numeric: true, align: 'end', render: (r) => formatMoney(r.refundsMinorUnits, r.currencyCode) },
    { key: 'fee', header: 'Platform fee', numeric: true, align: 'end', render: (r) => formatMoney(r.feeMinorUnits, r.currencyCode) },
    {
      key: 'feeReversal',
      header: 'Fee reversals',
      numeric: true,
      align: 'end',
      render: (r) => formatMoney(r.feeReversalMinorUnits, r.currencyCode),
    },
    { key: 'netFee', header: 'Net fee revenue', numeric: true, align: 'end', render: (r) => formatMoney(r.netFeeMinorUnits, r.currencyCode) },
    {
      key: 'providerNet',
      header: 'Provider net',
      numeric: true,
      align: 'end',
      render: (r) => formatMoney(r.providerNetMinorUnits, r.currencyCode),
    },
    { key: 'lineCount', header: 'Lines', numeric: true, align: 'end', render: (r) => formatLocaleNumber(r.lineCount, 'en') },
  ];

  const supplyColumns: TableColumn<SupplyDemandRowDto>[] = [
    { key: 'serviceName', header: 'Service', render: (r) => r.serviceName },
    { key: 'demand', header: 'Requests', numeric: true, align: 'end', render: (r) => formatLocaleNumber(r.demand, 'en') },
    { key: 'supply', header: 'Active providers', numeric: true, align: 'end', render: (r) => formatLocaleNumber(r.supply, 'en') },
    {
      key: 'demandPerProvider',
      header: 'Requests per provider',
      numeric: true,
      align: 'end',
      render: (r) => formatNumber(r.demandPerProvider),
    },
  ];

  const providerColumns: TableColumn<ProviderPerformanceDto>[] = [
    { key: 'providerProfileId', header: 'Provider profile', render: (r) => r.providerProfileId },
    { key: 'notifications', header: 'Notifications', numeric: true, align: 'end', render: (r) => formatLocaleNumber(r.notifications, 'en') },
    { key: 'exposureShare', header: 'Exposure share', numeric: true, align: 'end', render: (r) => formatPercent(r.exposureShare) },
    {
      key: 'responseTimeMinutes',
      header: 'Avg response (min)',
      numeric: true,
      align: 'end',
      render: (r) => formatNumber(r.responseTimeMinutes),
    },
    { key: 'completionRate', header: 'Completion rate', numeric: true, align: 'end', render: (r) => formatPercent(r.completionRate) },
    {
      key: 'rating',
      header: 'Rating',
      numeric: true,
      align: 'end',
      render: (r) => (r.averageRating === null ? '—' : `${r.averageRating} (${r.ratingCount ?? 0})`),
    },
  ];

  const trendColumns: TableColumn<ServiceTrendRowDto>[] = [
    { key: 'serviceName', header: 'Service', render: (r) => r.serviceName },
    { key: 'currentRequests', header: 'This period', numeric: true, align: 'end', render: (r) => formatLocaleNumber(r.currentRequests, 'en') },
    { key: 'previousRequests', header: 'Previous period', numeric: true, align: 'end', render: (r) => formatLocaleNumber(r.previousRequests, 'en') },
    { key: 'changeRate', header: 'Change', numeric: true, align: 'end', render: (r) => formatPercent(r.changeRate) },
  ];

  return (
    <main className={styles.page} data-density="dense">
      <h1 className={styles.title}>Analytics</h1>

      <form className={styles.form} onSubmit={apply} aria-label="Reporting period">
        <label className={styles.formField}>
          <span className={styles.sectionDescription}>From</span>
          <Input
            type="date"
            fullWidth
            value={draft.from}
            invalid={invalidRange}
            onChange={(e) => setDraft({ ...draft, from: e.target.value })}
          />
        </label>
        <label className={styles.formField}>
          <span className={styles.sectionDescription}>To</span>
          <Input
            type="date"
            fullWidth
            value={draft.to}
            invalid={invalidRange}
            onChange={(e) => setDraft({ ...draft, to: e.target.value })}
          />
        </label>
        <div className={styles.actions}>
          <Button type="submit" variant="primary" disabled={invalidRange}>
            Apply
          </Button>
        </div>
      </form>
      {invalidRange ? <Alert tone="warning">Choose a start date on or before the end date.</Alert> : null}

      <ReportSection
        id="funnel"
        title="Funnel"
        description="Counts of each stage within the period — not a cohort, so a stage can exceed the one before it."
        state={funnel}
        onRetry={retryFunnel}
        isEmpty={(d) => d.stages.every((s) => s.count === 0)}
      >
        {(d) => (
          <Table
            caption="Funnel stages"
            density="dense"
            columns={[
              { key: 'stage', header: 'Stage', render: (s: FunnelReportDto['stages'][number]) => s.stage },
              { key: 'count', header: 'Count', numeric: true, align: 'end', render: (s) => formatLocaleNumber(s.count, 'en') },
              {
                key: 'conversion',
                header: 'vs previous stage',
                numeric: true,
                align: 'end',
                render: (s) => formatPercent(s.conversionFromPrevious),
              },
            ]}
            rows={d.stages}
          />
        )}
      </ReportSection>

      <ReportSection
        id="revenue"
        title="Revenue"
        description="Per currency, from earnings lines created in the period — never added across currencies."
        state={revenue}
        onRetry={retryRevenue}
        isEmpty={(d) => d.currencies.length === 0}
      >
        {(d) => <Table caption="Revenue by currency" density="dense" columns={revenueColumns} rows={d.currencies} />}
      </ReportSection>

      <ReportSection
        id="supply-demand"
        title="Supply and demand"
        description="Requests in the period against providers currently active for each service."
        state={supply}
        onRetry={retrySupply}
        isEmpty={(d) => d.services.length === 0}
      >
        {(d) => <Table caption="Supply and demand by service" density="dense" columns={supplyColumns} rows={d.services} />}
      </ReportSection>

      <ReportSection
        id="provider-performance"
        title="Provider performance"
        state={providers}
        onRetry={retryProviders}
        isEmpty={(d) => d.length === 0}
        action={
          providers.status === 'ready' ? (
            <Button
              variant="secondary"
              size="sm"
              iconLeft="file-text"
              onClick={() => downloadCsv('provider-performance.csv', providerPerformanceCsv(providers.data))}
            >
              Export CSV
            </Button>
          ) : null
        }
      >
        {(rows, page) => (
          <>
            <Table caption="Provider performance" density="dense" columns={providerColumns} rows={rows} />
            {page && (page.offset > 0 || page.nextOffset !== null) ? (
              <div className={styles.actions}>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={page.offset === 0}
                  onClick={() => setProviderOffset(Math.max(0, page.offset - page.limit))}
                >
                  Previous
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={page.nextOffset === null}
                  onClick={() => page.nextOffset !== null && setProviderOffset(page.nextOffset)}
                >
                  Next
                </Button>
              </div>
            ) : null}
          </>
        )}
      </ReportSection>

      <ReportSection
        id="matching-fairness"
        title="Matching fairness"
        description="New-provider exposure from persisted match notifications (spec 017)."
        state={fairness}
        onRetry={retryFairness}
        isEmpty={(d) => d.notifications === 0}
      >
        {(d) => (
          <div style={statGrid}>
            <StatBlock icon="bell" label="Notifications" value={formatLocaleNumber(d.notifications, 'en')} />
            <StatBlock
              icon="sparkles"
              label="New-provider boosted share"
              value={formatPercent(d.boostedShare)}
              hint={`Configured cap ${formatPercent(d.configuredExplorationCap)} · ${formatLocaleNumber(d.boostedNotifications, 'en')} boosted`}
            />
            <StatBlock icon="users" label="Providers notified" value={formatLocaleNumber(d.distinctProvidersNotified, 'en')} />
            <StatBlock
              icon="trending-up"
              label="Top 10% providers' share"
              value={formatPercent(d.topDecileExposureShare)}
              hint="How concentrated exposure is"
            />
          </div>
        )}
      </ReportSection>

      <ReportSection
        id="retention"
        title="Retention"
        description="Customers with a request in the previous equal-length period who made another in this one."
        state={retention}
        onRetry={retryRetention}
        isEmpty={(d) => d.previousActiveCustomers === 0 && d.currentActiveCustomers === 0}
      >
        {(d) => (
          <div style={statGrid}>
            <StatBlock icon="users" label="Active before" value={formatLocaleNumber(d.previousActiveCustomers, 'en')} />
            <StatBlock icon="users" label="Active this period" value={formatLocaleNumber(d.currentActiveCustomers, 'en')} />
            <StatBlock icon="badge-check" label="Retained" value={formatLocaleNumber(d.retainedCustomers, 'en')} />
            <StatBlock icon="trending-up" label="Retention rate" value={formatPercent(d.retentionRate)} />
          </div>
        )}
      </ReportSection>

      <ReportSection
        id="service-trends"
        title="Service trends"
        description="Requests per service against the previous equal-length period."
        state={trends}
        onRetry={retryTrends}
        isEmpty={(d) => d.services.length === 0}
      >
        {(d) => <Table caption="Service trends" density="dense" columns={trendColumns} rows={d.services} />}
      </ReportSection>

      <ReportSection
        id="ai-usage"
        title="AI usage"
        description="Aggregate only — no user identifiers and no prompt or response content."
        state={aiUsage}
        onRetry={retryAiUsage}
        isEmpty={(d) => d.totalRequests === 0}
      >
        {(d) => (
          <div style={statGrid}>
            <StatBlock icon="trending-up" label="Requests" value={formatLocaleNumber(d.totalRequests, 'en')} />
            <StatBlock icon="sparkles" label="Tokens" value={formatLocaleNumber(d.totalTokens, 'en')} />
            <StatBlock icon="wallet" label="Estimated cost" value={formatMoney(d.estimatedCostMinorUnits, d.currencyCode)} />
            <StatBlock
              icon="zap"
              label="Cache hit rate"
              value={formatPercent(d.totalRequests === 0 ? null : d.cachedRequests / d.totalRequests)}
            />
          </div>
        )}
      </ReportSection>
    </main>
  );
}
