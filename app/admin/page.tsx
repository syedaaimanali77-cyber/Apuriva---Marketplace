'use client';

import Link from 'next/link';
import { Alert, Card, ErrorState, PriceDisplay, Skeleton } from '@/components';
// Imported from its own module, as spec 033's AI usage page does: `components/StatBlock.tsx` is the
// app-facing layer (never `ui/` internals) but is not yet re-exported by the committed barrel.
import { StatBlock } from '@/components/StatBlock';
import type { AdminAlertDto, AdminAlertSeverity, AdminOverviewDto } from '@/lib/types/admin-dashboard';
import styles from './admin.module.css';
import dashboard from './_components/admin-dashboard.module.css';
import { formatAsOf } from './_components/format';
import { usePolledResource } from './_components/usePolledResource';

const ALERT_TONE: Record<AdminAlertSeverity, 'info' | 'warning' | 'error'> = {
  info: 'info',
  warning: 'warning',
  critical: 'error',
};

function selectOverview(json: unknown): AdminOverviewDto {
  return (json as { data: AdminOverviewDto }).data;
}

function RevenueToday({ revenue }: { revenue: AdminOverviewDto['revenueToday'] }) {
  if (revenue.length === 0) return <>Nothing captured today</>;
  return (
    <ul className={dashboard.revenueList}>
      {revenue.map((entry) => (
        <li key={entry.currencyCode}>
          <PriceDisplay priceDisplay={{ type: 'exact', amountMinorUnits: entry.amountMinorUnits, currencyCode: entry.currencyCode }} />
        </li>
      ))}
    </ul>
  );
}

function AlertsPanel({ alerts }: { alerts: AdminAlertDto[] }) {
  if (alerts.length === 0) return <p className={dashboard.asOf}>No alerts</p>;
  return (
    <>
      {alerts.map((alert) => (
        <Alert key={alert.rule} tone={ALERT_TONE[alert.severity]} title={alert.message} actions={<Link href={alert.linkTo}>Open</Link>} />
      ))}
    </>
  );
}

/**
 * Spec 037 §5, `/admin` — the Overview (spec 014's nav entry). Live figures from
 * `GET /api/v1/admin/overview`, polled every 10 s while the tab is visible, with the server's
 * "as of" time. Read-only. Per CLAUDE.md, no logo or header of its own.
 */
export default function AdminOverviewPage() {
  const overview = usePolledResource('/api/v1/admin/overview', selectOverview, { poll: true });

  return (
    <main className={styles.page} data-density="dense">
      <h1 className={styles.title}>Overview</h1>

      {overview.status === 'forbidden' && (
        <Alert tone="warning" title="Administrator access required">
          The Overview is available to APURIVA administrators only.
        </Alert>
      )}

      {overview.status === 'error' && <ErrorState description={overview.error ?? undefined} onRetry={overview.retry} />}

      {overview.status === 'loading' && (
        <>
          <section className={styles.section} aria-label="Marketplace health" aria-busy="true">
            <Card>
              <Skeleton lines={3} />
            </Card>
          </section>
          <section className={styles.section} aria-label="Alerts" aria-busy="true">
            <Card>
              <Skeleton lines={2} />
            </Card>
          </section>
        </>
      )}

      {overview.status === 'ready' && overview.data && (
        <>
          {overview.pollFailed && (
            <Alert tone="warning" title="Couldn't refresh">
              Showing the last figures loaded.
            </Alert>
          )}

          <section className={styles.section} aria-labelledby="overview-health">
            <div className={styles.sectionHeader}>
              <h2 id="overview-health" className={styles.sectionTitle}>
                Marketplace health
              </h2>
            </div>
            <p className={dashboard.asOf}>As of {formatAsOf(overview.data.generatedAt)}</p>
            <div className={dashboard.statGrid}>
              <StatBlock label="Active requests" value={overview.data.activeRequests.toLocaleString()} />
              <StatBlock label="Active bookings" value={overview.data.activeBookings.toLocaleString()} />
              <StatBlock label="Captured today (UTC)" value={<RevenueToday revenue={overview.data.revenueToday} />} />
            </div>
          </section>

          <section className={styles.section} aria-labelledby="overview-alerts">
            <div className={styles.sectionHeader}>
              <h2 id="overview-alerts" className={styles.sectionTitle}>
                Alerts
              </h2>
            </div>
            <AlertsPanel alerts={overview.data.alerts} />
          </section>
        </>
      )}

      <nav aria-label="Admin workspaces">
        <ul className={dashboard.linkList}>
          <li>
            <Link href="/admin/operations">Operations queue</Link>
          </li>
          <li>
            <Link href="/admin/marketplace/config">Marketplace configuration</Link>
          </li>
        </ul>
      </nav>
    </main>
  );
}
