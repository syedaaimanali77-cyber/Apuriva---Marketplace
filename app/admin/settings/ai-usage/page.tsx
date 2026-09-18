'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Card, EmptyState, ErrorState, Skeleton, Table } from '@/components';
import type { TableColumn } from '@/components';
// Imported from its own module rather than the `@/components` barrel: `components/index.ts`
// currently carries in-flight design-system work belonging to earlier specs, so spec 033 does not
// touch it. `components/StatBlock.tsx` is still the app-facing layer — never `ui/` internals — so
// the design-system rule holds either way, and the barrel re-export can follow with that work.
import { StatBlock } from '@/components/StatBlock';
import type { AiUsageSummaryDto, AiUsageTotals } from '@/lib/types/ai';
import styles from '../../admin.module.css';

interface ApiErrorBody {
  code: string;
  message: string;
}

type PageStatus = 'loading' | 'forbidden' | 'error' | 'ready';

interface BreakdownRow {
  key: string;
  label: string;
  requests: number;
  tokens: number;
}

function toRows(totals: Record<string, AiUsageTotals>): BreakdownRow[] {
  return Object.entries(totals)
    .map(([label, value]) => ({ key: label, label, requests: value.requests, tokens: value.tokens }))
    .sort((a, b) => b.requests - a.requests || a.label.localeCompare(b.label));
}

/** Minor units are integers by construction (master spec §132.5) — formatted for display only. */
function formatCost(minorUnits: number, currencyCode: string): string {
  return `${currencyCode} ${(minorUnits / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function cacheHitRate(summary: AiUsageSummaryDto): string {
  if (summary.totalRequests === 0) return '0%';
  return `${Math.round((summary.cachedRequests / summary.totalRequests) * 100)}%`;
}

/**
 * Spec 033 §5/AC-6, `app/admin/settings/ai-usage` — the aggregate AI usage and cost view.
 *
 * `GET /api/v1/admin/ai/usage` is itself permission-scoped server-side (`ai/read_usage`: Analytics,
 * Finance and Super Admins), so a caller without it gets a plain "you don't have access" state
 * here — never a client-side role check standing in for the real authorization spec 009 §5
 * requires. The payload it renders is aggregate only: no user identifier, no prompt, no response.
 */
export default function AdminAiUsagePage() {
  const [pageStatus, setPageStatus] = useState<PageStatus>('loading');
  const [pageError, setPageError] = useState<string | null>(null);
  const [summary, setSummary] = useState<AiUsageSummaryDto | null>(null);

  const load = useCallback(async () => {
    setPageStatus('loading');
    setPageError(null);
    const res = await fetch('/api/v1/admin/ai/usage', { credentials: 'same-origin' });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = json as ApiErrorBody;
      if (error.code === 'FORBIDDEN') {
        setPageStatus('forbidden');
        return;
      }
      setPageStatus('error');
      setPageError(error.message ?? "Couldn't load AI usage.");
      return;
    }
    setSummary(json.data as AiUsageSummaryDto);
    setPageStatus('ready');
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (pageStatus === 'loading') {
    return (
      <main className={styles.page} data-density="dense">
        <h1 className={styles.title}>AI usage &amp; cost</h1>
        <Card>
          <Skeleton lines={6} />
        </Card>
      </main>
    );
  }

  if (pageStatus === 'forbidden') {
    return (
      <main className={styles.page} data-density="dense">
        <h1 className={styles.title}>AI usage &amp; cost</h1>
        <Alert tone="warning" title="Additional permission required">
          AI usage is scoped to the Analytics, Finance and Super Admin roles — your account doesn&apos;t currently hold
          that permission.
        </Alert>
      </main>
    );
  }

  if (pageStatus === 'error' || !summary) {
    return (
      <main className={styles.page} data-density="dense">
        <h1 className={styles.title}>AI usage &amp; cost</h1>
        <ErrorState description={pageError ?? undefined} onRetry={load} />
      </main>
    );
  }

  if (summary.totalRequests === 0) {
    return (
      <main className={styles.page} data-density="dense">
        <h1 className={styles.title}>AI usage &amp; cost</h1>
        <EmptyState
          icon="sparkles"
          title="No AI usage recorded in this period"
          description="Usage is recorded only when a real AI call is accounted — nothing is ever seeded or estimated into this view."
        />
      </main>
    );
  }

  const columns: TableColumn<BreakdownRow>[] = [
    { key: 'label', header: 'Name', render: (row) => row.label },
    { key: 'requests', header: 'Requests', numeric: true, align: 'end', render: (row) => row.requests.toLocaleString() },
    { key: 'tokens', header: 'Tokens', numeric: true, align: 'end', render: (row) => row.tokens.toLocaleString() },
  ];

  return (
    <main className={styles.page} data-density="dense">
      <h1 className={styles.title}>AI usage &amp; cost</h1>

      <section aria-labelledby="totals-heading" className={styles.section}>
        <h2 id="totals-heading" className={styles.sectionTitle}>
          Last 30 days
        </h2>
        <p className={styles.sectionDescription}>
          Aggregate only — this view carries no user identifiers and no prompt or response content.
          {summary.rejectedRequests > 0 || summary.failedRequests > 0
            ? ` ${summary.rejectedRequests.toLocaleString()} rejected, ${summary.failedRequests.toLocaleString()} failed.`
            : ''}
        </p>
        <div style={{ display: 'grid', gap: 'var(--space-3)', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <StatBlock icon="activity" label="Total requests" value={summary.totalRequests.toLocaleString()} />
          <StatBlock icon="sparkles" label="Tokens" value={summary.totalTokens.toLocaleString()} />
          <StatBlock
            icon="wallet"
            label="Estimated cost"
            value={formatCost(summary.estimatedCostMinorUnits, summary.currencyCode)}
            hint={
              summary.estimatedCostMinorUnits === 0
                ? 'No provider rate configured yet — the token alert is the meaningful one.'
                : undefined
            }
          />
          <StatBlock icon="zap" label="Cache hit rate" value={cacheHitRate(summary)} />
        </div>
      </section>

      <section aria-labelledby="by-task-heading" className={styles.section}>
        <h2 id="by-task-heading" className={styles.sectionTitle}>
          By task
        </h2>
        <Table caption="AI requests and tokens by task" density="dense" columns={columns} rows={toRows(summary.byTask)} />
      </section>

      <section aria-labelledby="by-provider-heading" className={styles.section}>
        <h2 id="by-provider-heading" className={styles.sectionTitle}>
          By provider
        </h2>
        <Table
          caption="AI requests and tokens by provider"
          density="dense"
          columns={columns}
          rows={toRows(summary.byProvider)}
        />
      </section>
    </main>
  );
}
