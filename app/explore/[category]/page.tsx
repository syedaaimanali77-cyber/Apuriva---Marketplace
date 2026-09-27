'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import { Badge, Button, Card, EmptyState, ErrorState, Icon, SearchBar, Skeleton, Tag } from '@/components';
import type { PricingModel } from '@/lib/types/catalog';
import type { CategoryPageDto } from '@/lib/types/service-page';
import { imageForCategoryName } from '../../category-images';
import styles from '../explore-browse.module.css';

type PageStatus = 'loading' | 'error' | 'ready';

/** How the catalog's own `pricingModel` (spec 010) reads to a customer. Describes the pricing
 * *model* the service is published with — never an amount, since no price is in this payload. */
const PRICING_LABEL: Record<PricingModel, string> = {
  fixed: 'Fixed price',
  package: 'Package pricing',
  hourly: 'Hourly rate',
  quote: 'Quote on request',
  custom: 'Custom pricing',
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
        setError(json.message ?? "Couldn't load this category.");
        return;
      }
      setPage(json.data as CategoryPageDto);
      setStatus('ready');
    } catch {
      setStatus('error');
      setError("Couldn't load this category.");
    }
  }, [categoryId]);

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
            Explore
          </Link>
          <Icon name="chevron-right" size="xs" className={styles.eyebrowSeparator} />
          <span className={styles.eyebrowCurrent}>{page.name}</span>
        </span>
        <div className={styles.contextRow}>
          <span className={styles.contextThumb}>
            <Image
              src={imageForCategoryName(page.name)}
              alt={`${page.name} services`}
              fill
              sizes="72px"
              style={{ objectFit: 'cover' }}
            />
          </span>
          <div className={styles.contextMeta}>
            <h1 className={styles.title}>{page.name}</h1>
            <p className={styles.metaLine}>
              <span data-numeric>
                {page.popularServices.length} {page.popularServices.length === 1 ? 'service' : 'services'}
              </span>
              {page.filters.length > 0 ? (
                <>
                  <span className={styles.metaDot}>·</span>
                  <span data-numeric>
                    {page.filters.length} {page.filters.length === 1 ? 'speciality' : 'specialities'}
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
          What do you need in {page.name.toLowerCase()}?
        </span>
        <SearchBar
          value={searchText}
          onChange={setSearchText}
          onSubmit={submitSearch}
          placeholder={`Search ${page.name.toLowerCase()}...`}
        />
        <p className={styles.searchHint}>
          <Icon name="info" size="xs" color="var(--text-subtle)" />
          Results stay inside {page.name.toLowerCase()} and can be filtered by location, budget and price.
        </p>
      </section>

      {page.filters.length > 0 ? (
        <section className={styles.refineRow}>
          <span className={styles.refineLabel}>Specialities in this category</span>
          <div className={styles.chips}>
            {page.filters.map((sub) => (
              <Tag key={sub.id}>{sub.name}</Tag>
            ))}
          </div>
        </section>
      ) : null}

      <section className={styles.results}>
        <div className={styles.resultsBar}>
          <h2 className={styles.resultsTitle}>Services</h2>
          <span className={styles.resultsCount} data-numeric>
            {page.popularServices.length} {page.popularServices.length === 1 ? 'result' : 'results'}
          </span>
        </div>

        {page.popularServices.length === 0 ? (
          <div className={styles.stateCard}>
            <EmptyState
              icon="search"
              title="Nothing in this category yet"
              description={`No published services matched ${page.name}. Search the whole catalog, or start from another category.`}
              action={
                <div className={styles.emptyActions}>
                  <Button variant="primary" iconLeft="search" onClick={() => submitSearch('')}>
                    Search this category
                  </Button>
                  <Link href="/explore">
                    <Button variant="secondary">Browse all categories</Button>
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
                          {PRICING_LABEL[service.pricingModel]}
                        </Badge>
                        <Icon name="chevron-right" size="sm" color="var(--text-subtle)" />
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
            <span className={styles.noteTitle}>Recommended providers</span>
            Provider recommendations for this category are coming soon.
          </span>
        </p>
        <p className={styles.note}>
          <Icon name="map-pin" size="sm" color="var(--text-subtle)" />
          <span>
            <span className={styles.noteTitle}>Availability near you</span>
            Share your location to see nearby availability.
          </span>
        </p>
        <p className={`${styles.note} ${styles.aiNote}`}>
          <Icon name="sparkles" size="sm" color="var(--ai-accent)" />
          <span>
            <span className={styles.noteTitle}>Not sure what you need?</span>
            Ask Apuriva&apos;s AI assistant.
          </span>
        </p>
      </div>
    </main>
  );
}
