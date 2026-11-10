import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { categories, services } from '@/lib/db/schema';

/**
 * Spec 044 §3.9 — the published catalog the sitemap lists: every published category, and every published
 * service whose category is also published (a service under a draft or retired category has no reachable
 * public page). Read-only over spec 010's `categories`/`services`; writes nothing.
 */
export interface PublicCatalogRoutes {
  categories: Array<{ id: string; updatedAt: Date }>;
  services: Array<{ id: string; categoryId: string; updatedAt: Date }>;
}

export async function listPublicCatalogRoutes(): Promise<PublicCatalogRoutes> {
  const rows = await getDb()
    .select({ id: categories.id, updatedAt: categories.updatedAt })
    .from(categories)
    .where(eq(categories.status, 'published'))
    .orderBy(asc(categories.sortOrder), asc(categories.id));
  const serviceRows = await getDb()
    .select({ id: services.id, categoryId: services.categoryId, updatedAt: services.updatedAt })
    .from(services)
    .innerJoin(categories, eq(services.categoryId, categories.id))
    .where(and(eq(services.status, 'published'), eq(categories.status, 'published')))
    .orderBy(asc(services.categoryId), asc(services.id));
  return { categories: rows, services: serviceRows };
}
