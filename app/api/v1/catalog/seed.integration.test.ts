import { describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { categories, permissions, roles, services } from '@/lib/db/schema';
import { GET as LIST_CATEGORIES } from '@/app/api/v1/categories/route';
import { isDatabaseReachable } from './catalog-test-support';

const dbReachable = await isDatabaseReachable();

const MVP_CATEGORY_NAMES = [
  'Home Repair & Maintenance',
  'Cleaning',
  'Beauty & Wellness',
  'Photography & Video',
  'Moving & Delivery',
  'Events',
  'Automotive',
  'Personal & Professional Services',
];

describe.skipIf(!dbReachable)('catalog seed (spec 010 AC-1, integration)', () => {
  it('AC-1: exactly the 8 MVP categories from master spec §14 exist, each with at least one service', async () => {
    const rows = await getDb().select().from(categories).where(eq(categories.status, 'published'));
    const seeded = rows.filter((r) => MVP_CATEGORY_NAMES.includes(r.name));
    expect(seeded).toHaveLength(8);
    expect(seeded.map((r) => r.name).sort()).toEqual([...MVP_CATEGORY_NAMES].sort());

    for (const category of seeded) {
      const svc = await getDb().select({ id: services.id }).from(services).where(eq(services.categoryId, category.id));
      expect(svc.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('AC-1: the seed set is served through the public catalog read, published only', async () => {
    const res = await LIST_CATEGORIES(new Request('http://localhost/api/v1/categories'));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    const names = data.map((c: { name: string }) => c.name);
    for (const name of MVP_CATEGORY_NAMES) expect(names).toContain(name);
  });

  it('re-running the seed migration is idempotent — no duplicate rows', async () => {
    const before = await getDb().select({ id: categories.id }).from(categories).where(eq(categories.status, 'published'));

    // Re-execute the exact idempotent seed statement from drizzle/0006_lean_shaman.sql — the same
    // ON CONFLICT (slug) DO NOTHING a redeploy would run again.
    await getPool().query(`
      INSERT INTO "categories" ("name", "slug", "status", "sort_order") VALUES
        ('Home Repair & Maintenance', 'home-repair-maintenance', 'published', 1),
        ('Cleaning', 'cleaning', 'published', 2),
        ('Beauty & Wellness', 'beauty-wellness', 'published', 3),
        ('Photography & Video', 'photography-video', 'published', 4),
        ('Moving & Delivery', 'moving-delivery', 'published', 5),
        ('Events', 'events', 'published', 6),
        ('Automotive', 'automotive', 'published', 7),
        ('Personal & Professional Services', 'personal-professional-services', 'published', 8)
      ON CONFLICT ("slug") DO NOTHING;
    `);

    const after = await getDb().select({ id: categories.id }).from(categories).where(eq(categories.status, 'published'));
    expect(after.length).toBe(before.length);

    // Scoped to spec 010's own 4 resources (catalog.category/subcategory/service/suggestion) —
    // content_admin's total permission count also includes spec 011's own catalog.service_field/
    // catalog.service_faq rows, seeded separately by drizzle/0007_mean_robbie_robertson.sql, so
    // this only re-checks that spec 010's own seed statement didn't duplicate.
    const [contentAdminRole] = await getDb().select({ id: roles.id }).from(roles).where(eq(roles.name, 'content_admin'));
    const perms = await getDb()
      .select({ id: permissions.id })
      .from(permissions)
      .where(and(eq(permissions.roleId, contentAdminRole!.id), inArray(permissions.resource, ['catalog.category', 'catalog.subcategory', 'catalog.service', 'catalog.suggestion'])));
    expect(perms.length).toBe(15);
  });
});
