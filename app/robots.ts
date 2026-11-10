import type { MetadataRoute } from 'next';
import { absoluteUrl } from '@/lib/seo/site-url';

// Built per request from the runtime SITE_URL (each environment has its own), like every route (spec 042 D-3).
export const dynamic = 'force-dynamic';

/**
 * Spec 044 §3.8 — `robots.txt`. Only `/api/` is disallowed: private pages are NOT, because a crawler that
 * cannot fetch a page cannot see its `noindex`; they are auth-gated and carry `noindex` themselves.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: '/api/' },
    sitemap: absoluteUrl('/sitemap.xml'),
  };
}
