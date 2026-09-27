'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import { Badge, Button, Card, DirectionalIcon, EmptyState, ErrorState, Icon, SearchBar, Skeleton, Tag } from '@/components';
import { useLocale } from '@/app/_components/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/dictionaries/en';
import type { PricingModel } from '@/lib/types/catalog';
import type { CategoryPageDto } from '@/lib/types/service-page';
import { imageForCategoryName } from '../../category-images';
import styles from '../explore-browse.module.css';

type PageStatus = 'loading' | 'error' | 'ready';

/** How the catalog's own `pricingModel` (spec 010) reads to a customer. Describes the pricing
 * *model* the service is published with — never an amount, since no price is in this payload. */
const PRICING_LABEL: Record<PricingModel, MessageKey> = {
  fixed: 'category.pricing.fixed',
  package: 'category.pricing.package',
  hourly: 'category.pricing.hourly',
  quote: 'category.pricing.quote',
  custom: 'category.pricing.custom',
};

/**
 * Spec 011 §3/AC-1, `app/explore/[category]` — reads `GET /api/v1/categories/{id}/page`.
 * Renders every AC-1 section (header, popular services, search entry, recommended providers,
 * nearby availability, filters, AI-assist entry point) — never a bare list. Real search/filter
 * logic (spec 013), recommended-provider ranking (spec 017), and nearby-availability data (spec
 * 016) are out of this spec's scope (§7); those sections render as honest placeholders rather
 * than fabricated data. Per CLAUDE.md's branding rule, no logo/header of its own.
 *
 * The visual layer gives the route's category immediate context (breadcrumb, representative
 * photo, real counts), keeps the search console as the page's primary control, and presents the
 * category's published services as a scannable result list. The search form still deep-links into
 * `/search` with exactly the same params as before — query interpretation, filters, sort and
 * pagination remain spec 013's, never reimplemented here.
 */
export default function CategoryPage() {
  const { t, errorText } = useLocale();
  const params = useParams<{ category: string }>();
  const router = useRouter();
  const categoryId = params.category;

  const [status, setStatus] = useState<PageStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<CategoryPageDto | null>(null);
  const [searchText, setSearchText] = useState('');

  const load = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      const res = await fetch(`/api/v1/categories/${encodeURIComponent(categoryId)}/page`);
      const json = await res.json();
      if (!res.ok) {
        setStatus('error');
        setError(errorText(json.code, json.message, t('category.loadFailed')));
        return;
      }
      setPage(json.data as CategoryPageDto);
      setStatus('ready');
    } catch {
      setStatus('error');
      setError(t('category.loadFailed'));
    }
  }, [categoryId, errorText, t]);

  useEffect(() => {
    load();
  }, [load]);

  if (status === 'loading') {
    return (
      <main className={styles.page}>
        <div className={styles.head}>
          <Skeleton width="160px" height={12} />
          <Skeleton width="280px" height={28} />
        </div>
        <div className={styles.searchPanel}>
          <Skeleton lines={2} />
        </div>
        <div className={styles.serviceList}>
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <Skeleton lines={2} />
            </Card>
          ))}
        </div>
      </main>
    );
  }

  if (status === 'error' || !page) {
    return (
      <main className={styles.page}>
        <div className={styles.stateCard}>
          <ErrorState description={error ?? undefined} onRetry={load} />
        </div>
      </main>
    );
  }

  const subcategoryNameById = new Map(page.filters.map((sub) => [sub.id, sub.name]));

  /** Spec 013 owns real search: this only deep-links into it, scoped to this category. */
  function submitSearch(text: string) {
    const qs = new URLSearchParams({ categoryId });
    if (text.trim()) qs.set('q', text.trim());
    router.push(`/search?${qs.toString()}`);
  }

  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <span className={styles.eyebrow}>
          <Link href="/explore" className={styles.eyebrowLink}>
            {t('category.explore')}
          </Link>
          <DirectionalIcon name="chevron-right" size="xs" className={styles.eyebrowSeparator} />
          <span className={styles.eyebrowCurrent}>{page.name}</span>
        </span>
        <div className={styles.contextRow}>
          <span className={styles.contextThumb}>
            <Image
              src={imageForCategoryName(page.name)}
              alt={t('category.imageAlt', { name: page.name })}
              fill
              sizes="72px"
              style={{ objectFit: 'cover' }}
            />
          </span>
          <div className={styles.contextMeta}>
            <h1 className={styles.title}>{page.name}</h1>
            <p className={styles.metaLine}>
              <span data-numeric>
                {t(page.popularServices.length === 1 ? 'category.serviceOne' : 'category.serviceMany', { count: page.popularServices.length })}
              </span>
              {page.filters.length > 0 ? (
                <>
                  <span className={styles.metaDot}>·</span>
                  <span data-numeric>
                    {t(page.filters.length === 1 ? 'category.specialityOne' : 'category.specialityMany', { count: page.filters.length })}
                  </span>
                </>
              ) : null}
            </p>
          </div>
        </div>
      </header>

      {/* Spec 013 replaces this category's search placeholder — real search/filter logic
       * lives at app/search, not duplicated here; this just deep-links into it. */}
      <section className={styles.searchPanel} aria-labelledby="category-search-label">
        <span className={styles.searchLabel} id="category-search-label">
          {t('category.searchLabel', { name: page.name.toLowerCase() })}
        </span>
        <SearchBar
          value={searchText}
          onChange={setSearchText}
          onSubmit={submitSearch}
          placeholder={t('category.searchPlaceholder', { name: page.name.toLowerCase() })}
        />
        <p className={styles.searchHint}>
          <Icon name="info" size="xs" color="var(--text-subtle)" />
          {t('category.searchHint', { name: page.name.toLowerCase() })}
        </p>
      </section>

      {page.filters.length > 0 ? (
        <section className={styles.refineRow}>
          <span className={styles.refineLabel}>{t('category.specialities')}</span>
          <div className={styles.chips}>
            {page.filters.map((sub) => (
              <Tag key={sub.id}>{sub.name}</Tag>
            ))}
          </div>
        </section>
      ) : null}

      <section className={styles.results}>
        <div className={styles.resultsBar}>
          <h2 className={styles.resultsTitle}>{t('category.services')}</h2>
          <span className={styles.resultsCount} data-numeric>
            {t(page.popularServices.length === 1 ? 'category.resultOne' : 'category.resultMany', { count: page.popularServices.length })}
          </span>
        </div>

        {page.popularServices.length === 0 ? (
          <div className={styles.stateCard}>
            <EmptyState
              icon="search"
              title={t('category.emptyTitle')}
              description={t('category.emptyDescription', { name: page.name })}
              action={
                <div className={styles.emptyActions}>
                  <Button variant="primary" iconLeft="search" onClick={() => submitSearch('')}>
                    {t('category.searchCategory')}
                  </Button>
                  <Link href="/explore">
                    <Button variant="secondary">{t('category.browseAll')}</Button>
                  </Link>
                </div>
              }
            />
          </div>
        ) : (
          <div className={styles.serviceList}>
            {page.popularServices.map((service) => {
              const subcategoryName = service.subcategoryId ? subcategoryNameById.get(service.subcategoryId) : undefined;
              return (
                <Link key={service.id} href={`/explore/${categoryId}/${service.id}`} className={styles.serviceLink}>
                  <Card interactive>
                    <div className={styles.serviceRow}>
                      <span className={styles.serviceIconTile}>
                        <Icon name="briefcase" size="sm" color="var(--teal-600)" />
                      </span>
                      <div className={styles.serviceMain}>
                        <h3 className={styles.serviceName}>{service.name}</h3>
                        {subcategoryName ? (
                          <div className={styles.serviceMeta}>
                            <span>{subcategoryName}</span>
                          </div>
                        ) : null}
                      </div>
                      <span className={styles.serviceAside}>
                        <Badge tone="neutral" size="sm" icon={null}>
                          {t(PRICING_LABEL[service.pricingModel])}
                        </Badge>
                        <DirectionalIcon name="chevron-right" size="sm" color="var(--text-subtle)" />
                      </span>
                    </div>
                  </Card>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      <div className={styles.noteGrid}>
        <p className={styles.note}>
          <Icon name="users" size="sm" color="var(--text-subtle)" />
          <span>
            <span className={styles.noteTitle}>{t('category.recommendedTitle')}</span>
            {t('category.recommendedBody')}
          </span>
        </p>
        <p className={styles.note}>
          <Icon name="map-pin" size="sm" color="var(--text-subtle)" />
          <span>
            <span className={styles.noteTitle}>{t('category.nearbyTitle')}</span>
            {t('category.nearbyBody')}
          </span>
        </p>
        <p className={`${styles.note} ${styles.aiNote}`}>
          <Icon name="sparkles" size="sm" color="var(--ai-accent)" />
          <span>
            <span className={styles.noteTitle}>{t('category.aiTitle')}</span>
            {t('category.aiBody')}
          </span>
        </p>
      </div>
    </main>
  );
}
