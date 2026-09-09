'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, EmptyState, ErrorState, Skeleton } from '@/components';
import type { CategoryDto } from '@/lib/types/catalog';
import styles from './explore.module.css';

type PageStatus = 'loading' | 'error' | 'ready';

/**
 * Spec 010 §3/AC-5/§5, `app/explore` — the customer-facing catalog browse. Reads
 * `GET /api/v1/categories` (published only, no auth) — the server is the sole authority on what's
 * visible here, never a client-side filter standing in for it. Category/service *detail*
 * rendering is spec 011's scope (§7 Out of scope) — this page only lists the published catalog.
 * Per CLAUDE.md's branding rule, no logo/header of its own.
 */
export default function ExplorePage() {
  const [status, setStatus] = useState<PageStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<CategoryDto[]>([]);

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

  if (status === 'loading') {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>Explore services</h1>
        <div className={styles.grid}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i}>
              <Skeleton lines={2} />
            </Card>
          ))}
        </div>
      </main>
    );
  }

  if (status === 'error') {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>Explore services</h1>
        <ErrorState description={error ?? undefined} onRetry={load} />
      </main>
    );
  }

  if (categories.length === 0) {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>Explore services</h1>
        <EmptyState icon="compass" title="No categories yet" description="Check back soon — the catalog is still being set up." />
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Explore services</h1>
      <p className={styles.subtitle}>Browse the categories available on Apuriva.</p>
      <div className={styles.grid}>
        {categories.map((category) => (
          <Card key={category.id} className={styles.categoryCard}>
            <h2 className={styles.categoryName}>{category.name}</h2>
            <p className={styles.categoryMeta}>
              {category.subcategories.length > 0 ? `${category.subcategories.length} subcategories` : 'No subcategories'}
            </p>
          </Card>
        ))}
      </div>
    </main>
  );
}
