'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ActiveBookingBanner, Button, EmptyState, ErrorState, ResultCard, SearchBar, Skeleton, Switch } from '@/components';
import { AskApuriva } from '@/app/_components/AskApurivaPanel';
import { useLocale } from '@/app/_components/LocaleProvider';
import { branding } from '@/lib/config/branding';
import type { MessageKey } from '@/lib/i18n/dictionaries/en';
import { formatNumber } from '@/lib/i18n/format';
import type { CategoryDto } from '@/lib/types/catalog';
import type { HomeFeedDto, PersonalizationSettingsDto } from '@/lib/types/home';
import { imageForCategoryName } from './category-images';
import { apiFetch, mutateHeaders } from './requests/api-client';
import styles from './home.module.css';

// The repository's shared client fetch helper: a request that never completed (dev-server
// recompile, dropped connection) resolves as `NETWORK_ERROR` instead of an unhandled
// `Failed to fetch`, so the feed's own ErrorState + Try again handles it.
const getJson = apiFetch;

type Status = 'loading' | 'error' | 'ready';

const SECTION_TITLES: Record<HomeFeedDto['sections'][number]['type'], MessageKey> = {
  curated_popular: 'home.sections.curated_popular',
  recent_relevant: 'home.sections.recent_relevant',
  saved_providers: 'home.sections.saved_providers',
};

/**
 * Spec 014 §5 — the customer-mode home feed. Replaces spec 001's placeholder splash/health-check
 * page. Loading never blocks on the nav shell (mounted separately in app/layout.tsx). Per-section
 * failure isn't distinguished from a top-level failure today — `getHomeFeed` (lib/home/feed.ts)
 * always resolves a single section rather than partially failing, so there's nothing to degrade
 * independently yet; the §5 "per-section" language in the spec anticipates future sections.
 *
 * Visual layer only (hero, category browse, section styling, photography) sits on top of that
 * unchanged data/logic: the hero search bar and category tiles link into the real, already-shipped
 * `/search` and `/explore/[category]` pages rather than introducing any new business logic, and
 * `GET /api/v1/categories` (spec 010, already public) is the only additional read this page makes.
 */
export default function HomePage() {
  const { locale, t, errorText } = useLocale();
  const router = useRouter();
  const [status, setStatus] = useState<Status>('loading');
  const [feed, setFeed] = useState<HomeFeedDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<PersonalizationSettingsDto | null>(null);
  const [categories, setCategories] = useState<CategoryDto[]>([]);
  const [heroQuery, setHeroQuery] = useState('');

  function loadFeed() {
    setStatus('loading');
    getJson<HomeFeedDto>('/api/v1/home').then((result) => {
      if (result.ok) {
        setFeed(result.data ?? null);
        setStatus('ready');
      } else {
        setError(errorText(result.error?.code, result.error?.message, t('home.loadFailed')));
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
    // Real, published catalog (spec 010) — the same data app/explore already lists — for the
    // "Browse by category" section below. Failure here degrades to simply omitting that section,
    // never a page-level error, since it's supplementary to the feed itself.
    getJson<CategoryDto[]>('/api/v1/categories').then((result) => {
      if (result.ok) setCategories(result.data ?? []);
    });
  }, []);

  async function togglePersonalization(next: boolean) {
    const previous = settings;
    setSettings((prev) => (prev ? { ...prev, personalizationEnabled: next } : prev));
    const res = await apiFetch('/api/v1/users/me/personalization-settings', {
      method: 'PATCH',
      headers: mutateHeaders(),
      body: JSON.stringify({ personalizationEnabled: next }),
    });
    if (res.ok) {
      loadFeed();
    } else {
      setSettings(previous);
    }
  }

  const sections = feed?.sections ?? [];
  // `getHomeFeed` (lib/home/feed.ts) always resolves exactly one section object, even when the
  // catalog has nothing to show — an empty `items: []` array, not an empty `sections` array — so
  // "no content" is a per-section check, not `sections.length === 0` (which is otherwise
  // unreachable and would silently defeat AC-1's "never an empty/generic screen").
  const hasAnyItems = sections.some((section) => section.items.length > 0);

  return (
    <main className={styles.page}>
      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <span className={styles.heroEyebrow}>{t('home.eyebrow')}</span>
          <h1 className={styles.heroTitle}>{t('home.title')}</h1>
          <p className={styles.heroSubtitle}>{t('home.subtitle', { tagline: branding.tagline })}</p>
          <div className={styles.heroSearch}>
            <SearchBar
              value={heroQuery}
              onChange={setHeroQuery}
              onSubmit={(q) => router.push(q.trim() ? `/search?q=${encodeURIComponent(q.trim())}` : '/search')}
              placeholder={t('home.searchPlaceholder')}
            />
          </div>
        </div>
        <div className={styles.heroImageWrap}>
          <Image
            src="/images/marketing/hero-electrician.jpg"
            alt={t('home.heroAlt')}
            fill
            sizes="(max-width: 768px) 100vw, 480px"
            style={{ objectFit: 'cover' }}
            priority
          />
        </div>
      </section>

      {feed?.activeBooking ? (
        <ActiveBookingBanner
          status={feed.activeBooking.status}
          service={feed.activeBooking.summary}
          action={
            <Link href={`/bookings/${feed.activeBooking.bookingId}`} style={{ color: 'inherit' }}>
              {t('home.view')}
            </Link>
          }
        />
      ) : null}

      {categories.length > 0 ? (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>{t('home.browse')}</h2>
            <Link href="/explore" className={styles.sectionLink}>
              {t('home.viewAll')}
            </Link>
          </div>
          <div className={styles.categoryGrid}>
            {categories.map((category) => (
              <Link key={category.id} href={`/explore/${category.id}`} className={styles.categoryTile}>
                <div className={styles.categoryImageWrap}>
                  <Image
                    src={imageForCategoryName(category.name)}
                    alt={t('home.categoryAlt', { name: category.name })}
                    fill
                    sizes="180px"
                    style={{ objectFit: 'cover' }}
                  />
                </div>
                <span className={styles.categoryName}>{category.name}</span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {settings ? (
        <div className={styles.personalizationControl}>
          <Switch
            id="personalization-toggle"
            label={t('home.personalize')}
            description={t('home.personalizeHelp')}
            checked={settings.personalizationEnabled}
            onChange={togglePersonalization}
          />
        </div>
      ) : null}

      {status === 'loading' ? (
        <div className={styles.grid}>
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} lines={3} />
          ))}
        </div>
      ) : status === 'error' ? (
        <ErrorState description={error ?? undefined} onRetry={loadFeed} />
      ) : !hasAnyItems ? (
        <EmptyState
          icon="compass"
          title={t('home.emptyTitle')}
          description={t('home.emptyDescription')}
          action={
            <Link href="/explore">
              <Button variant="secondary">{t('home.explore')}</Button>
            </Link>
          }
        />
      ) : (
        sections.map((section) => (
          <section key={section.type} className={styles.section}>
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>{t(SECTION_TITLES[section.type])}</h2>
            </div>
            {section.type === 'recent_relevant' && section.reason ? <p className={styles.reason}>{section.reason}</p> : null}
            <div className={styles.grid}>
              {section.type === 'saved_providers'
                ? section.items.map((provider) => (
                    <div key={provider.providerId} className={styles.providerTile}>
                      {provider.businessName}
                      {provider.rating !== undefined
                        ? ` · ${formatNumber(provider.rating, locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`
                        : ''}
                    </div>
                  ))
                : section.items.map((item) => <ResultCard key={`${item.providerId}-${item.serviceId}`} result={item} />)}
            </div>
          </section>
        ))
      )}

      <AskApuriva />
    </main>
  );
}
