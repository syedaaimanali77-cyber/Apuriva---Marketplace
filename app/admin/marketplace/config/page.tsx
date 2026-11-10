'use client';

import Link from 'next/link';
import { Alert, Card, ErrorState, Skeleton } from '@/components';
import type { MarketplaceConfigDto } from '@/lib/types/admin-dashboard';
import styles from '../../admin.module.css';
import dashboard from '../../_components/admin-dashboard.module.css';
import { formatAsOf } from '../../_components/format';
import { usePolledResource } from '../../_components/usePolledResource';

function selectConfig(json: unknown): MarketplaceConfigDto {
  return (json as { data: MarketplaceConfigDto }).data;
}

/**
 * Spec 037 §3/§5, `/admin/marketplace/config` — a configuration OVERVIEW and navigation screen,
 * not an editor (D-3). Every value is read-only and there is no form: matching weights are changed
 * only in spec 017's editor (`/admin/marketplace/matching`), cancellation policies only through
 * spec 023's publish path (its editor UI is spec 041's, so there is no link yet). Sections appear
 * per the caller's read permission, decided server-side. Loads once; it does not poll.
 */
export default function AdminMarketplaceConfigPage() {
  const config = usePolledResource('/api/v1/admin/marketplace/config', selectConfig, { poll: false });

  return (
    <main className={styles.page} data-density="dense">
      <h1 className={styles.title}>Marketplace configuration</h1>

      {config.status === 'loading' && (
        <Card>
          <Skeleton lines={4} />
        </Card>
      )}

      {config.status === 'forbidden' && (
        <Alert tone="warning" title="Configuration permission required">
          Marketplace configuration is visible to admins holding the matching or cancellation-policy read permission.
        </Alert>
      )}

      {config.status === 'error' && <ErrorState description={config.error ?? undefined} onRetry={config.retry} />}

      {config.status === 'ready' && config.data && (
        <>
          <p className={dashboard.asOf}>As of {formatAsOf(config.data.generatedAt)}</p>

          {config.data.matching && (
            <section className={styles.section} aria-labelledby="config-matching">
              <div className={styles.sectionHeader}>
                <h2 id="config-matching" className={styles.sectionTitle}>
                  Matching weights
                </h2>
              </div>
              <Card>
                <p className={styles.sectionDescription}>Platform default (read-only)</p>
                <dl className={dashboard.weightsList}>
                  {Object.entries(config.data.matching.platformDefaultWeights).map(([factor, weight]) => (
                    <div key={factor} className={dashboard.weightRow}>
                      <dt>{factor}</dt>
                      <dd>{weight}</dd>
                    </div>
                  ))}
                </dl>
                <p className={styles.sectionDescription}>
                  Services with their own weights: {config.data.matching.serviceOverrideCount.toLocaleString()}
                </p>
                <Link href={config.data.matching.linkTo}>Manage matching weights</Link>
              </Card>
            </section>
          )}

          {config.data.cancellation && (
            <section className={styles.section} aria-labelledby="config-cancellation">
              <div className={styles.sectionHeader}>
                <h2 id="config-cancellation" className={styles.sectionTitle}>
                  Cancellation policy
                </h2>
              </div>
              <Card>
                {config.data.cancellation.activePlatformPolicy ? (
                  <p className={styles.sectionDescription}>
                    Platform policy in effect since {formatAsOf(config.data.cancellation.activePlatformPolicy.effectiveFrom)}
                  </p>
                ) : (
                  <p className={styles.sectionDescription}>No platform cancellation policy is published.</p>
                )}
                <p className={styles.sectionDescription}>Managed separately.</p>
              </Card>
            </section>
          )}
        </>
      )}
    </main>
  );
}
