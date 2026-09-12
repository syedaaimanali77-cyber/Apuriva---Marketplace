'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button, Card, EmptyState, ErrorState, Icon, IntentChip, ListRow, ResultCard, SearchBar, Select, Skeleton } from '@/components';
import type { AutocompleteSuggestionDto, SearchIntentDto, SearchResultDto, SearchSort } from '@/lib/types/search';
import styles from './search.module.css';

interface ApiErrorBody {
  code: string;
  message: string;
}

interface ApiResult<T> {
  ok: boolean;
  data?: T;
  page?: { limit: number; offset: number; total: number; nextOffset: number | null };
  error?: ApiErrorBody;
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  if (res.status === 204) return { ok: true };
  const json = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, data: json.data as T, page: json.page } : { ok: false, error: json as ApiErrorBody };
}

function readCsrfCookie(): string {
  return document.cookie.split('; ').find((row) => row.startsWith('apuriva_csrf='))?.split('=')[1] ?? '';
}

function mutateHeaders(): Record<string, string> {
  return { 'content-type': 'application/json', 'x-csrf-token': readCsrfCookie() };
}

/** Server-safe: defaults to desktop until the effect below resolves the real viewport (AC-4). */
function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(max-width: 640px)');
    setIsMobile(query.matches);
    const listener = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }, []);
  return isMobile;
}

type PageStatus = 'loading' | 'error' | 'ready';

interface Filters {
  q?: string;
  serviceId?: string;
  categoryId?: string;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  budgetMaxMinorUnits?: number;
  sort?: SearchSort;
}

function buildQueryString(filters: Filters, page: { limit: number; offset: number }): string {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  if (filters.serviceId) params.set('serviceId', filters.serviceId);
  if (filters.categoryId) params.set('categoryId', filters.categoryId);
  if (filters.lat !== undefined) params.set('lat', String(filters.lat));
  if (filters.lng !== undefined) params.set('lng', String(filters.lng));
  if (filters.radiusKm !== undefined) params.set('radiusKm', String(filters.radiusKm));
  if (filters.budgetMaxMinorUnits !== undefined) params.set('budgetMaxMinorUnits', String(filters.budgetMaxMinorUnits));
  if (filters.sort) params.set('sort', filters.sort);
  params.set('limit', String(page.limit));
  params.set('offset', String(page.offset));
  return params.toString();
}

const PAGE_LIMIT = 20;

const SORT_OPTIONS: { value: SearchSort; label: string }[] = [
  { value: 'relevance', label: 'Relevance' },
  { value: 'distance', label: 'Distance' },
  { value: 'price_asc', label: 'Price: low to high' },
  { value: 'price_desc', label: 'Price: high to low' },
];

/**
 * Spec 013 §5 — the search/discovery experience. AC-1: interpreted intent shown as removable
 * chips before/alongside results, results always from `/api/v1/search` (never from
 * `/search/interpret` directly). AC-3: empty state offers actionable next steps. AC-4: desktop
 * pagination, mobile infinite scroll, filters/sort persist across either. AC-5: voice input is
 * `SearchBar`'s job, never a separate trust path here. Per CLAUDE.md's branding rule, no
 * logo/header of its own.
 */
export default function SearchPage() {
  const urlParams = useSearchParams();
  const isMobile = useIsMobile();

  const [queryText, setQueryText] = useState('');
  const [filters, setFilters] = useState<Filters>({});
  const [intent, setIntent] = useState<SearchIntentDto | null>(null);
  const [interpretFailed, setInterpretFailed] = useState(false);

  const [status, setStatus] = useState<PageStatus>('ready');
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SearchResultDto[]>([]);
  const [pageInfo, setPageInfo] = useState({ limit: PAGE_LIMIT, offset: 0, total: 0, nextOffset: null as number | null });
  const [loadingMore, setLoadingMore] = useState(false);

  const [suggestions, setSuggestions] = useState<AutocompleteSuggestionDto[]>([]);

  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const runSearch = useCallback(async (nextFilters: Filters, offset: number, append: boolean) => {
    if (append) setLoadingMore(true);
    else setStatus('loading');
    setError(null);

    const qs = buildQueryString(nextFilters, { limit: PAGE_LIMIT, offset });
    const res = await apiFetch<SearchResultDto[]>(`/api/v1/search?${qs}`);

    if (!res.ok) {
      setStatus('error');
      setError(res.error?.message ?? "We couldn't load results. Your filters are saved.");
      setLoadingMore(false);
      return;
    }

    setResults((prev) => (append ? [...prev, ...(res.data ?? [])] : res.data ?? []));
    setPageInfo(res.page ?? { limit: PAGE_LIMIT, offset, total: 0, nextOffset: null });
    setStatus('ready');
    setLoadingMore(false);

    if ((res.data ?? []).length > 0 && !append) {
      apiFetch('/api/v1/search/recent', {
        method: 'POST',
        headers: mutateHeaders(),
        body: JSON.stringify({ q: nextFilters.q, serviceId: nextFilters.serviceId, categoryId: nextFilters.categoryId }),
      }).catch(() => {});
    }
  }, []);

  const handleSearch = useCallback(
    async (text: string) => {
      setIntent(null);
      setInterpretFailed(false);
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        await runSearch(filters, 0, false);
        return;
      }

      const interpretRes = await apiFetch<SearchIntentDto>('/api/v1/search/interpret', {
        method: 'POST',
        headers: mutateHeaders(),
        body: JSON.stringify({ text: trimmed }),
      });

      if (!interpretRes.ok) {
        // §9 fallback: interpretation unavailable/low-confidence — plain keyword search.
        setInterpretFailed(true);
        const nextFilters: Filters = { ...filters, q: trimmed, serviceId: undefined, categoryId: undefined };
        setFilters(nextFilters);
        await runSearch(nextFilters, 0, false);
        return;
      }

      const resolvedIntent = interpretRes.data!;
      setIntent(resolvedIntent);

      let lat: number | undefined;
      let lng: number | undefined;
      if (resolvedIntent.area) {
        const geocodeRes = await apiFetch<{ latitude?: number; longitude?: number }>('/api/v1/location/geocode', {
          method: 'POST',
          headers: mutateHeaders(),
          body: JSON.stringify({ address: resolvedIntent.area }),
        });
        if (geocodeRes.ok) {
          lat = geocodeRes.data!.latitude;
          lng = geocodeRes.data!.longitude;
        }
      }

      const nextFilters: Filters = {
        ...filters,
        q: resolvedIntent.serviceId ? undefined : resolvedIntent.serviceNameRaw ?? trimmed,
        serviceId: resolvedIntent.serviceId,
        budgetMaxMinorUnits: resolvedIntent.budgetMaxMinorUnits,
        lat,
        lng,
      };
      setFilters(nextFilters);
      await runSearch(nextFilters, 0, false);
    },
    [filters, runSearch],
  );

  // Deep-link support from app/explore/[category]'s search entry point.
  useEffect(() => {
    const categoryId = urlParams.get('categoryId') ?? undefined;
    const q = urlParams.get('q') ?? undefined;
    if (categoryId || q) {
      setQueryText(q ?? '');
      const initial: Filters = { categoryId, q };
      setFilters(initial);
      runSearch(initial, 0, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (queryText.trim().length < 2) {
      setSuggestions([]);
      return;
    }
    const timer = setTimeout(() => {
      apiFetch<AutocompleteSuggestionDto[]>(`/api/v1/search/autocomplete?q=${encodeURIComponent(queryText)}`).then((res) => {
        if (res.ok) setSuggestions(res.data ?? []);
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [queryText]);

  // AC-4 mobile infinite scroll.
  useEffect(() => {
    if (!isMobile || pageInfo.nextOffset === null || status !== 'ready' || loadingMore) return;
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) runSearch(filters, pageInfo.nextOffset!, true);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [isMobile, pageInfo.nextOffset, status, loadingMore, filters, runSearch]);

  function removeServiceFilter() {
    const nextFilters = { ...filters, serviceId: undefined };
    setFilters(nextFilters);
    if (intent) setIntent({ ...intent, serviceId: undefined, serviceNameRaw: undefined });
    runSearch(nextFilters, 0, false);
  }

  function removeAreaFilter() {
    const nextFilters = { ...filters, lat: undefined, lng: undefined };
    setFilters(nextFilters);
    if (intent) setIntent({ ...intent, area: undefined });
    runSearch(nextFilters, 0, false);
  }

  function removeDateChip() {
    // `date` isn't an applied `/search` filter yet (spec 016 dependency, §7) — display-only,
    // so removing it just clears the chip, no re-search needed.
    if (intent) setIntent({ ...intent, date: undefined });
  }

  function expandArea() {
    const nextFilters = { ...filters, radiusKm: undefined };
    setFilters(nextFilters);
    runSearch(nextFilters, 0, false);
  }

  function adjustBudget() {
    const nextFilters = { ...filters, budgetMaxMinorUnits: undefined };
    setFilters(nextFilters);
    runSearch(nextFilters, 0, false);
  }

  function changeSort(sort: SearchSort) {
    const nextFilters = { ...filters, sort };
    setFilters(nextFilters);
    runSearch(nextFilters, 0, false);
  }

  const chips: { key: string; label: string; onRemove: () => void }[] = [];
  if (filters.serviceId) chips.push({ key: 'serviceId', label: intent?.serviceNameRaw ?? 'Service filter', onRemove: removeServiceFilter });
  if (intent?.area) chips.push({ key: 'area', label: `Near ${intent.area}`, onRemove: removeAreaFilter });
  if (intent?.date) chips.push({ key: 'date', label: `Date: ${intent.date}`, onRemove: removeDateChip });
  if (filters.budgetMaxMinorUnits !== undefined) {
    chips.push({ key: 'budget', label: `Budget <= ${filters.budgetMaxMinorUnits / 100}`, onRemove: adjustBudget });
  }

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Search</h1>

      <SearchBar value={queryText} onChange={setQueryText} onSubmit={handleSearch} loading={status === 'loading'} />

      {suggestions.length > 0 ? (
        <Card elevation="flat" padding={0} style={{ overflow: 'hidden' }}>
          <ul aria-label="Search suggestions" className={styles.suggestions}>
            {suggestions.map((s, i) => (
              <li key={`${s.type}-${s.label}-${i}`}>
                <ListRow
                  icon={s.type === 'recent_search' ? 'clock' : 'search'}
                  title={s.label}
                  chevron={false}
                  onClick={() => {
                    setQueryText(s.type === 'recent_search' ? s.value : s.label);
                    handleSearch(s.type === 'recent_search' ? s.value : s.label);
                  }}
                  style={i === suggestions.length - 1 ? { borderBottom: 'none' } : undefined}
                />
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div className={styles.controlsRow}>
        <label htmlFor="search-sort" className={styles.controlLabel}>
          Sort
        </label>
        <div className={styles.sortSelect}>
          <Select
            id="search-sort"
            size="sm"
            value={filters.sort ?? 'relevance'}
            onChange={(e) => changeSort(e.target.value as SearchSort)}
            options={SORT_OPTIONS}
          />
        </div>
      </div>

      {chips.length > 0 ? (
        <div className={styles.chips}>
          {chips.map((chip) => (
            <IntentChip key={chip.key} label={chip.label} onRemove={chip.onRemove} />
          ))}
        </div>
      ) : null}

      {intent && !interpretFailed ? (
        <p className={styles.aiNote} role="note">
          <Icon name="sparkles" size="sm" color="var(--ai-accent)" style={{ marginTop: 2 }} />
          <span>
            These filters were suggested by AI interpretation of your search — always shown as suggestions, never as facts. Results
            themselves always come from the real Apuriva catalog.
          </span>
        </p>
      ) : null}

      {status === 'loading' ? (
        <div className={styles.grid}>
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <Skeleton lines={3} />
            </Card>
          ))}
        </div>
      ) : status === 'error' ? (
        <ErrorState description={error ?? undefined} onRetry={() => runSearch(filters, 0, false)} />
      ) : results.length === 0 ? (
        <EmptyState
          icon="search"
          title="No results found"
          description="Try expanding your search area, adjusting your budget, or browsing nearby services."
          suggestions={['Expand your search area', 'Adjust your budget', 'Browse nearby services']}
          action={
            <div className={styles.emptyActions}>
              {filters.radiusKm !== undefined ? (
                <Button variant="secondary" onClick={expandArea}>
                  Expand search area
                </Button>
              ) : null}
              {filters.budgetMaxMinorUnits !== undefined ? (
                <Button variant="secondary" onClick={adjustBudget}>
                  Adjust budget
                </Button>
              ) : null}
              <Link href="/explore">
                <Button variant="secondary">Browse nearby</Button>
              </Link>
              {/* Spec 015 (request creation) isn't implemented yet — an honest placeholder rather
               * than a broken/fabricated link, the same pattern app/explore/[category]/page.tsx
               * already uses for its own out-of-scope dependencies. */}
              <Button variant="primary" disabled title="Coming soon">
                Post a request
              </Button>
            </div>
          }
        />
      ) : (
        <>
          <div className={styles.grid}>
            {results.map((result) => (
              <ResultCard key={`${result.providerId}-${result.serviceId}`} result={result} />
            ))}
          </div>

          {isMobile ? (
            <div ref={sentinelRef} className={styles.sentinel} aria-hidden="true" />
          ) : (
            <div className={styles.pagination}>
              <Button
                variant="secondary"
                disabled={pageInfo.offset === 0}
                onClick={() => runSearch(filters, Math.max(0, pageInfo.offset - pageInfo.limit), false)}
              >
                Previous
              </Button>
              <span className={styles.pageCount} data-numeric>
                {pageInfo.offset + 1}-{Math.min(pageInfo.offset + pageInfo.limit, pageInfo.total)} of {pageInfo.total}
              </span>
              <Button variant="secondary" disabled={pageInfo.nextOffset === null} onClick={() => runSearch(filters, pageInfo.nextOffset ?? 0, false)}>
                Next
              </Button>
            </div>
          )}
          {loadingMore ? <Skeleton lines={2} /> : null}
        </>
      )}
    </main>
  );
}
