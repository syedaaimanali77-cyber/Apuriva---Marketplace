import { describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { categories, serviceRequirements, services, subcategories } from '@/lib/db/schema';
import { GET as GET_CATEGORY_PAGE } from '@/app/api/v1/categories/[id]/page/route';
import { GET as GET_SERVICE_PAGE } from '@/app/api/v1/services/[id]/page/route';
import { isDatabaseReachable } from './service-page-test-support';

const dbReachable = await isDatabaseReachable();

function uniqueSlug(base: string): string {
  return `${base}-${Math.random().toString(36).slice(2, 10)}`;
}

describe.skipIf(!dbReachable)('category/service page aggregation (spec 011 AC-1/AC-4, integration)', () => {
  it('AC-1: category page includes filters (published subcategories) and popular services (published services)', async () => {
    const [category] = await getDb().insert(categories).values({ name: 'Page Test', slug: uniqueSlug('page-test-cat'), status: 'published' }).returning();
    await getDb().insert(subcategories).values({ categoryId: category!.id, name: 'Published Sub', slug: uniqueSlug('pub-sub'), status: 'published' });
    await getDb().insert(subcategories).values({ categoryId: category!.id, name: 'Draft Sub', slug: uniqueSlug('draft-sub'), status: 'draft' });
    await getDb().insert(services).values({ categoryId: category!.id, name: 'Popular Service', slug: uniqueSlug('popular-svc'), pricingModel: 'quote', status: 'published' });

    const res = await GET_CATEGORY_PAGE(new Request(`http://localhost/api/v1/categories/${category!.id}/page`));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.filters.map((f: { name: string }) => f.name)).toEqual(['Published Sub']);
    expect(data.popularServices.some((s: { name: string }) => s.name === 'Popular Service')).toBe(true);
  });

  it('a draft category returns 404 for the page endpoint too', async () => {
    const [category] = await getDb().insert(categories).values({ name: 'Draft Page', slug: uniqueSlug('draft-page-cat'), status: 'draft' }).returning();
    const res = await GET_CATEGORY_PAGE(new Request(`http://localhost/api/v1/categories/${category!.id}/page`));
    expect(res.status).toBe(404);
  });

  it('AC-4: service page surfaces a media requirement\'s "why this helps" guidance without blocking', async () => {
    const [category] = await getDb().insert(categories).values({ name: 'Req Test', slug: uniqueSlug('req-test-cat'), status: 'published' }).returning();
    const [service] = await getDb()
      .insert(services)
      .values({ categoryId: category!.id, name: 'Req Test Service', slug: uniqueSlug('req-test-svc'), pricingModel: 'quote', status: 'published' })
      .returning();
    await getDb().insert(serviceRequirements).values({
      serviceId: service!.id,
      kind: 'media',
      detail: { helpText: 'A photo helps us quote accurately.' },
    });

    const res = await GET_SERVICE_PAGE(new Request(`http://localhost/api/v1/services/${service!.id}/page`));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.requirements).toEqual([{ id: expect.any(String), serviceId: service!.id, kind: 'media', detail: { helpText: 'A photo helps us quote accurately.' } }]);
  });

  it('a draft service returns 404 for the page endpoint too', async () => {
    const [category] = await getDb().insert(categories).values({ name: 'Draft Svc Page', slug: uniqueSlug('draft-svc-page-cat'), status: 'published' }).returning();
    const [service] = await getDb()
      .insert(services)
      .values({ categoryId: category!.id, name: 'Draft Service', slug: uniqueSlug('draft-svc-page'), pricingModel: 'quote', status: 'draft' })
      .returning();
    const res = await GET_SERVICE_PAGE(new Request(`http://localhost/api/v1/services/${service!.id}/page`));
    expect(res.status).toBe(404);
  });
});
