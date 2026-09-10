'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Card, EmptyState, ErrorState, Input, Skeleton } from '@/components';
import type { CategoryPageDto } from '@/lib/types/service-page';
import styles from '../explore.module.css';

type PageStatus = 'loading' | 'error' | 'ready';

/**
 * Spec 011 §3/AC-1, `app/explore/[category]` — reads `GET /api/v1/categories/{id}/page`.
 * Renders every AC-1 section (header, popular services, search entry, recommended providers,
 * nearby availability, filters, AI-assist entry point) — never a bare list. Real search/filter
 * logic (spec 013), recommended-provider ranking (spec 017), and nearby-availability data (spec
 * 016) are out of this spec's scope (§7); those sections render as honest placeholders rather
 * than fabricated data. Per CLAUDE.md's branding rule, no logo/header of its own.
 */
export default function CategoryPage() {
  const params = useParams<{ category: string }>();
  const categoryId = params.category;

  const [status, setStatus] = useState<PageStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<CategoryPageDto | null>(null);

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
        <Skeleton lines={2} />
        <div className={styles.grid}>
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
        <ErrorState description={error ?? undefined} onRetry={load} />
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>{page.name}</h1>

      <div className={styles.section}>
        <Input type="search" placeholder={`Search ${page.name.toLowerCase()}...`} aria-label="Search this category" disabled />
      </div>

      {page.filters.length > 0 ? (
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Filters</h2>
          <div className={styles.filterChips}>
            {page.filters.map((sub) => (
              <span key={sub.id} className={styles.filterChip}>
                {sub.name}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Popular services</h2>
        {page.popularServices.length === 0 ? (
          <EmptyState icon="compass" title="No services yet" description="Check back soon." compact />
        ) : (
          <div className={styles.grid}>
            {page.popularServices.map((service) => (
              <Link key={service.id} href={`/explore/${categoryId}/${service.id}`} style={{ textDecoration: 'none' }}>
                <Card interactive className={styles.categoryCard}>
                  <h3 className={styles.categoryName}>{service.name}</h3>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Recommended providers</h2>
        <p className={styles.placeholderBox}>Provider recommendations for this category are coming soon.</p>
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Availability near you</h2>
        <p className={styles.placeholderBox}>Share your location to see nearby availability.</p>
      </div>

      <div className={styles.section}>
        <p className={styles.placeholderBox}>Not sure what you need? Ask Apuriva's AI assistant.</p>
      </div>
    </main>
  );
}
