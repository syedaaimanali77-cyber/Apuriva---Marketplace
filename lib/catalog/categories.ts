import { and, eq, inArray, ne } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { categories, services, subcategories } from '@/lib/db/schema';
import { recordAdminAuditEvent } from '@/lib/admin-rbac/audit';
import { validationError } from '@/lib/api/errors';
import type { CategoryDto, CreateCategoryRequest, EditCategoryRequest, SubcategoryDto } from '@/lib/types/catalog';
import { requireCatalogPermission } from './authorization';
import {
  catalogNotFoundError,
  categoryHasActiveServicesError,
  invalidLifecycleTransitionError,
  slugConflictError,
  versionConflictError,
} from './errors';
import { isValidTransition } from './lifecycle';
import { normalizeSlug } from './slug';

type CategoryRow = typeof categories.$inferSelect;
type SubcategoryRow = typeof subcategories.$inferSelect;

function toSubcategoryDto(row: SubcategoryRow): SubcategoryDto {
  return {
    id: row.id,
    categoryId: row.categoryId,
    name: row.name,
    slug: row.slug,
    status: row.status,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toCategoryDto(row: CategoryRow, subcategoryRows: SubcategoryRow[]): CategoryDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    sortOrder: row.sortOrder,
    subcategories: subcategoryRows.map(toSubcategoryDto),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function assertSlugAvailable(slug: string, excludeId?: string): Promise<void> {
  const where = excludeId ? and(eq(categories.slug, slug), ne(categories.id, excludeId)) : eq(categories.slug, slug);
  const [existing] = await getDb().select({ id: categories.id }).from(categories).where(where);
  if (existing) throw slugConflictError(slug);
}

export async function listCategoriesAdmin(actorUserId: string): Promise<CategoryDto[]> {
  await requireCatalogPermission(actorUserId, 'catalog.category', 'view');
  const rows = await getDb().select().from(categories).orderBy(categories.sortOrder);
  const subRows = await getDb().select().from(subcategories);
  return rows.map((r) => toCategoryDto(r, subRows.filter((s) => s.categoryId === r.id)));
}

export async function getCategoryAdmin(actorUserId: string, id: string): Promise<CategoryDto> {
  await requireCatalogPermission(actorUserId, 'catalog.category', 'view');
  const [row] = await getDb().select().from(categories).where(eq(categories.id, id));
  if (!row) throw catalogNotFoundError();
  const subRows = await getDb().select().from(subcategories).where(eq(subcategories.categoryId, id));
  return toCategoryDto(row, subRows);
}

/** §3 `GET /api/v1/categories` — published only. */
export async function listCategoriesPublic(): Promise<CategoryDto[]> {
  const rows = await getDb().select().from(categories).where(eq(categories.status, 'published')).orderBy(categories.sortOrder);
  const subRows = await getDb().select().from(subcategories).where(eq(subcategories.status, 'published'));
  return rows.map((r) => toCategoryDto(r, subRows.filter((s) => s.categoryId === r.id)));
}

/** §3 `GET /api/v1/categories/{id}` — published only, with only published child subcategories. */
export async function getCategoryPublic(id: string): Promise<CategoryDto> {
  const [row] = await getDb()
    .select()
    .from(categories)
    .where(and(eq(categories.id, id), eq(categories.status, 'published')));
  if (!row) throw catalogNotFoundError();
  const subRows = await getDb()
    .select()
    .from(subcategories)
    .where(and(eq(subcategories.categoryId, id), eq(subcategories.status, 'published')));
  return toCategoryDto(row, subRows);
}

export async function createCategory(actorUserId: string, body: CreateCategoryRequest): Promise<CategoryDto> {
  const actorRoles = await requireCatalogPermission(actorUserId, 'catalog.category', 'create');

  const errors: { field: string; message: string }[] = [];
  if (typeof body.name !== 'string' || body.name.trim().length === 0) errors.push({ field: 'name', message: 'is required' });
  if (typeof body.slug !== 'string' || body.slug.trim().length === 0) errors.push({ field: 'slug', message: 'is required' });
  if (errors.length > 0) throw validationError(errors);

  const slug = normalizeSlug(body.slug);
  const status = body.status ?? 'draft';
  await assertSlugAvailable(slug);

  const [row] = await getDb()
    .insert(categories)
    .values({ name: body.name, slug, status, sortOrder: body.sortOrder ?? 0 })
    .returning();

  await recordAdminAuditEvent({
    actorUserId,
    actorRoles,
    eventType: 'catalog.category_created',
    resource: 'catalog.category',
    action: 'create',
    targetType: 'category',
    targetId: row!.id,
    approvalChain: [],
  });

  return toCategoryDto(row!, []);
}

export async function editCategory(actorUserId: string, id: string, body: EditCategoryRequest): Promise<CategoryDto> {
  const actorRoles = await requireCatalogPermission(actorUserId, 'catalog.category', 'edit');

  const [current] = await getDb().select().from(categories).where(eq(categories.id, id));
  if (!current) throw catalogNotFoundError();
  if (body.expectedVersion !== undefined && body.expectedVersion !== current.version) throw versionConflictError();

  const nextStatus = body.status ?? current.status;
  if (nextStatus !== current.status && !isValidTransition(current.status, nextStatus)) {
    throw invalidLifecycleTransitionError(current.status, nextStatus);
  }

  let slug = current.slug;
  if (body.slug !== undefined) {
    slug = normalizeSlug(body.slug);
    if (slug !== current.slug) await assertSlugAvailable(slug, id);
  }

  const where = body.expectedVersion !== undefined ? and(eq(categories.id, id), eq(categories.version, current.version)) : eq(categories.id, id);

  const [updated] = await getDb()
    .update(categories)
    .set({
      name: body.name ?? current.name,
      slug,
      status: nextStatus,
      sortOrder: body.sortOrder ?? current.sortOrder,
      version: current.version + 1,
      updatedAt: new Date(),
    })
    .where(where)
    .returning();
  if (!updated) throw versionConflictError();

  await recordAdminAuditEvent({
    actorUserId,
    actorRoles,
    eventType: 'catalog.category_edited',
    resource: 'catalog.category',
    action: 'edit',
    targetType: 'category',
    targetId: id,
    approvalChain: [],
  });

  const subRows = await getDb().select().from(subcategories).where(eq(subcategories.categoryId, id));
  return toCategoryDto(updated!, subRows);
}

/** §4 Retirement and reassignment: blocked while any active (non-`retired`) `Service` still
 * references this category, directly or via one of its subcategories. */
export async function retireCategory(actorUserId: string, id: string): Promise<CategoryDto> {
  const actorRoles = await requireCatalogPermission(actorUserId, 'catalog.category', 'retire');

  const [current] = await getDb().select().from(categories).where(eq(categories.id, id));
  if (!current) throw catalogNotFoundError();
  if (!isValidTransition(current.status, 'retired')) throw invalidLifecycleTransitionError(current.status, 'retired');

  const subRows = await getDb().select({ id: subcategories.id }).from(subcategories).where(eq(subcategories.categoryId, id));
  const subIds = subRows.map((s) => s.id);

  const activeDirect = await getDb()
    .select({ id: services.id })
    .from(services)
    .where(and(eq(services.categoryId, id), ne(services.status, 'retired')));
  const activeViaSub = subIds.length
    ? await getDb()
        .select({ id: services.id })
        .from(services)
        .where(and(inArray(services.subcategoryId, subIds), ne(services.status, 'retired')))
    : [];
  if (activeDirect.length > 0 || activeViaSub.length > 0) throw categoryHasActiveServicesError();

  const [updated] = await getDb()
    .update(categories)
    .set({ status: 'retired', version: current.version + 1, updatedAt: new Date() })
    .where(eq(categories.id, id))
    .returning();

  await recordAdminAuditEvent({
    actorUserId,
    actorRoles,
    eventType: 'catalog.category_retired',
    resource: 'catalog.category',
    action: 'retire',
    targetType: 'category',
    targetId: id,
    approvalChain: [],
  });

  const finalSubRows = await getDb().select().from(subcategories).where(eq(subcategories.categoryId, id));
  return toCategoryDto(updated!, finalSubRows);
}

export { toCategoryDto, toSubcategoryDto };
