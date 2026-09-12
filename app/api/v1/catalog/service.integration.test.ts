import { describe, expect, it } from 'vitest';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { POST as CREATE_CATEGORY } from '@/app/api/v1/admin/categories/route';
import { POST as CREATE_SUBCATEGORY } from '@/app/api/v1/admin/categories/[id]/subcategories/route';
import { POST as CREATE_SERVICE } from '@/app/api/v1/admin/services/route';
import { GET as GET_SERVICE, PATCH as EDIT_SERVICE } from '@/app/api/v1/admin/services/[id]/route';
import { POST as RETIRE_SERVICE } from '@/app/api/v1/admin/services/[id]/retire/route';
import { authenticatedRequest, isDatabaseReachable, registerContentAdmin } from './catalog-test-support';

const dbReachable = await isDatabaseReachable();

function uniqueSlug(base: string): string {
  return `${base}-${Math.random().toString(36).slice(2, 10)}`;
}

async function createPublishedCategory(admin: Awaited<ReturnType<typeof registerContentAdmin>>) {
  const res = await CREATE_CATEGORY(
    authenticatedRequest('http://localhost/api/v1/admin/categories', admin.sessionId, admin.csrfToken, {
      method: 'POST',
      body: { name: 'Cat', slug: uniqueSlug('cat'), status: 'published' },
    }),
  );
  return (await res.json()).data;
}

describe.skipIf(!dbReachable)('admin service CRUD + taxonomy + retirement (spec 010 AC-2, integration)', () => {
  it('creates a service under an active category — validated, versioned, audited', async () => {
    resetRateLimitState();
    const admin = await registerContentAdmin();
    const category = await createPublishedCategory(admin);

    const res = await CREATE_SERVICE(
      authenticatedRequest('http://localhost/api/v1/admin/services', admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { categoryId: category.id, name: 'A Service', slug: uniqueSlug('a-service'), pricingModel: 'fixed' },
      }),
    );
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data).toMatchObject({ categoryId: category.id, subcategoryId: null, pricingModel: 'fixed', status: 'draft', version: 1 });
  });

  it('a category that does not exist or is not active returns 422 INVALID_TAXONOMY_PATH', async () => {
    resetRateLimitState();
    const admin = await registerContentAdmin();
    const draftRes = await CREATE_CATEGORY(
      authenticatedRequest('http://localhost/api/v1/admin/categories', admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { name: 'Draft Cat', slug: uniqueSlug('draft-cat') },
      }),
    );
    const draftCategory = (await draftRes.json()).data;

    const res = await CREATE_SERVICE(
      authenticatedRequest('http://localhost/api/v1/admin/services', admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { categoryId: draftCategory.id, name: 'X', slug: uniqueSlug('x'), pricingModel: 'quote' },
      }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('INVALID_TAXONOMY_PATH');
  });

  it('a subcategory that belongs to a different category returns 422 INVALID_TAXONOMY_PATH', async () => {
    resetRateLimitState();
    const admin = await registerContentAdmin();
    const categoryA = await createPublishedCategory(admin);
    const categoryB = await createPublishedCategory(admin);

    const subRes = await CREATE_SUBCATEGORY(
      authenticatedRequest(`http://localhost/api/v1/admin/categories/${categoryA.id}/subcategories`, admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { name: 'Sub of A', slug: uniqueSlug('sub-of-a'), status: 'published' },
      }),
    );
    const subOfA = (await subRes.json()).data;

    const res = await CREATE_SERVICE(
      authenticatedRequest('http://localhost/api/v1/admin/services', admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { categoryId: categoryB.id, subcategoryId: subOfA.id, name: 'Mismatched', slug: uniqueSlug('mismatched'), pricingModel: 'quote' },
      }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('INVALID_TAXONOMY_PATH');
  });

  it('a duplicate service slug returns 409 CONFLICT (global scope)', async () => {
    resetRateLimitState();
    const admin = await registerContentAdmin();
    const category = await createPublishedCategory(admin);
    const slug = uniqueSlug('dup-service');

    await CREATE_SERVICE(
      authenticatedRequest('http://localhost/api/v1/admin/services', admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { categoryId: category.id, name: 'First', slug, pricingModel: 'quote' },
      }),
    );
    const res = await CREATE_SERVICE(
      authenticatedRequest('http://localhost/api/v1/admin/services', admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { categoryId: category.id, name: 'Second', slug, pricingModel: 'quote' },
      }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CONFLICT');
  });

  it('retiring a service is a soft lifecycle transition, not physical deletion', async () => {
    resetRateLimitState();
    const admin = await registerContentAdmin();
    const category = await createPublishedCategory(admin);
    const createRes = await CREATE_SERVICE(
      authenticatedRequest('http://localhost/api/v1/admin/services', admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { categoryId: category.id, name: 'Retire Me', slug: uniqueSlug('retire-me'), pricingModel: 'quote' },
      }),
    );
    const service = (await createRes.json()).data;

    const res = await RETIRE_SERVICE(
      authenticatedRequest(`http://localhost/api/v1/admin/services/${service.id}/retire`, admin.sessionId, admin.csrfToken, { method: 'POST' }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.status).toBe('retired');

    const stillReadable = await GET_SERVICE(
      authenticatedRequest(`http://localhost/api/v1/admin/services/${service.id}`, admin.sessionId, admin.csrfToken, { method: 'GET' }),
    );
    expect(stillReadable.status).toBe(200);
  });

  it('a stale expectedVersion on PATCH returns 409 CONFLICT, never a silent overwrite', async () => {
    resetRateLimitState();
    const admin = await registerContentAdmin();
    const category = await createPublishedCategory(admin);
    const createRes = await CREATE_SERVICE(
      authenticatedRequest('http://localhost/api/v1/admin/services', admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { categoryId: category.id, name: 'Versioned', slug: uniqueSlug('versioned'), pricingModel: 'quote' },
      }),
    );
    const service = (await createRes.json()).data;

    const res = await EDIT_SERVICE(
      authenticatedRequest(`http://localhost/api/v1/admin/services/${service.id}`, admin.sessionId, admin.csrfToken, {
        method: 'PATCH',
        body: { name: 'Nope', expectedVersion: 42 },
      }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CONFLICT');
  });
});
