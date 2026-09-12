import { describe, expect, it } from 'vitest';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { POST as CREATE_CATEGORY } from '@/app/api/v1/admin/categories/route';
import { POST as RETIRE_CATEGORY } from '@/app/api/v1/admin/categories/[id]/retire/route';
import { POST as CREATE_SUBCATEGORY } from '@/app/api/v1/admin/categories/[id]/subcategories/route';
import { POST as CREATE_SERVICE } from '@/app/api/v1/admin/services/route';
import { PATCH as EDIT_SERVICE } from '@/app/api/v1/admin/services/[id]/route';
import { authenticatedRequest, isDatabaseReachable, registerContentAdmin } from './catalog-test-support';

const dbReachable = await isDatabaseReachable();

function uniqueSlug(base: string): string {
  return `${base}-${Math.random().toString(36).slice(2, 10)}`;
}

async function createPublishedCategory(admin: Awaited<ReturnType<typeof registerContentAdmin>>, name = 'Cat') {
  const res = await CREATE_CATEGORY(
    authenticatedRequest('http://localhost/api/v1/admin/categories', admin.sessionId, admin.csrfToken, {
      method: 'POST',
      body: { name, slug: uniqueSlug(name.toLowerCase().replace(/\s+/g, '-')), status: 'published' },
    }),
  );
  return (await res.json()).data;
}

describe.skipIf(!dbReachable)('category retirement / orphan prevention (spec 010 AC-4, integration)', () => {
  it('AC-4: retiring a category with a service directly attached is blocked — 422 CATEGORY_HAS_ACTIVE_SERVICES', async () => {
    resetRateLimitState();
    const admin = await registerContentAdmin();
    const category = await createPublishedCategory(admin, 'Direct Attach');
    await CREATE_SERVICE(
      authenticatedRequest('http://localhost/api/v1/admin/services', admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { categoryId: category.id, name: 'Direct Service', slug: uniqueSlug('direct-service'), pricingModel: 'quote' },
      }),
    );

    const res = await RETIRE_CATEGORY(
      authenticatedRequest(`http://localhost/api/v1/admin/categories/${category.id}/retire`, admin.sessionId, admin.csrfToken, { method: 'POST' }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('CATEGORY_HAS_ACTIVE_SERVICES');
  });

  it('AC-4: retiring a category with a service attached only via a subcategory is also blocked, and never silently orphans the service', async () => {
    resetRateLimitState();
    const admin = await registerContentAdmin();
    const category = await createPublishedCategory(admin, 'Via Sub');
    const subRes = await CREATE_SUBCATEGORY(
      authenticatedRequest(`http://localhost/api/v1/admin/categories/${category.id}/subcategories`, admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { name: 'Sub', slug: uniqueSlug('sub'), status: 'published' },
      }),
    );
    const subcategory = (await subRes.json()).data;
    const svcRes = await CREATE_SERVICE(
      authenticatedRequest('http://localhost/api/v1/admin/services', admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { categoryId: category.id, subcategoryId: subcategory.id, name: 'Via Sub Service', slug: uniqueSlug('via-sub-service'), pricingModel: 'quote' },
      }),
    );
    const service = (await svcRes.json()).data;

    const blocked = await RETIRE_CATEGORY(
      authenticatedRequest(`http://localhost/api/v1/admin/categories/${category.id}/retire`, admin.sessionId, admin.csrfToken, { method: 'POST' }),
    );
    expect(blocked.status).toBe(422);
    expect((await blocked.json()).code).toBe('CATEGORY_HAS_ACTIVE_SERVICES');

    // Reassign, then retire the original — verify the service is never left pointing at a
    // retired category (never silently orphaned).
    const otherCategory = await createPublishedCategory(admin, 'Landing Zone');
    const reassign = await EDIT_SERVICE(
      authenticatedRequest(`http://localhost/api/v1/admin/services/${service.id}`, admin.sessionId, admin.csrfToken, {
        method: 'PATCH',
        body: { categoryId: otherCategory.id, subcategoryId: null },
      }),
    );
    expect(reassign.status).toBe(200);
    expect((await reassign.json()).data.categoryId).toBe(otherCategory.id);

    const succeeded = await RETIRE_CATEGORY(
      authenticatedRequest(`http://localhost/api/v1/admin/categories/${category.id}/retire`, admin.sessionId, admin.csrfToken, { method: 'POST' }),
    );
    expect(succeeded.status).toBe(200);
    expect((await succeeded.json()).data.status).toBe('retired');
  });

  it('retirement succeeds immediately for a category with no attached services', async () => {
    resetRateLimitState();
    const admin = await registerContentAdmin();
    const category = await createPublishedCategory(admin, 'Empty Category');

    const res = await RETIRE_CATEGORY(
      authenticatedRequest(`http://localhost/api/v1/admin/categories/${category.id}/retire`, admin.sessionId, admin.csrfToken, { method: 'POST' }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.status).toBe('retired');
  });
});
