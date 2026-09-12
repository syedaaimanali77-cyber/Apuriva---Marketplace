'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Badge, Button, Card, EmptyState, ErrorState, Icon, Skeleton } from '@/components';
import type { RequestListFilter, RequestSummaryDto } from '@/lib/types/requests';
import { apiFetch } from './api-client';
import styles from './requests.module.css';

type PageStatus = 'loading' | 'error' | 'ready';

const PAGE_LIMIT = 20;

/**
 * Spec 015 §5, `/requests` — the customer's own requests. Replaces spec 014's `PlaceholderPage`.
 * §5 Empty: no active requests offers a browse/search CTA rather than dead-ending (master spec
 * §22). AC-5: every row shows the customer-facing step the server derived, never an internal
 * matching mechanic. Per CLAUDE.md's branding rule, no logo/header of its own.
 */
export default function RequestsPage() {
  const [status, setStatus] = useState<PageStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<RequestListFilter>('active');
  const [requests, setRequests] = useState<RequestSummaryDto[]>([]);
  const [pageInfo, setPageInfo] = useState({ limit: PAGE_LIMIT, offset: 0, total: 0, nextOffset: null as number | null });

  const load = useCallback(async (nextFilter: RequestListFilter, offset: number) => {
    setStatus('loading');
    setError(null);
    const params = new URLSearchParams({ filter: nextFilter, limit: String(PAGE_LIMIT), offset: String(offset) });
    const result = await apiFetch<RequestSummaryDto[]>(`/api/v1/requests?${params.toString()}`);
    if (!result.ok) {
      setError(result.error?.message ?? "Couldn't load your requests.");
      setStatus('error');
      return;
    }
    setRequests(result.data ?? []);
    setPageInfo(result.page ?? { limit: PAGE_LIMIT, offset, total: 0, nextOffset: null });
    setStatus('ready');
  }, []);

  useEffect(() => {
    load(filter, 0);
  }, [load, filter]);

  const head = (
    <header className={styles.head}>
      <span className={styles.eyebrow}>
        <Icon name="file-text" size="xs" />
        Requests
      </span>
      <h1 className={styles.title}>Your requests</h1>
      <p className={styles.lede}>Track what you&apos;ve asked for and where each request has got to.</p>
    </header>
  );

  const tabs = (
    <div className={styles.tabs} role="tablist" aria-label="Request list filter">
      {(['active', 'history'] as RequestListFilter[]).map((value) => (
        <Button
          key={value}
          role="tab"
          aria-selected={filter === value}
          variant={filter === value ? 'primary' : 'ghost'}
          size="sm"
          onClick={() => setFilter(value)}
        >
          {value === 'active' ? 'Active' : 'History'}
        </Button>
      ))}
    </div>
  );

  return (
    <main className={styles.page}>
      {head}
      {tabs}

      {status === 'loading' ? (
        <div className={styles.list}>
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <Skeleton lines={2} />
            </Card>
          ))}
        </div>
      ) : status === 'error' ? (
        <div className={styles.stateCard}>
          <ErrorState description={error ?? undefined} onRetry={() => load(filter, pageInfo.offset)} />
        </div>
      ) : requests.length === 0 ? (
        <div className={styles.stateCard}>
          <EmptyState
            icon="file-text"
            title={filter === 'active' ? 'No active requests' : 'No past requests'}
            description={
              filter === 'active'
                ? 'When you ask for a service, it appears here so you can follow its progress.'
                : 'Cancelled and completed requests will be listed here.'
            }
            action={
              <Link href="/explore">
                <Button variant="primary" iconLeft="compass">
                  Explore services
                </Button>
              </Link>
            }
            secondaryAction={
              <Link href="/search">
                <Button variant="secondary" iconLeft="search">
                  Search
                </Button>
              </Link>
            }
          />
        </div>
      ) : (
        <>
          <div className={styles.list}>
            {requests.map((request) => (
              <Link key={request.id} href={`/requests/${request.id}`} className={styles.rowLink}>
                <Card interactive>
                  <div className={styles.row}>
                    <span className={styles.rowIcon}>
                      <Icon name="file-text" size="sm" color="var(--teal-600)" />
                    </span>
                    <div className={styles.rowMain}>
                      <h2 className={styles.rowTitle}>{request.serviceName}</h2>
                      <p className={styles.rowMeta}>
                        <span>{new Date(request.createdAt).toLocaleDateString()}</span>
                        {request.offerCount > 0 ? (
                          <>
                            <span className={styles.metaDot}>·</span>
                            <span data-numeric>
                              {request.offerCount} {request.offerCount === 1 ? 'offer' : 'offers'}
                            </span>
                          </>
                        ) : null}
                      </p>
                    </div>
                    <span className={styles.rowAside}>
                      <Badge tone={request.status === 'cancelled' ? 'neutral' : 'brand'} size="sm" icon={null}>
                        {request.customerFacingStep}
                      </Badge>
                      <Icon name="chevron-right" size="sm" color="var(--text-subtle)" />
                    </span>
                  </div>
                </Card>
              </Link>
            ))}
          </div>

          {pageInfo.total > pageInfo.limit ? (
            <div className={styles.pagination}>
              <Button
                variant="secondary"
                disabled={pageInfo.offset === 0}
                onClick={() => load(filter, Math.max(0, pageInfo.offset - pageInfo.limit))}
              >
                Previous
              </Button>
              <span className={styles.pageCount} data-numeric>
                {pageInfo.offset + 1}-{Math.min(pageInfo.offset + pageInfo.limit, pageInfo.total)} of {pageInfo.total}
              </span>
              <Button
                variant="secondary"
                disabled={pageInfo.nextOffset === null}
                onClick={() => load(filter, pageInfo.nextOffset ?? 0)}
              >
                Next
              </Button>
            </div>
          ) : null}
        </>
      )}
    </main>
  );
}
