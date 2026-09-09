import { and, eq, ne } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { categories, services, subcategories } from '@/lib/db/schema';
import { recordAdminAuditEvent } from '@/lib/admin-rbac/audit';
import { validationError } from '@/lib/api/errors';
import type { CreateServiceRequest, EditServiceRequest, ServiceDto } from '@/lib/types/catalog';
import { requireCatalogPermission } from './authorization';
import { catalogNotFoundError, invalidLifecycleTransitionError, invalidTaxonomyPathError, slugConflictError, versionConflictError } from './errors';
import { isValidTransition } from './lifecycle';
import { normalizeSlug } from './slug';

type ServiceRow = typeof services.$inferSelect;

function toServiceDto(row: ServiceRow): ServiceDto {
  return {
    id: row.id,
    categoryId: row.categoryId,
    subcategoryId: row.subcategoryId,
    name: row.name,
    slug: row.slug,
    pricingModel: row.pricingModel,
    status: row.status,
    metadata: row.metadata as Record<string, unknown>,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function assertSlugAvailable(slug: string, excludeId?: string): Promise<void> {
  const where = excludeId ? and(eq(services.slug, slug), ne(services.id, excludeId)) : eq(services.slug, slug);
  const [existing] = await getDb().select({ id: services.id }).from(services).where(where);
  if (existing) throw slugConflictError(slug);
}

/** §4 Taxonomy integrity: `categoryId` must reference an active category; if `subcategoryId` is
 * supplied, it must belong to that same category and be active. Runs on every create/edit — not
 * only at retirement time — so the system never silently orphans a `Service`. */
async function assertValidTaxonomyPath(categoryId: string, subcategoryId: string | null | undefined): Promise<void> {
  const [category] = await getDb().select({ status: categories.status }).from(categories).where(eq(categories.id, categoryId));
  if (!category || category.status !== 'published') throw invalidTaxonomyPathError('The referenced category does not exist or is not active.');

  if (subcategoryId) {
    const [sub] = await getDb()
      .select({ categoryId: subcategories.categoryId, status: subcategories.status })
      .from(subcategories)
      .where(eq(subcategories.id, subcategoryId));
    if (!sub || sub.status !== 'published' || sub.categoryId !== categoryId) {
      throw invalidTaxonomyPathError('The referenced subcategory does not exist, is not active, or does not belong to the referenced category.');
    }
  }
}

export async function getServiceAdmin(actorUserId: string, id: string): Promise<ServiceDto> {
  await requireCatalogPermission(actorUserId, 'catalog.service', 'view');
  const [row] = await getDb().select().from(services).where(eq(services.id, id));
  if (!row) throw catalogNotFoundError();
  return toServiceDto(row);
}

/** §3 `GET /api/v1/services/{id}` — resolves only for a `published` service (§4/AC-5). */
export async function getServicePublic(id: string): Promise<ServiceDto> {
  const [row] = await getDb()
    .select()
    .from(services)
    .where(and(eq(services.id, id), eq(services.status, 'published')));
  if (!row) throw catalogNotFoundError();
  return toServiceDto(row);
}

export async function createService(actorUserId: string, body: CreateServiceRequest): Promise<ServiceDto> {
  const actorRoles = await requireCatalogPermission(actorUserId, 'catalog.service', 'create');

  const errors: { field: string; message: string }[] = [];
  if (typeof body.categoryId !== 'string' || body.categoryId.length === 0) errors.push({ field: 'categoryId', message: 'is required' });
  if (typeof body.name !== 'string' || body.name.trim().length === 0) errors.push({ field: 'name', message: 'is required' });
  if (typeof body.slug !== 'string' || body.slug.trim().length === 0) errors.push({ field: 'slug', message: 'is required' });
  if (typeof body.pricingModel !== 'string') errors.push({ field: 'pricingModel', message: 'is required' });
  if (errors.length > 0) throw validationError(errors);

  await assertValidTaxonomyPath(body.categoryId, body.subcategoryId ?? null);

  const slug = normalizeSlug(body.slug);
  const status = body.status ?? 'draft';
  await assertSlugAvailable(slug);

  const [row] = await getDb()
    .insert(services)
    .values({
      categoryId: body.categoryId,
      subcategoryId: body.subcategoryId ?? null,
      name: body.name,
      slug,
      pricingModel: body.pricingModel,
      status,
      metadata: body.metadata ?? {},
    })
    .returning();

  await recordAdminAuditEvent({
    actorUserId,
    actorRoles,
    eventType: 'catalog.service_created',
    resource: 'catalog.service',
    action: 'create',
    targetType: 'service',
    targetId: row!.id,
    approvalChain: [],
  });

  return toServiceDto(row!);
}

export async function editService(actorUserId: string, id: string, body: EditServiceRequest): Promise<ServiceDto> {
  const actorRoles = await requireCatalogPermission(actorUserId, 'catalog.service', 'edit');

  const [current] = await getDb().select().from(services).where(eq(services.id, id));
  if (!current) throw catalogNotFoundError();
  if (body.expectedVersion !== undefined && body.expectedVersion !== current.version) throw versionConflictError();

  const nextStatus = body.status ?? current.status;
  if (nextStatus !== current.status && !isValidTransition(current.status, nextStatus)) {
    throw invalidLifecycleTransitionError(current.status, nextStatus);
  }

  const categoryId = body.categoryId ?? current.categoryId;
  const subcategoryId = body.subcategoryId !== undefined ? body.subcategoryId : current.subcategoryId;
  if (body.categoryId !== undefined || body.subcategoryId !== undefined) {
    await assertValidTaxonomyPath(categoryId, subcategoryId);
  }

  let slug = current.slug;
  if (body.slug !== undefined) {
    slug = normalizeSlug(body.slug);
    if (slug !== current.slug) await assertSlugAvailable(slug, id);
  }

  const where = body.expectedVersion !== undefined ? and(eq(services.id, id), eq(services.version, current.version)) : eq(services.id, id);

  const [updated] = await getDb()
    .update(services)
    .set({
      categoryId,
      subcategoryId,
      name: body.name ?? current.name,
      slug,
      pricingModel: body.pricingModel ?? current.pricingModel,
      status: nextStatus,
      metadata: body.metadata ?? current.metadata,
      version: current.version + 1,
      updatedAt: new Date(),
    })
    .where(where)
    .returning();
  if (!updated) throw versionConflictError();

  await recordAdminAuditEvent({
    actorUserId,
    actorRoles,
    eventType: 'catalog.service_edited',
    resource: 'catalog.service',
    action: 'edit',
    targetType: 'service',
    targetId: id,
    approvalChain: [],
  });

  return toServiceDto(updated!);
}

/** §4 Lifecycle / §7 Out of scope: a soft lifecycle transition, never physical deletion — a
 * `Service` has no children in this taxonomy, so retirement carries no cascade/reassignment rule
 * of its own beyond the normal transition check. */
export async function retireService(actorUserId: string, id: string): Promise<ServiceDto> {
  const actorRoles = await requireCatalogPermission(actorUserId, 'catalog.service', 'retire');

  const [current] = await getDb().select().from(services).where(eq(services.id, id));
  if (!current) throw catalogNotFoundError();
  if (!isValidTransition(current.status, 'retired')) throw invalidLifecycleTransitionError(current.status, 'retired');

  const [updated] = await getDb()
    .update(services)
    .set({ status: 'retired', version: current.version + 1, updatedAt: new Date() })
    .where(eq(services.id, id))
    .returning();

  await recordAdminAuditEvent({
    actorUserId,
    actorRoles,
    eventType: 'catalog.service_retired',
    resource: 'catalog.service',
    action: 'retire',
    targetType: 'service',
    targetId: id,
    approvalChain: [],
  });

  return toServiceDto(updated!);
}

export { toServiceDto, assertValidTaxonomyPath };
