/**
 * Spec 044 §3.9 (AC-5) — schema.org structured data for the public catalog pages, rendered by the server
 * layouts as `<script type="application/ld+json">`.
 *
 * - `BreadcrumbList` on category and service pages (Explore → category → service).
 * - `Service` on service pages, provided by the platform `Organization`.
 * - No `AggregateRating` or `Offer`: there is no public per-service rating, and prices vary by provider.
 */
export interface BreadcrumbItem {
  name: string;
  /** Absolute URL (built from `SITE_URL`). */
  url: string;
}

export function breadcrumbList(items: readonly BreadcrumbItem[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({ '@type': 'ListItem', position: i + 1, name: item.name, item: item.url })),
  };
}

export function serviceJsonLd(input: { name: string; description: string; categoryName: string; url: string; providerName: string }): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: input.name,
    description: input.description,
    serviceType: input.categoryName,
    url: input.url,
    provider: { '@type': 'Organization', name: input.providerName },
  };
}

/**
 * JSON for an inline `<script>`: `<` is escaped as `<`, so authored catalog text such as
 * `</script>` can never close the tag (the Next.js JSON-LD guide's recommendation).
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
