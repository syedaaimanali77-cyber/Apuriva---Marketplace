'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ActiveBookingBanner, Button, EmptyState, ErrorState, ResultCard, Skeleton, Switch } from '@/components';
import type { HomeFeedDto, PersonalizationSettingsDto } from '@/lib/types/home';
import styles from './home.module.css';

interface ApiErrorBody {
  code: string;
  message: string;
}

interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: ApiErrorBody;
}

async function getJson<T>(url: string): Promise<ApiResult<T>> {
  const res = await fetch(url, { credentials: 'same-origin' });
  const json = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, data: json.data as T } : { ok: false, error: json as ApiErrorBody };
}

/** Mirrors the CSRF-cookie-echo pattern already used in app/account/_components/AccountMenu.tsx —
 * the CSRF cookie (spec 005 §3) is deliberately not httpOnly. */
function readCsrfCookie(): string {
  return document.cookie.split('; ').find((row) => row.startsWith('apuriva_csrf='))?.split('=')[1] ?? '';
}

type Status = 'loading' | 'error' | 'ready';

const SECTION_TITLES: Record<HomeFeedDto['sections'][number]['type'], string> = {
  curated_popular: 'Popular right now',
  recent_relevant: 'Recommended for you',
  saved_providers: 'Saved providers',
};

/**
 * Spec 014 §5 — the customer-mode home feed. Replaces spec 001's placeholder splash/health-check
 * page. Loading never blocks on the nav shell (mounted separately in app/layout.tsx). Per-section
 * failure isn't distinguished from a top-level failure today — `getHomeFeed` (lib/home/feed.ts)
 * always resolves a single section rather than partially failing, so there's nothing to degrade
 * independently yet; the §5 "per-section" language in the spec anticipates future sections.
 */
export default function HomePage() {
  const [status, setStatus] = useState<Status>('loading');
  const [feed, setFeed] = useState<HomeFeedDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<PersonalizationSettingsDto | null>(null);

  function loadFeed() {
    setStatus('loading');
    getJson<HomeFeedDto>('/api/v1/home').then((result) => {
      if (result.ok) {
        setFeed(result.data ?? null);
        setStatus('ready');
      } else {
        setError(result.error?.message ?? "We couldn't load your home feed.");
        setStatus('error');
      }
    });
  }

  useEffect(() => {
    loadFeed();
    // AC-7's opt-out control — absent (not an error) for a guest (401) or an account with no
    // CustomerProfile (404, §2 scope note): personalization is a customer-mode home concept.
    getJson<PersonalizationSettingsDto>('/api/v1/users/me/personalization-settings').then((result) => {
      if (result.ok) setSettings(result.data ?? null);
    });
  }, []);

  async function togglePersonalization(next: boolean) {
    const previous = settings;
    setSettings((prev) => (prev ? { ...prev, personalizationEnabled: next } : prev));
    const res = await fetch('/api/v1/users/me/personalization-settings', {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': readCsrfCookie() },
      body: JSON.stringify({ personalizationEnabled: next }),
    });
    if (res.ok) {
      loadFeed();
    } else {
      setSettings(previous);
    }
  }

  if (status === 'loading') {
    return (
      <main className={styles.page}>
        <div className={styles.grid}>
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} lines={3} />
          ))}
        </div>
      </main>
    );
  }

  if (status === 'error') {
    return (
      <main className={styles.page}>
        <ErrorState description={error ?? undefined} onRetry={loadFeed} />
      </main>
    );
  }

  const sections = feed?.sections ?? [];
  // `getHomeFeed` (lib/home/feed.ts) always resolves exactly one section object, even when the
  // catalog has nothing to show — an empty `items: []` array, not an empty `sections` array — so
  // "no content" is a per-section check, not `sections.length === 0` (which is otherwise
  // unreachable and would silently defeat AC-1's "never an empty/generic screen").
  const hasAnyItems = sections.some((section) => section.items.length > 0);

  return (
    <main className={styles.page}>
      {feed?.activeBooking ? (
        <ActiveBookingBanner
          status={feed.activeBooking.status}
          service={feed.activeBooking.summary}
          action={
            <Link href={`/bookings/${feed.activeBooking.bookingId}`} style={{ color: 'inherit' }}>
              View
            </Link>
          }
        />
      ) : null}

      {settings ? (
        <div className={styles.personalizationControl}>
          <Switch
            id="personalization-toggle"
            label="Personalize my home feed"
            description="Uses your recent searches to recommend services. Turn off to see popular picks instead."
            checked={settings.personalizationEnabled}
            onChange={togglePersonalization}
          />
        </div>
      ) : null}

      {!hasAnyItems ? (
        <EmptyState
          icon="compass"
          title="Nothing to show yet"
          description="Explore services to get started."
          action={
            <Link href="/explore">
              <Button variant="secondary">Explore services</Button>
            </Link>
          }
        />
      ) : (
        sections.map((section) => (
          <section key={section.type} className={styles.section}>
            <h2 className={styles.sectionTitle}>{SECTION_TITLES[section.type]}</h2>
            {section.type === 'recent_relevant' && section.reason ? <p className={styles.reason}>{section.reason}</p> : null}
            <div className={styles.grid}>
              {section.type === 'saved_providers'
                ? section.items.map((provider) => (
                    <div key={provider.providerId} className={styles.providerTile}>
                      {provider.businessName}
                      {provider.rating !== undefined ? ` · ${provider.rating.toFixed(1)}` : ''}
                    </div>
                  ))
                : section.items.map((item) => <ResultCard key={`${item.providerId}-${item.serviceId}`} result={item} />)}
            </div>
          </section>
        ))
      )}
    </main>
  );
}
