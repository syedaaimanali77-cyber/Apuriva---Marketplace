/**
 * Spec 045 D-5 / AC-2 — the catalog a demo set uses is the one migration 0006 seeded (spec 010). It is only
 * READ here; the seed never inserts or edits a category, a service or a service field.
 */
import { sql } from 'drizzle-orm';
import { queryRows, type Executor } from '@/lib/offers/db';

export interface DemoCatalogService {
  serviceId: string;
  serviceSlug: string;
  categorySlug: string;
  /** The service's required free-text `details` field (spec 011), filled on every seeded request. */
  detailsFieldId: string;
}

/** The services a demo set draws on, keyed by service slug. */
export type DemoCatalog = ReadonlyMap<string, DemoCatalogService>;

/** The 0006 service slugs the scenarios name. Every one must exist, published, with its `details` field. */
export const DEMO_SERVICE_SLUGS = [
  'home-cleaning',
  'general-home-repair',
  'local-moving',
  'personal-grooming',
  'event-photography',
  'car-maintenance',
  'general-consulting',
  'event-planning',
] as const;

export type DemoServiceSlug = (typeof DEMO_SERVICE_SLUGS)[number];

export class DemoCatalogMissingError extends Error {
  constructor(missing: string[]) {
    super(`The demo seed needs the spec 010 catalog seeded by migration 0006; missing: ${missing.join(', ')}.`);
    this.name = 'DemoCatalogMissingError';
  }
}

export async function loadDemoCatalog(db: Executor): Promise<DemoCatalog> {
  const rows = await queryRows<{ service_id: string; service_slug: string; category_slug: string; details_field_id: string | null }>(
    db,
    sql`SELECT s.id AS service_id, s.slug AS service_slug, c.slug AS category_slug,
               (SELECT f.id FROM service_fields f WHERE f.service_id = s.id AND f.key = 'details' LIMIT 1) AS details_field_id
          FROM services s JOIN categories c ON c.id = s.category_id
         WHERE s.status = 'published' AND c.status = 'published'`,
  );
  const catalog = new Map<string, DemoCatalogService>();
  for (const row of rows) {
    if (!row.details_field_id) continue;
    catalog.set(row.service_slug, {
      serviceId: row.service_id,
      serviceSlug: row.service_slug,
      categorySlug: row.category_slug,
      detailsFieldId: row.details_field_id,
    });
  }
  const missing = DEMO_SERVICE_SLUGS.filter((slug) => !catalog.has(slug));
  if (missing.length > 0) throw new DemoCatalogMissingError(missing);
  return catalog;
}

export function service(catalog: DemoCatalog, slug: DemoServiceSlug): DemoCatalogService {
  return catalog.get(slug)!;
}
