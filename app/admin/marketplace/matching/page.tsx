'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, ErrorState, FormField, Input, Skeleton, Table } from '@/components';
import type { TableColumn } from '@/components';
import { RANKING_FACTORS } from '@/lib/types/matching';
import type { MatchExplainabilityDto, MatchingSuggestionDto, MatchingWeights, RankingFactor } from '@/lib/types/matching';
import styles from '../../admin.module.css';

interface ApiErrorBody {
  code: string;
  message: string;
  errors?: { field: string; message: string }[];
}

interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: ApiErrorBody;
}

/** Same CSRF-cookie-echo pattern as app/admin/marketplace/catalog/page.tsx. */
function readCsrfCookie(): string {
  return document.cookie.split('; ').find((row) => row.startsWith('apuriva_csrf='))?.split('=')[1] ?? '';
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  const json = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, data: json.data as T } : { ok: false, error: json as ApiErrorBody };
}

function mutateHeaders(): Record<string, string> {
  return { 'content-type': 'application/json', 'x-csrf-token': readCsrfCookie() };
}

function describeError(error: ApiErrorBody | undefined, fallback: string): string {
  if (!error) return fallback;
  if (error.errors?.length) return error.errors.map((e) => `${e.field} ${e.message}`).join(' ');
  return error.message ?? fallback;
}

type PageStatus = 'loading' | 'forbidden' | 'error' | 'ready';

/**
 * Spec 017 §5, `app/admin/marketplace/matching` — a new page under the existing
 * `app/admin/marketplace/` directory, alongside the shipped `catalog/` page (spec 010), following
 * the same client-fetch + explicit forbidden/error/ready states pattern. `GET/PATCH` routes are
 * themselves `matching.config` permission-gated server-side (spec 017 §3), so a caller lacking it
 * sees the same "you don't have access" state, never a client-side check standing in for the real
 * backend authorization. Per CLAUDE.md's branding rule, no logo/header of its own.
 *
 * Three sections, matching the three admin surfaces spec 017 §3 defines:
 *  - Ranking explainability (AC-6) — look up one request's eligible/excluded pool by id.
 *  - Matching weights (AC-2) — set a per-service weight/pool-size override. There is deliberately
 *    no GET-by-service endpoint in the approved API contract, so this is a blind PATCH form
 *    (defaulted to the platform defaults), the same "no list-all, look one up" shape spec 010's
 *    service lookup already uses.
 *  - AI suggestions pending review (AC-7) — mirrors spec 010's `catalog_suggestions` review UI.
 */
export default function AdminMatchingPage() {
  const [pageStatus, setPageStatus] = useState<PageStatus>('loading');
  const [pageError, setPageError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<MatchingSuggestionDto[]>([]);
  const [announcement, setAnnouncement] = useState('');

  const load = useCallback(async () => {
    setPageStatus('loading');
    setPageError(null);
    const res = await apiFetch<MatchingSuggestionDto[]>('/api/v1/admin/matching/suggestions');
    if (!res.ok) {
      if (res.error?.code === 'FORBIDDEN') {
        setPageStatus('forbidden');
        return;
      }
      setPageStatus('error');
      setPageError(describeError(res.error, "Couldn't load matching suggestions."));
      return;
    }
    setSuggestions(res.data!);
    setPageStatus('ready');
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // --- Ranking explainability (AC-6) --------------------------------------
  const [lookupRequestId, setLookupRequestId] = useState('');
  const [explainability, setExplainability] = useState<MatchExplainabilityDto | null>(null);
  const [explainError, setExplainError] = useState<string | null>(null);
  const [explainPending, setExplainPending] = useState(false);

  async function handleLookupMatches() {
    setExplainError(null);
    setExplainability(null);
    if (!lookupRequestId.trim()) {
      setExplainError('Enter a request id.');
      return;
    }
    setExplainPending(true);
    const res = await apiFetch<MatchExplainabilityDto>(`/api/v1/requests/${encodeURIComponent(lookupRequestId.trim())}/matches`);
    setExplainPending(false);
    if (!res.ok) {
      setExplainError(describeError(res.error, "Couldn't load matching results for that request."));
      return;
    }
    setExplainability(res.data!);
  }

  // --- Matching weights (AC-2) ---------------------------------------------
  const [weightsServiceId, setWeightsServiceId] = useState('');
  const [weights, setWeights] = useState<MatchingWeights>({
    serviceMatch: 25,
    availability: 20,
    location: 15,
    rating: 10,
    reliability: 10,
    priceFit: 5,
    experience: 5,
    verification: 5,
    historicalPerformance: 5,
  });
  const [poolSize, setPoolSize] = useState('10');
  const [weightsError, setWeightsError] = useState<string | null>(null);
  const [weightsPending, setWeightsPending] = useState(false);

  const weightsTotal = RANKING_FACTORS.reduce((sum, f) => sum + (weights[f] || 0), 0);

  async function handleSaveWeights() {
    setWeightsError(null);
    if (!weightsServiceId.trim()) {
      setWeightsError('Enter a service id.');
      return;
    }
    setWeightsPending(true);
    const res = await apiFetch(`/api/v1/admin/services/${encodeURIComponent(weightsServiceId.trim())}/matching-weights`, {
      method: 'PATCH',
      headers: mutateHeaders(),
      body: JSON.stringify({ weights, poolSize: Number(poolSize) }),
    });
    setWeightsPending(false);
    if (!res.ok) {
      setWeightsError(describeError(res.error, "Couldn't save matching weights."));
      return;
    }
    setAnnouncement('Matching weights saved.');
  }

  // --- AI suggestion review (AC-7) -----------------------------------------
  const [suggestionError, setSuggestionError] = useState<string | null>(null);

  async function handleApproveSuggestion(id: string) {
    setSuggestionError(null);
    const res = await apiFetch<MatchingSuggestionDto>(`/api/v1/admin/matching/suggestions/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      headers: mutateHeaders(),
    });
    if (!res.ok) {
      setSuggestionError(describeError(res.error, "Couldn't approve that suggestion."));
      return;
    }
    setAnnouncement('Suggestion approved and applied to its target service.');
    load();
  }

  async function handleRejectSuggestion(id: string) {
    setSuggestionError(null);
    const res = await apiFetch<MatchingSuggestionDto>(`/api/v1/admin/matching/suggestions/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      headers: mutateHeaders(),
    });
    if (!res.ok) {
      setSuggestionError(describeError(res.error, "Couldn't reject that suggestion."));
      return;
    }
    setAnnouncement('Suggestion rejected.');
    load();
  }

  if (pageStatus === 'loading') {
    return (
      <main className={styles.page} data-density="dense">
        <h1 className={styles.title}>Matching</h1>
        <Card>
          <Skeleton lines={4} />
        </Card>
      </main>
    );
  }

  if (pageStatus === 'forbidden') {
    return (
      <main className={styles.page} data-density="dense">
        <h1 className={styles.title}>Matching</h1>
        <Alert tone="warning" title="Matching configuration permission required">
          Matching ranking, weights and suggestion review are scoped to the `matching.config` admin permission (spec 017 §3) — your account doesn't currently hold it.
        </Alert>
      </main>
    );
  }

  if (pageStatus === 'error') {
    return (
      <main className={styles.page} data-density="dense">
        <h1 className={styles.title}>Matching</h1>
        <ErrorState description={pageError ?? undefined} onRetry={load} />
      </main>
    );
  }

  const poolColumns: TableColumn<MatchExplainabilityDto['eligiblePool'][number]>[] = [
    { key: 'rank', header: 'Rank', numeric: true, render: (r) => String(r.rank) },
    { key: 'businessName', header: 'Provider', render: (r) => r.businessName ?? r.providerProfileId },
    { key: 'score', header: 'Score', numeric: true, render: (r) => r.score.toFixed(3) },
    {
      key: 'notified',
      header: 'Notified',
      render: (r) => (
        <Badge tone={r.notified ? 'success' : 'neutral'} size="sm">
          {r.notified ? 'Yes' : 'No'}
        </Badge>
      ),
    },
    {
      key: 'exploration',
      header: 'Exploration',
      render: (r) => (r.explorationBoosted ? <Badge tone="info" size="sm">Boosted</Badge> : null),
    },
    { key: 'response', header: 'Response', render: (r) => r.providerResponse },
  ];

  const excludedColumns: TableColumn<MatchExplainabilityDto['excluded'][number]>[] = [
    { key: 'businessName', header: 'Provider', render: (r) => r.businessName ?? r.providerProfileId },
    { key: 'reason', header: 'Excluded because', render: (r) => r.reason },
  ];

  const suggestionColumns: TableColumn<MatchingSuggestionDto>[] = [
    { key: 'serviceId', header: 'Service', render: (s) => s.serviceId ?? 'Platform default' },
    { key: 'source', header: 'Source', render: (s) => s.source },
    { key: 'rationale', header: 'Rationale', render: (s) => s.rationale ?? '—' },
    {
      key: 'actions',
      header: '',
      align: 'end',
      render: (s) => (
        <div className={styles.actions}>
          <Button variant="primary" size="sm" onClick={() => handleApproveSuggestion(s.id)}>
            Approve
          </Button>
          <Button variant="danger" size="sm" onClick={() => handleRejectSuggestion(s.id)}>
            Reject
          </Button>
        </div>
      ),
    },
  ];

  return (
    <main className={styles.page} data-density="dense">
      <h1 className={styles.title}>Matching</h1>

      <span role="status" aria-live="polite" className={styles.visuallyHidden}>
        {announcement}
      </span>

      <section aria-labelledby="explainability-heading" className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 id="explainability-heading" className={styles.sectionTitle}>
            Ranking explainability
          </h2>
          <p className={styles.sectionDescription}>
            Admin-only (AC-6): who was excluded from a request and why, and the score breakdown for those who were ranked. Never exposed to any provider or customer surface.
          </p>
        </div>
        {explainError ? (
          <Alert tone="error" title="Something went wrong">
            {explainError}
          </Alert>
        ) : null}
        <Card elevation="flat" className={styles.form}>
          <div className={styles.formField}>
            <FormField label="Request id" htmlFor="lookup-request-id">
              <Input id="lookup-request-id" value={lookupRequestId} onChange={(e) => setLookupRequestId(e.target.value)} placeholder="request uuid" />
            </FormField>
          </div>
          <div className={styles.actions}>
            <Button variant="primary" loading={explainPending} onClick={handleLookupMatches}>
              Look up
            </Button>
          </div>
        </Card>

        {explainability ? (
          <>
            <p className={styles.sectionDescription}>
              Pool size {explainability.poolSize} · {explainability.eligiblePool.length} eligible · {explainability.excluded.length} excluded
            </p>
            <Table columns={poolColumns} rows={explainability.eligiblePool} caption="Eligible, ranked pool" emptyMessage="No eligible providers." />
            <Table columns={excludedColumns} rows={explainability.excluded} caption="Excluded providers" emptyMessage="No excluded providers." />
          </>
        ) : null}
      </section>

      <section aria-labelledby="weights-heading" className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 id="weights-heading" className={styles.sectionTitle}>
            Matching weights
          </h2>
          <p className={styles.sectionDescription}>
            Per-service ranking weight and pool-size override (AC-2). The nine factors must sum to exactly 100. There is no read-back endpoint in the approved API — fields start at the platform defaults.
          </p>
        </div>
        {weightsError ? (
          <Alert tone="error" title="Something went wrong">
            {weightsError}
          </Alert>
        ) : null}
        <Card elevation="flat" className={styles.form}>
          <div className={styles.formField}>
            <FormField label="Service id" htmlFor="weights-service-id">
              <Input id="weights-service-id" value={weightsServiceId} onChange={(e) => setWeightsServiceId(e.target.value)} placeholder="service uuid" />
            </FormField>
          </div>
          {RANKING_FACTORS.map((factor: RankingFactor) => (
            <div className={styles.formField} key={factor}>
              <FormField label={factor} htmlFor={`weight-${factor}`}>
                <Input
                  id={`weight-${factor}`}
                  type="number"
                  min={0}
                  max={100}
                  value={weights[factor]}
                  onChange={(e) => setWeights((prev) => ({ ...prev, [factor]: Number(e.target.value) }))}
                />
              </FormField>
            </div>
          ))}
          <div className={styles.formField}>
            <FormField label="Pool size" htmlFor="pool-size" help="1-50">
              <Input id="pool-size" type="number" min={1} max={50} value={poolSize} onChange={(e) => setPoolSize(e.target.value)} />
            </FormField>
          </div>
          <p className={styles.sectionDescription}>Total: {weightsTotal} (must equal 100)</p>
          <div className={styles.actions}>
            <Button variant="primary" loading={weightsPending} onClick={handleSaveWeights}>
              Save weights
            </Button>
          </div>
        </Card>
      </section>

      <section aria-labelledby="suggestions-heading" className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 id="suggestions-heading" className={styles.sectionTitle}>
            AI suggestions pending review
          </h2>
          <p className={styles.sectionDescription}>
            AC-7: a suggestion is never applied automatically. Approving applies its weights to the target service immediately; rejecting discards it.
          </p>
        </div>
        {suggestionError ? (
          <Alert tone="error" title="Something went wrong">
            {suggestionError}
          </Alert>
        ) : null}
        <Table
          columns={suggestionColumns}
          rows={suggestions.filter((s) => s.status === 'pending_review')}
          caption="Pending AI matching suggestions"
          emptyMessage="No suggestions pending review."
        />
      </section>
    </main>
  );
}
