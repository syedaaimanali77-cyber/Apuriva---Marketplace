import type { Metadata } from 'next';
import { cache } from 'react';
import { imageForCategoryName } from '@/app/category-images';
import { ApiRouteError } from '@/lib/api/errors';
import { getCategoryPublic } from '@/lib/catalog/categories';
import { getServicePublic } from '@/lib/catalog/services';
import { branding } from '@/lib/config/branding';
import type { Locale } from '@/lib/i18n/config';
import { translate } from '@/lib/i18n/translate';
import { breadcrumbList, serviceJsonLd } from './json-ld';
import { noindexMetadata } from './route-policy';
import { absoluteUrl, siteUrl } from './site-url';

/**
 * Spec 044 §3.9 (AC-5) — the metadata and JSON-LD of the indexable explore pages (`/` gets its own from the
 * root layout). The public pages are client components, so their server layouts call these.
 *
 * - Canonical, `og:url` and JSON-LD URLs are `SITE_URL` + path, never the request host, with no query.
 * - Catalog titles are the entity's authored name plus `branding.appName`. The catalog has no authored
 *   description, so the description is the `seo.*` name-based template (spec 042 D-1: catalog names are
 *   not translated; the template follows the request locale, English for crawlers).
 * - An unknown, malformed or unpublished entity (or a service whose category is not published) is
 *   `noindex` with no canonical; the client page renders its own not-found state.
 */
export interface PageSeo {
  metadata: Metadata;
  /** JSON-LD objects to render; empty for a `noindex` page. */
  jsonLd: Record<string, unknown>[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function titled(name: string): string {
  return `${name} | ${branding.appName}`;
}

function indexable(input: { title: string; description: string; path: string; image?: string }): Metadata {
  const base = siteUrl();
  const url = absoluteUrl(input.path, base);
  const images = input.image ? [{ url: absoluteUrl(input.image, base) }] : undefined;
  return {
    title: input.title,
    description: input.description,
    alternates: { canonical: url },
    openGraph: { title: input.title, description: input.description, url, type: 'website', siteName: branding.appName, ...(images ? { images } : {}) },
    twitter: { card: 'summary_large_image', title: input.title, description: input.description, ...(images ? { images: images.map((i) => i.url) } : {}) },
  };
}

function notIndexable(): PageSeo {
  return { metadata: noindexMetadata(), jsonLd: [] };
}

/** A published catalog read, or `null` for a malformed id or a NOT_FOUND (unknown or unpublished). */
async function orNull<T>(id: string, read: (id: string) => Promise<T>): Promise<T | null> {
  if (!UUID_RE.test(id)) return null;
  try {
    return await read(id);
  } catch (err) {
    if (err instanceof ApiRouteError && err.code === 'NOT_FOUND') return null;
    throw err;
  }
}

// One read per request even though a segment's generateMetadata and its layout both ask (§3.9).
const publishedCategory = cache((id: string) => orNull(id, getCategoryPublic));
const publishedService = cache((id: string) => orNull(id, getServicePublic));

export function exploreSeo(locale: Locale | string): PageSeo {
  return {
    metadata: indexable({ title: titled(translate(locale, 'seo.exploreTitle')), description: translate(locale, 'seo.exploreDescription'), path: '/explore' }),
    jsonLd: [],
  };
}

export async function categorySeo(locale: Locale | string, categoryId: string): Promise<PageSeo> {
  const category = await publishedCategory(categoryId);
  if (!category) return notIndexable();
  const path = `/explore/${category.id}`;
  return {
    metadata: indexable({
      title: titled(category.name),
      description: translate(locale, 'seo.categoryDescription', { name: category.name }),
      path,
      image: imageForCategoryName(category.name),
    }),
    jsonLd: [
      breadcrumbList([
        { name: translate(locale, 'seo.exploreTitle'), url: absoluteUrl('/explore') },
        { name: category.name, url: absoluteUrl(path) },
      ]),
    ],
  };
}

export async function serviceSeo(locale: Locale | string, serviceId: string): Promise<PageSeo> {
  const service = await publishedService(serviceId);
  if (!service) return notIndexable();
  const category = await publishedCategory(service.categoryId);
  if (!category) return notIndexable();
  // The service's own category, not the URL segment: one canonical however the service was reached.
  const categoryPath = `/explore/${category.id}`;
  const path = `${categoryPath}/${service.id}`;
  const description = translate(locale, 'seo.serviceDescription', { name: service.name });
  return {
    metadata: indexable({ title: titled(service.name), description, path, image: imageForCategoryName(category.name) }),
    jsonLd: [
      breadcrumbList([
        { name: translate(locale, 'seo.exploreTitle'), url: absoluteUrl('/explore') },
        { name: category.name, url: absoluteUrl(categoryPath) },
        { name: service.name, url: absoluteUrl(path) },
      ]),
      serviceJsonLd({ name: service.name, description, categoryName: category.name, url: absoluteUrl(path), providerName: branding.appName }),
    ],
  };
}
