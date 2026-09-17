import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { serviceRequirements, servicePackages, services } from '@/lib/db/schema';
import { getCategoryPublic } from '@/lib/catalog/categories';
import { getServicePublic } from '@/lib/catalog/services';
import type { CategoryPageDto, ServicePackageDto, ServicePageDto, ServiceRequirementDto } from '@/lib/types/service-page';
import { computePriceDisplay } from './pricing';
import { listServiceFields } from './fields';
import { listPublicFaqs } from './faqs';

const POPULAR_SERVICES_LIMIT = 12;

function toPackageDto(row: typeof servicePackages.$inferSelect): ServicePackageDto {
  return {
    id: row.id,
    serviceId: row.serviceId,
    providerId: row.providerProfileId,
    name: row.name,
    description: row.description,
    amountMinorUnits: row.amountMinorUnits,
    currencyCode: row.currencyCode,
    includedItems: (row.includedItems as string[] | null) ?? [],
  };
}

function toRequirementDto(row: typeof serviceRequirements.$inferSelect): ServiceRequirementDto {
  return {
    id: row.id,
    serviceId: row.serviceId,
    kind: row.kind,
    detail: (row.detail as Record<string, unknown>) ?? {},
  };
}

/** Spec 011 §3, `GET /api/v1/services/{id}/page` — includes fields, FAQs, packages, pricing.
 * Resolves only for a `published` service (reuses spec 010's `getServicePublic`, §4/AC-5's own
 * public-read rule — this spec doesn't redefine it). */
export async function getServicePage(serviceId: string): Promise<ServicePageDto> {
  const service = await getServicePublic(serviceId);

  const [packageRows, fields, requirementRows, faqs] = await Promise.all([
    getDb().select().from(servicePackages).where(eq(servicePackages.serviceId, serviceId)),
    listServiceFields(serviceId),
    getDb().select().from(serviceRequirements).where(eq(serviceRequirements.serviceId, serviceId)),
    listPublicFaqs(serviceId),
  ]);

  const packages = packageRows.map(toPackageDto);

  return {
    id: service.id,
    name: service.name,
    pricingModel: service.pricingModel,
    priceDisplay: computePriceDisplay(service.pricingModel, packages),
    packages,
    fields,
    requirements: requirementRows.map(toRequirementDto),
    faqs,
  };
}

/** Spec 011 §3/AC-1, `GET /api/v1/categories/{id}/page` — aggregated page data. `filters` and
 * `popularServices` are real (spec 010); real search/filter (spec 013) and ranking (spec 017)
 * logic remain out of scope (§7) — the page's other AC-1 sections (AI-assist entry point,
 * recommended providers, nearby availability) render as structural placeholders client-side
 * rather than fabricated data here. */
export async function getCategoryPage(categoryId: string): Promise<CategoryPageDto> {
  const category = await getCategoryPublic(categoryId);

  const popularServiceRows = await getDb()
    .select()
    .from(services)
    .where(and(eq(services.categoryId, categoryId), eq(services.status, 'published')))
    .orderBy(asc(services.createdAt))
    .limit(POPULAR_SERVICES_LIMIT);

  return {
    id: category.id,
    name: category.name,
    slug: category.slug,
    filters: category.subcategories,
    popularServices: popularServiceRows.map((row) => ({
      id: row.id,
      categoryId: row.categoryId,
      subcategoryId: row.subcategoryId,
      name: row.name,
      slug: row.slug,
      pricingModel: row.pricingModel,
      status: row.status,
      metadata: row.metadata as Record<string, unknown>,
      // Spec 028 §4 — part of the service's catalog definition; carried through unchanged.
      completionEvidenceRequired: row.completionEvidenceRequired,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  };
}

export { toPackageDto, toRequirementDto };
