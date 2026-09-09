import { and, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { categories, catalogSuggestions, services, subcategories } from '@/lib/db/schema';
import { recordAdminAuditEvent } from '@/lib/admin-rbac/audit';
import { validationError } from '@/lib/api/errors';
import type { PageParams } from '@/lib/api/pagination';
import type { CatalogSuggestionDto, CreateCatalogSuggestionRequest } from '@/lib/types/catalog';
import { requireCatalogPermission } from './authorization';
import { catalogNotFoundError, invalidTaxonomyPathError, slugConflictError, suggestionAlreadyReviewedError } from './errors';
import { normalizeSlug } from './slug';
import { assertValidTaxonomyPath } from './services';

type CatalogSuggestionRow = typeof catalogSuggestions.$inferSelect;

function toSuggestionDto(row: CatalogSuggestionRow): CatalogSuggestionDto {
  return {
    id: row.id,
    entityType: row.entityType,
    proposedName: row.proposedName,
    proposedSlug: row.proposedSlug,
    categoryId: row.categoryId,
    subcategoryId: row.subcategoryId,
    pricingModel: row.pricingModel,
    metadata: row.metadata as Record<string, unknown>,
    rationale: row.rationale,
    source: row.source,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewedBy: row.reviewedBy,
    resultingEntityId: row.resultingEntityId,
  };
}

/** §3 `POST /api/v1/admin/catalog/suggestions` — spec 034's AI assistant, via spec 035's MCP tool
 * pipeline (its own authorization check, not a Content/Marketplace permission grant — AC-3: this
 * never creates, updates, or publishes a Category, Subcategory, or Service). Any authenticated
 * caller may reach this route; only the resolution below is domain-validated. */
export async function createSuggestion(body: CreateCatalogSuggestionRequest): Promise<CatalogSuggestionDto> {
  const errors: { field: string; message: string }[] = [];
  if (!['category', 'subcategory', 'service'].includes(body.entityType as string)) {
    errors.push({ field: 'entityType', message: 'must be one of category, subcategory, service' });
  }
  if (typeof body.proposedName !== 'string' || body.proposedName.trim().length === 0) {
    errors.push({ field: 'proposedName', message: 'is required' });
  }
  if (typeof body.proposedSlug !== 'string' || body.proposedSlug.trim().length === 0) {
    errors.push({ field: 'proposedSlug', message: 'is required' });
  }
  if (typeof body.source !== 'string' || body.source.trim().length === 0) {
    errors.push({ field: 'source', message: 'is required' });
  }
  if (errors.length > 0) throw validationError(errors);

  const [row] = await getDb()
    .insert(catalogSuggestions)
    .values({
      entityType: body.entityType,
      proposedName: body.proposedName,
      proposedSlug: normalizeSlug(body.proposedSlug),
      categoryId: body.categoryId ?? null,
      subcategoryId: body.subcategoryId ?? null,
      pricingModel: body.pricingModel ?? null,
      metadata: body.metadata ?? {},
      rationale: body.rationale ?? null,
      source: body.source,
      status: 'pending_review',
    })
    .returning();

  return toSuggestionDto(row!);
}

export async function listPendingSuggestions(actorUserId: string, page: PageParams): Promise<{ items: CatalogSuggestionDto[]; total: number }> {
  await requireCatalogPermission(actorUserId, 'catalog.suggestion', 'view');

  const rows = await getDb()
    .select()
    .from(catalogSuggestions)
    .where(eq(catalogSuggestions.status, 'pending_review'))
    .orderBy(catalogSuggestions.createdAt)
    .limit(page.limit)
    .offset(page.offset);
  const all = await getDb().select({ id: catalogSuggestions.id }).from(catalogSuggestions).where(eq(catalogSuggestions.status, 'pending_review'));

  return { items: rows.map(toSuggestionDto), total: all.length };
}

async function getSuggestionOrThrow(id: string): Promise<CatalogSuggestionRow> {
  const [row] = await getDb().select().from(catalogSuggestions).where(eq(catalogSuggestions.id, id));
  if (!row) throw catalogNotFoundError('The requested suggestion does not exist.');
  return row;
}

/**
 * §3 AI suggestion review, `POST .../approve` — re-checks `pending_review`, validates the
 * proposed data/taxonomy exactly as a normal create would, creates the resulting entity with
 * status `pending_review` (never `published` — approval alone never publishes anything, per the
 * Lifecycle section: the entity becomes customer-visible only once an admin separately transitions
 * it `pending_review → published` through the normal PATCH endpoint), then records
 * `reviewedAt`/`reviewedBy`/`resultingEntityId` and sets the suggestion to `approved`.
 *
 * The data model has no field identifying an existing entity for an "edit" suggestion to target —
 * `CatalogSuggestion` carries only the proposed data, never a target entity id — so approval
 * always creates a new entity, never updates one.
 */
export async function approveSuggestion(actorUserId: string, id: string): Promise<CatalogSuggestionDto> {
  const actorRoles = await requireCatalogPermission(actorUserId, 'catalog.suggestion', 'approve');

  const suggestion = await getSuggestionOrThrow(id);
  if (suggestion.status !== 'pending_review') throw suggestionAlreadyReviewedError();

  const slug = suggestion.proposedSlug;

  let resultingEntityId: string;
  if (suggestion.entityType === 'category') {
    const [existing] = await getDb().select({ id: categories.id }).from(categories).where(eq(categories.slug, slug));
    if (existing) throw slugConflictError(slug);
    const [row] = await getDb()
      .insert(categories)
      .values({ name: suggestion.proposedName, slug, status: 'pending_review', sortOrder: 0 })
      .returning({ id: categories.id });
    resultingEntityId = row!.id;
  } else if (suggestion.entityType === 'subcategory') {
    if (!suggestion.categoryId) throw invalidTaxonomyPathError('The suggestion has no categoryId.');
    const [category] = await getDb().select({ status: categories.status }).from(categories).where(eq(categories.id, suggestion.categoryId));
    if (!category || category.status !== 'published') throw invalidTaxonomyPathError('The referenced category does not exist or is not active.');
    const [existing] = await getDb()
      .select({ id: subcategories.id })
      .from(subcategories)
      .where(and(eq(subcategories.categoryId, suggestion.categoryId), eq(subcategories.slug, slug)));
    if (existing) throw slugConflictError(slug);
    const [row] = await getDb()
      .insert(subcategories)
      .values({ categoryId: suggestion.categoryId, name: suggestion.proposedName, slug, status: 'pending_review' })
      .returning({ id: subcategories.id });
    resultingEntityId = row!.id;
  } else {
    if (!suggestion.categoryId) throw invalidTaxonomyPathError('The suggestion has no categoryId.');
    if (!suggestion.pricingModel) throw validationError([{ field: 'pricingModel', message: 'is required for a service suggestion' }]);
    await assertValidTaxonomyPath(suggestion.categoryId, suggestion.subcategoryId);
    const [existing] = await getDb().select({ id: services.id }).from(services).where(eq(services.slug, slug));
    if (existing) throw slugConflictError(slug);
    const [row] = await getDb()
      .insert(services)
      .values({
        categoryId: suggestion.categoryId,
        subcategoryId: suggestion.subcategoryId,
        name: suggestion.proposedName,
        slug,
        pricingModel: suggestion.pricingModel,
        status: 'pending_review',
        metadata: suggestion.metadata,
      })
      .returning({ id: services.id });
    resultingEntityId = row!.id;
  }

  const reviewedAt = new Date();
  const [updated] = await getDb()
    .update(catalogSuggestions)
    .set({ status: 'approved', reviewedAt, reviewedBy: actorUserId, resultingEntityId, updatedAt: reviewedAt })
    .where(and(eq(catalogSuggestions.id, id), eq(catalogSuggestions.status, 'pending_review')))
    .returning();
  if (!updated) throw suggestionAlreadyReviewedError();

  await recordAdminAuditEvent({
    actorUserId,
    actorRoles,
    eventType: 'catalog.suggestion_approved',
    resource: 'catalog.suggestion',
    action: 'approve',
    targetType: 'catalog_suggestion',
    targetId: id,
    approvalChain: { reviewedBy: actorUserId, reviewedAt: reviewedAt.toISOString(), resultingEntityId },
  });

  return toSuggestionDto(updated!);
}

/** §3 AI suggestion review, `POST .../reject` — records reviewer/time, publishes nothing; the
 * suggestion stays unpublished permanently (`rejected` is terminal). */
export async function rejectSuggestion(actorUserId: string, id: string): Promise<CatalogSuggestionDto> {
  const actorRoles = await requireCatalogPermission(actorUserId, 'catalog.suggestion', 'reject');

  const suggestion = await getSuggestionOrThrow(id);
  if (suggestion.status !== 'pending_review') throw suggestionAlreadyReviewedError();

  const reviewedAt = new Date();
  const [updated] = await getDb()
    .update(catalogSuggestions)
    .set({ status: 'rejected', reviewedAt, reviewedBy: actorUserId, updatedAt: reviewedAt })
    .where(and(eq(catalogSuggestions.id, id), eq(catalogSuggestions.status, 'pending_review')))
    .returning();
  if (!updated) throw suggestionAlreadyReviewedError();

  await recordAdminAuditEvent({
    actorUserId,
    actorRoles,
    eventType: 'catalog.suggestion_rejected',
    resource: 'catalog.suggestion',
    action: 'reject',
    targetType: 'catalog_suggestion',
    targetId: id,
    approvalChain: { reviewedBy: actorUserId, reviewedAt: reviewedAt.toISOString() },
  });

  return toSuggestionDto(updated!);
}
