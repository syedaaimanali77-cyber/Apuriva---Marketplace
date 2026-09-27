'use client';

import { useCallback, useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Card, EmptyState, ErrorState, Icon, SearchBar, Skeleton } from '@/components';
import type { CategoryDto } from '@/lib/types/catalog';
import { imageForCategoryName } from '../category-images';
import styles from './explore-browse.module.css';

type PageStatus = 'loading' | 'error' | 'ready';

/**
 * Spec 010 §3/AC-5/§5, `app/explore` — the customer-facing catalog browse. Reads
 * `GET /api/v1/categories` (published only, no auth) — the server is the sole authority on what's
 * visible here, never a client-side filter standing in for it. Category/service *detail*
 * rendering is spec 011's scope (§7 Out of scope) — this page only lists the published catalog.
 * Per CLAUDE.md's branding rule, no logo/header of its own.
 *
 * The visual layer is Explore-specific: a compact header, then the search console as the first
 * control (Explore is the "find something" surface, unlike the home feed's inspiration hero), then
 * the real published categories as results. Search itself is the already-shipped DS `SearchBar`
 * deep-linking into `/search`, where the real query interpretation, filters, sort and pagination
 * live (spec 013) — no search, filter or ranking logic is duplicated here.
 */
export default function ExplorePage() {
  const router = useRouter();
  const [status, setStatus] = useState<PageStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<CategoryDto[]>([]);
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      const res = await fetch('/api/v1/categories');
      const json = await res.json();
      if (!res.ok) {
        setStatus('error');
        setError(json.message ?? "Couldn't load the catalog.");
        return;
      }
      setCategories(json.data as CategoryDto[]);
      setStatus('ready');
    } catch {
      setStatus('error');
      setError("Couldn't load the catalog.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const head = (
    <header className={styles.head}>
      <span className={styles.eyebrow}>
        <Icon name="compass" size="xs" />
        Explore
      </span>
      <h1 className={styles.title}>Explore services</h1>
      <p className={styles.lede}>Search the Apuriva catalog, or start from a category to see the services inside it.</p>
    </header>
  );

  const searchPanel = (
    <section className={styles.searchPanel} aria-labelledby="explore-search-label">
      <span className={styles.searchLabel} id="explore-search-label">
        What service do you need?
      </span>
      <SearchBar
        value={query}
        onChange={setQuery}
        onSubmit={(text) => router.push(text.trim() ? `/search?q=${encodeURIComponent(text.trim())}` : '/search')}
        placeholder="Try “deep cleaning” or “emergency electrician”"
      />
      <p className={styles.searchHint}>
        <Icon name="info" size="xs" color="var(--text-subtle)" />
        Searching takes you to results you can filter by location, budget and price.
      </p>
    </section>
  );

  if (status === 'loading') {
    return (
      <main className={styles.page}>
        {head}
        {searchPanel}
        <div className={styles.cardGrid}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} padding={0}>
              <div className={styles.categoryMedia} />
              <div className={styles.categoryBody}>
                <Skeleton lines={2} />
              </div>
            </Card>
          ))}
        </div>
      </main>
    );
  }

  if (status === 'error') {
    return (
      <main className={styles.page}>
        {head}
        {searchPanel}
        <div className={styles.stateCard}>
          <ErrorState description={error ?? undefined} onRetry={load} />
        </div>
      </main>
    );
  }

  if (categories.length === 0) {
    return (
      <main className={styles.page}>
        {head}
        {searchPanel}
        <div className={styles.stateCard}>
          <EmptyState
            icon="compass"
            title="No categories yet"
            description="Check back soon — the catalog is still being set up."
            action={
              <Link href="/search">
                <Button variant="secondary" iconLeft="search">
                  Search all services
                </Button>
              </Link>
            }
          />
        </div>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      {head}
      {searchPanel}

      <section className={styles.results}>
        <div className={styles.resultsBar}>
          <h2 className={styles.resultsTitle}>Browse by category</h2>
          <span className={styles.resultsCount} data-numeric>
            {categories.length} {categories.length === 1 ? 'category' : 'categories'}
          </span>
        </div>

        <div className={styles.cardGrid}>
          {categories.map((category) => (
            <Link key={category.id} href={`/explore/${category.id}`} className={styles.categoryLink}>
              <Card interactive padding={0} style={{ overflow: 'hidden', height: '100%' }}>
                <div className={styles.categoryMedia}>
                  <Image
                    src={imageForCategoryName(category.name)}
                    alt={`${category.name} services`}
                    fill
                    sizes="(max-width: 640px) 100vw, 320px"
                    style={{ objectFit: 'cover' }}
                  />
                </div>
                <div className={styles.categoryBody}>
                  <h3 className={styles.categoryName}>{category.name}</h3>
                  {/* Only when the catalog actually publishes specialities for this category —
                      a "none listed" line on every card would be noise, not information. */}
                  {category.subcategories.length > 0 ? (
                    <p className={styles.metaLine} data-numeric>
                      {category.subcategories.length} {category.subcategories.length === 1 ? 'speciality' : 'specialities'}
                    </p>
                  ) : null}
                  <span className={styles.categoryFoot}>
                    <span className={styles.browseCue}>
                      Browse
                      <Icon name="arrow-right" size="xs" />
                    </span>
                  </span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
