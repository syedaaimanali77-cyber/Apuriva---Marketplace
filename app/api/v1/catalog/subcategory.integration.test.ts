import { describe, expect, it } from 'vitest';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { POST as CREATE_CATEGORY } from '@/app/api/v1/admin/categories/route';
import { POST as RETIRE_SUBCATEGORY } from '@/app/api/v1/admin/subcategories/[id]/retire/route';
import { GET as LIST_SUBCATEGORIES, POST as CREATE_SUBCATEGORY } from '@/app/api/v1/admin/categories/[categoryId]/subcategories/route';
import { POST as CREATE_SERVICE } from '@/app/api/v1/admin/services/route';
import { PATCH as EDIT_SERVICE } from '@/app/api/v1/admin/services/[id]/route';
import { authenticatedRequest, isDatabaseReachable, registerContentAdmin } from './catalog-test-support';

const dbReachable = await isDatabaseReachable();

function uniqueSlug(base: string): string {
  return `${base}-${Math.random().toString(36).slice(2, 10)}`;
}

async function createPublishedCategory(admin: Awaited<ReturnType<typeof registerContentAdmin>>) {
  const res = await CREATE_CATEGORY(
    authenticatedRequest('http://localhost/api/v1/admin/categories', admin.sessionId, admin.csrfToken, {
      method: 'POST',
      body: { name: 'Parent', slug: uniqueSlug('parent'), status: 'published' },
    }),
  );
  return (await res.json()).data;
}

describe.skipIf(!dbReachable)('admin subcategory CRUD + taxonomy + retirement (spec 010 AC-2/AC-4, integration)', () => {
  it('creates a subcategory under an active category — validated, versioned, audited', async () => {
    resetRateLimitState();
    const admin = await registerContentAdmin();
    const category = await createPublishedCategory(admin);

    const res = await CREATE_SUBCATEGORY(
      authenticatedRequest(`http://localhost/api/v1/admin/categories/${category.id}/subcategories`, admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { name: 'Sub One', slug: uniqueSlug('sub-one') },
      }),
    );
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data).toMatchObject({ categoryId: category.id, name: 'Sub One', status: 'draft', version: 1 });
  });

  it('creating a subcategory under a draft (inactive) category returns 422 INVALID_TAXONOMY_PATH', async () => {
    resetRateLimitState();
    const admin = await registerContentAdmin();
    const draftRes = await CREATE_CATEGORY(
      authenticatedRequest('http://localhost/api/v1/admin/categories', admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { name: 'Still Draft', slug: uniqueSlug('still-draft') },
      }),
    );
    const draftCategory = (await draftRes.json()).data;

    const res = await CREATE_SUBCATEGORY(
      authenticatedRequest(`http://localhost/api/v1/admin/categories/${draftCategory.id}/subcategories`, admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { name: 'Orphan Sub', slug: uniqueSlug('orphan-sub') },
      }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('INVALID_TAXONOMY_PATH');
  });

  it('a slug that collides within the same category returns 409 CONFLICT, but is reusable in a different category', async () => {
    resetRateLimitState();
    const admin = await registerContentAdmin();
    const categoryA = await createPublishedCategory(admin);
    const categoryB = await createPublishedCategory(admin);
    const slug = uniqueSlug('shared-slug');

    const first = await CREATE_SUBCATEGORY(
      authenticatedRequest(`http://localhost/api/v1/admin/categories/${categoryA.id}/subcategories`, admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { name: 'A', slug },
      }),
    );
    expect(first.status).toBe(201);

    const dup = await CREATE_SUBCATEGORY(
      authenticatedRequest(`http://localhost/api/v1/admin/categories/${categoryA.id}/subcategories`, admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { name: 'A2', slug },
      }),
    );
    expect(dup.status).toBe(409);

    const inOtherCategory = await CREATE_SUBCATEGORY(
      authenticatedRequest(`http://localhost/api/v1/admin/categories/${categoryB.id}/subcategories`, admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { name: 'B', slug },
      }),
    );
    expect(inOtherCategory.status).toBe(201);
  });

  it('AC-4: retiring a subcategory with an active service attached is blocked — 422 SUBCATEGORY_HAS_ACTIVE_SERVICES — then succeeds after reassignment', async () => {
    resetRateLimitState();
    const admin = await registerContentAdmin();
    const categoryA = await createPublishedCategory(admin);
    const categoryB = await createPublishedCategory(admin);

    const subRes = await CREATE_SUBCATEGORY(
      authenticatedRequest(`http://localhost/api/v1/admin/categories/${categoryA.id}/subcategories`, admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { name: 'Sub', slug: uniqueSlug('sub'), status: 'published' },
      }),
    );
    const subcategory = (await subRes.json()).data;

    const svcRes = await CREATE_SERVICE(
      authenticatedRequest('http://localhost/api/v1/admin/services', admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { categoryId: categoryA.id, subcategoryId: subcategory.id, name: 'Attached Service', slug: uniqueSlug('attached-svc'), pricingModel: 'quote' },
      }),
    );
    const service = (await svcRes.json()).data;

    const blocked = await RETIRE_SUBCATEGORY(
      authenticatedRequest(`http://localhost/api/v1/admin/subcategories/${subcategory.id}/retire`, admin.sessionId, admin.csrfToken, { method: 'POST' }),
    );
    expect(blocked.status).toBe(422);
    expect((await blocked.json()).code).toBe('SUBCATEGORY_HAS_ACTIVE_SERVICES');

    const reassign = await EDIT_SERVICE(
      authenticatedRequest(`http://localhost/api/v1/admin/services/${service.id}`, admin.sessionId, admin.csrfToken, {
        method: 'PATCH',
        body: { categoryId: categoryB.id, subcategoryId: null },
      }),
    );
    expect(reassign.status).toBe(200);

    const retired = await RETIRE_SUBCATEGORY(
      authenticatedRequest(`http://localhost/api/v1/admin/subcategories/${subcategory.id}/retire`, admin.sessionId, admin.csrfToken, { method: 'POST' }),
    );
    expect(retired.status).toBe(200);
    expect((await retired.json()).data.status).toBe('retired');
  });

  it('GET .../subcategories lists all statuses under a category', async () => {
    resetRateLimitState();
    const admin = await registerContentAdmin();
    const category = await createPublishedCategory(admin);
    await CREATE_SUBCATEGORY(
      authenticatedRequest(`http://localhost/api/v1/admin/categories/${category.id}/subcategories`, admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { name: 'Listed Sub', slug: uniqueSlug('listed-sub') },
      }),
    );

    const res = await LIST_SUBCATEGORIES(
      authenticatedRequest(`http://localhost/api/v1/admin/categories/${category.id}/subcategories`, admin.sessionId, admin.csrfToken, { method: 'GET' }),
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.some((s: { name: string }) => s.name === 'Listed Sub')).toBe(true);
  });
});
