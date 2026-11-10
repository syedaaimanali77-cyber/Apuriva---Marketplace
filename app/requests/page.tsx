'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Badge, Button, Card, DirectionalIcon, EmptyState, ErrorState, Icon, Skeleton } from '@/components';
import { useLocale } from '@/app/_components/LocaleProvider';
import { formatDate } from '@/lib/i18n/format';
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
  const { locale, t, errorText } = useLocale();
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
      setError(errorText(result.error?.code, result.error?.message, t('requests.list.loadFailed')));
      setStatus('error');
      return;
    }
    setRequests(result.data ?? []);
    setPageInfo(result.page ?? { limit: PAGE_LIMIT, offset, total: 0, nextOffset: null });
    setStatus('ready');
  }, [errorText, t]);

  useEffect(() => {
    load(filter, 0);
  }, [load, filter]);

  const head = (
    <header className={styles.head}>
      <span className={styles.eyebrow}>
        <Icon name="file-text" size="xs" />
        {t('requests.list.eyebrow')}
      </span>
      <h1 className={styles.title}>{t('requests.list.title')}</h1>
      <p className={styles.lede}>{t('requests.list.lede')}</p>
    </header>
  );

  const tabs = (
    <div className={styles.tabs} role="tablist" aria-label={t('requests.list.filter')}>
      {(['active', 'history'] as RequestListFilter[]).map((value) => (
        <Button
          key={value}
          role="tab"
          aria-selected={filter === value}
          variant={filter === value ? 'primary' : 'ghost'}
          size="sm"
          onClick={() => setFilter(value)}
        >
          {value === 'active' ? t('requests.list.active') : t('requests.list.history')}
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
            title={filter === 'active' ? t('requests.list.emptyActiveTitle') : t('requests.list.emptyHistoryTitle')}
            description={filter === 'active' ? t('requests.list.emptyActive') : t('requests.list.emptyHistory')}
            action={
              <Link href="/explore">
                <Button variant="primary" iconLeft="compass">
                  {t('requests.list.explore')}
                </Button>
              </Link>
            }
            secondaryAction={
              <Link href="/search">
                <Button variant="secondary" iconLeft="search">
                  {t('requests.list.search')}
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
                        <span>{formatDate(request.createdAt, locale)}</span>
                        {request.offerCount > 0 ? (
                          <>
                            <span className={styles.metaDot}>·</span>
                            <span data-numeric>
                              {t(request.offerCount === 1 ? 'requests.list.offerOne' : 'requests.list.offerMany', { count: request.offerCount })}
                            </span>
                          </>
                        ) : null}
                      </p>
                    </div>
                    <span className={styles.rowAside}>
                      <Badge tone={request.status === 'cancelled' ? 'neutral' : 'brand'} size="sm" icon={null}>
                        {t(`requestDetail.step.${request.status}`)}
                      </Badge>
                      <DirectionalIcon name="chevron-right" size="sm" color="var(--text-subtle)" />
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
                {t('requests.list.previous')}
              </Button>
              <span className={styles.pageCount} data-numeric>
                {t('requests.list.pageCount', {
                  from: pageInfo.offset + 1,
                  to: Math.min(pageInfo.offset + pageInfo.limit, pageInfo.total),
                  total: pageInfo.total,
                })}
              </span>
              <Button
                variant="secondary"
                disabled={pageInfo.nextOffset === null}
                onClick={() => load(filter, pageInfo.nextOffset ?? 0)}
              >
                {t('requests.list.next')}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </main>
  );
}
