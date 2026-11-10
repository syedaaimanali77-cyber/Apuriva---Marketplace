import type { Metadata } from 'next';
import { branding } from '@/lib/config/branding';

/**
 * Spec 044 §3.8 (AC-6, D-4) — the index policy for every top-level `app/` segment that has a `page.tsx`.
 * `lib/seo/route-policy.test.ts` fails when a segment is missing here, or when a `noindex` segment lacks
 * its `layout.tsx`, so a new route cannot silently become indexable.
 *
 *   index           — `/`, `/explore` and the published category/service pages (in the sitemap).
 *   noindex-follow  — `/search`: its results are crawlable links, the page itself is not indexed.
 *   noindex         — everything private or transactional.
 */
export type IndexClass = 'index' | 'noindex-follow' | 'noindex';

/** Keyed by the top-level directory under `app/` (`''` is the root page, `/`). */
export const ROUTE_POLICY: Readonly<Record<string, IndexClass>> = {
  '': 'index',
  explore: 'index',
  search: 'noindex-follow',
  account: 'noindex',
  admin: 'noindex',
  provider: 'noindex',
  bookings: 'noindex',
  requests: 'noindex',
  support: 'noindex',
  '(auth)': 'noindex',
  offline: 'noindex',
};

/** Segments whose `noindex` comes from the page itself rather than a segment layout (§3.8). */
export const NOINDEX_WITHOUT_LAYOUT: readonly string[] = ['offline'];

/**
 * The metadata of a page that must not be indexed. The root layout carries `/`'s own canonical and Open
 * Graph URL, and metadata is inherited, so a `noindex` page also clears them: it has no canonical at all
 * (§3.9: "noindex and no canonical"; D-5: one canonical per page, and only on indexable pages). Its title
 * stays the plain app name every private screen has always had, not the home page's search title.
 */
export function noindexMetadata(options: { follow?: boolean } = {}): Metadata {
  return {
    title: branding.appName,
    description: branding.tagline,
    robots: { index: false, follow: options.follow ?? false },
    alternates: null,
    openGraph: null,
    twitter: null,
  };
}
