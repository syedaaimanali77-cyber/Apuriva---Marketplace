import type { MetadataRoute } from 'next';
import { listPublicCatalogRoutes } from '@/lib/seo/public-routes';
import { absoluteUrl, siteUrl } from '@/lib/seo/site-url';

// Read from the database per request (never at build time), like every route (spec 042 D-3).
export const dynamic = 'force-dynamic';

/**
 * Spec 044 §3.9 (AC-6) — exactly the indexable set of §3.8: `/`, `/explore`, every published category and
 * every published service whose category is published. Nothing private, `/search` included.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();
  const { categories, services } = await listPublicCatalogRoutes();
  return [
    { url: absoluteUrl('/', base) },
    { url: absoluteUrl('/explore', base) },
    ...categories.map((c) => ({ url: absoluteUrl(`/explore/${c.id}`, base), lastModified: c.updatedAt })),
    ...services.map((s) => ({ url: absoluteUrl(`/explore/${s.categoryId}/${s.id}`, base), lastModified: s.updatedAt })),
  ];
}
