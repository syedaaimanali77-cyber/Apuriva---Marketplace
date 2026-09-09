import { and, eq, ne } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { categories, services, subcategories } from '@/lib/db/schema';
import { recordAdminAuditEvent } from '@/lib/admin-rbac/audit';
import { validationError } from '@/lib/api/errors';
import type { CreateSubcategoryRequest, EditSubcategoryRequest, SubcategoryDto } from '@/lib/types/catalog';
import { requireCatalogPermission } from './authorization';
import {
  catalogNotFoundError,
  invalidLifecycleTransitionError,
  invalidTaxonomyPathError,
  slugConflictError,
  subcategoryHasActiveServicesError,
  versionConflictError,
} from './errors';
import { isValidTransition } from './lifecycle';
import { normalizeSlug } from './slug';
import { toSubcategoryDto } from './categories';

async function assertSlugAvailableInCategory(categoryId: string, slug: string, excludeId?: string): Promise<void> {
  const where = excludeId
    ? and(eq(subcategories.categoryId, categoryId), eq(subcategories.slug, slug), ne(subcategories.id, excludeId))
    : and(eq(subcategories.categoryId, categoryId), eq(subcategories.slug, slug));
  const [existing] = await getDb().select({ id: subcategories.id }).from(subcategories).where(where);
  if (existing) throw slugConflictError(slug);
}

async function assertCategoryActive(categoryId: string): Promise<void> {
  const [row] = await getDb().select({ status: categories.status }).from(categories).where(eq(categories.id, categoryId));
  if (!row || row.status !== 'published') throw invalidTaxonomyPathError('The parent category does not exist or is not active.');
}

export async function listSubcategoriesAdmin(actorUserId: string, categoryId: string): Promise<SubcategoryDto[]> {
  await requireCatalogPermission(actorUserId, 'catalog.subcategory', 'view');
  const rows = await getDb().select().from(subcategories).where(eq(subcategories.categoryId, categoryId));
  return rows.map(toSubcategoryDto);
}

export async function getSubcategoryAdmin(actorUserId: string, id: string): Promise<SubcategoryDto> {
  await requireCatalogPermission(actorUserId, 'catalog.subcategory', 'view');
  const [row] = await getDb().select().from(subcategories).where(eq(subcategories.id, id));
  if (!row) throw catalogNotFoundError();
  return toSubcategoryDto(row);
}

export async function createSubcategory(actorUserId: string, categoryId: string, body: CreateSubcategoryRequest): Promise<SubcategoryDto> {
  const actorRoles = await requireCatalogPermission(actorUserId, 'catalog.subcategory', 'create');

  const errors: { field: string; message: string }[] = [];
  if (typeof body.name !== 'string' || body.name.trim().length === 0) errors.push({ field: 'name', message: 'is required' });
  if (typeof body.slug !== 'string' || body.slug.trim().length === 0) errors.push({ field: 'slug', message: 'is required' });
  if (errors.length > 0) throw validationError(errors);

  await assertCategoryActive(categoryId);

  const slug = normalizeSlug(body.slug);
  const status = body.status ?? 'draft';
  await assertSlugAvailableInCategory(categoryId, slug);

  const [row] = await getDb()
    .insert(subcategories)
    .values({ categoryId, name: body.name, slug, status })
    .returning();

  await recordAdminAuditEvent({
    actorUserId,
    actorRoles,
    eventType: 'catalog.subcategory_created',
    resource: 'catalog.subcategory',
    action: 'create',
    targetType: 'subcategory',
    targetId: row!.id,
    approvalChain: [],
  });

  return toSubcategoryDto(row!);
}

export async function editSubcategory(actorUserId: string, id: string, body: EditSubcategoryRequest): Promise<SubcategoryDto> {
  const actorRoles = await requireCatalogPermission(actorUserId, 'catalog.subcategory', 'edit');

  const [current] = await getDb().select().from(subcategories).where(eq(subcategories.id, id));
  if (!current) throw catalogNotFoundError();
  if (body.expectedVersion !== undefined && body.expectedVersion !== current.version) throw versionConflictError();

  const nextStatus = body.status ?? current.status;
  if (nextStatus !== current.status && !isValidTransition(current.status, nextStatus)) {
    throw invalidLifecycleTransitionError(current.status, nextStatus);
  }

  const categoryId = body.categoryId ?? current.categoryId;
  if (body.categoryId !== undefined && body.categoryId !== current.categoryId) await assertCategoryActive(categoryId);

  let slug = current.slug;
  if (body.slug !== undefined) {
    slug = normalizeSlug(body.slug);
    if (slug !== current.slug || categoryId !== current.categoryId) await assertSlugAvailableInCategory(categoryId, slug, id);
  } else if (categoryId !== current.categoryId) {
    await assertSlugAvailableInCategory(categoryId, slug, id);
  }

  const where = body.expectedVersion !== undefined ? and(eq(subcategories.id, id), eq(subcategories.version, current.version)) : eq(subcategories.id, id);

  const [updated] = await getDb()
    .update(subcategories)
    .set({
      categoryId,
      name: body.name ?? current.name,
      slug,
      status: nextStatus,
      version: current.version + 1,
      updatedAt: new Date(),
    })
    .where(where)
    .returning();
  if (!updated) throw versionConflictError();

  await recordAdminAuditEvent({
    actorUserId,
    actorRoles,
    eventType: 'catalog.subcategory_edited',
    resource: 'catalog.subcategory',
    action: 'edit',
    targetType: 'subcategory',
    targetId: id,
    approvalChain: [],
  });

  return toSubcategoryDto(updated!);
}

/** §4 Retirement and reassignment: blocked while any active (non-`retired`) `Service` still
 * references this subcategory. */
export async function retireSubcategory(actorUserId: string, id: string): Promise<SubcategoryDto> {
  const actorRoles = await requireCatalogPermission(actorUserId, 'catalog.subcategory', 'retire');

  const [current] = await getDb().select().from(subcategories).where(eq(subcategories.id, id));
  if (!current) throw catalogNotFoundError();
  if (!isValidTransition(current.status, 'retired')) throw invalidLifecycleTransitionError(current.status, 'retired');

  const activeServices = await getDb()
    .select({ id: services.id })
    .from(services)
    .where(and(eq(services.subcategoryId, id), ne(services.status, 'retired')));
  if (activeServices.length > 0) throw subcategoryHasActiveServicesError();

  const [updated] = await getDb()
    .update(subcategories)
    .set({ status: 'retired', version: current.version + 1, updatedAt: new Date() })
    .where(eq(subcategories.id, id))
    .returning();

  await recordAdminAuditEvent({
    actorUserId,
    actorRoles,
    eventType: 'catalog.subcategory_retired',
    resource: 'catalog.subcategory',
    action: 'retire',
    targetType: 'subcategory',
    targetId: id,
    approvalChain: [],
  });

  return toSubcategoryDto(updated!);
}
