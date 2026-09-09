import { describe, expect, it } from 'vitest';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { GET as LIST_CATEGORIES_PUBLIC } from '@/app/api/v1/categories/route';
import { GET as GET_CATEGORY_PUBLIC } from '@/app/api/v1/categories/[id]/route';
import { GET as GET_SERVICE_PUBLIC } from '@/app/api/v1/services/[id]/route';
import { POST as CREATE_CATEGORY } from '@/app/api/v1/admin/categories/route';
import { POST as CREATE_SUBCATEGORY } from '@/app/api/v1/admin/categories/[categoryId]/subcategories/route';
import { POST as CREATE_SERVICE } from '@/app/api/v1/admin/services/route';
import { PATCH as EDIT_SERVICE } from '@/app/api/v1/admin/services/[id]/route';
import { authenticatedRequest, isDatabaseReachable, registerContentAdmin } from './catalog-test-support';

const dbReachable = await isDatabaseReachable();

function uniqueSlug(base: string): string {
  return `${base}-${Math.random().toString(36).slice(2, 10)}`;
}

describe.skipIf(!dbReachable)('public catalog reads (spec 010 AC-5, integration)', () => {
  it('a guest never sees a draft category in the list', async () => {
    resetRateLimitState();
    const admin = await registerContentAdmin();
    const draftRes = await CREATE_CATEGORY(
      authenticatedRequest('http://localhost/api/v1/admin/categories', admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { name: 'Hidden Draft', slug: uniqueSlug('hidden-draft') },
      }),
    );
    const draft = (await draftRes.json()).data;

    const res = await LIST_CATEGORIES_PUBLIC(new Request('http://localhost/api/v1/categories'));
    const { data } = await res.json();
    expect(data.some((c: { id: string }) => c.id === draft.id)).toBe(false);
  });

  it('a guest gets 404 reading a draft/pending_review/retired category by id', async () => {
    resetRateLimitState();
    const admin = await registerContentAdmin();
    const draftRes = await CREATE_CATEGORY(
      authenticatedRequest('http://localhost/api/v1/admin/categories', admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { name: 'Not Public', slug: uniqueSlug('not-public') },
      }),
    );
    const draft = (await draftRes.json()).data;

    const res = await GET_CATEGORY_PUBLIC(new Request(`http://localhost/api/v1/categories/${draft.id}`));
    expect(res.status).toBe(404);
  });

  it('category detail exposes only published child subcategories', async () => {
    resetRateLimitState();
    const admin = await registerContentAdmin();
    const catRes = await CREATE_CATEGORY(
      authenticatedRequest('http://localhost/api/v1/admin/categories', admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { name: 'Parent Pub', slug: uniqueSlug('parent-pub'), status: 'published' },
      }),
    );
    const category = (await catRes.json()).data;

    await CREATE_SUBCATEGORY(
      authenticatedRequest(`http://localhost/api/v1/admin/categories/${category.id}/subcategories`, admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { name: 'Published Sub', slug: uniqueSlug('published-sub'), status: 'published' },
      }),
    );
    await CREATE_SUBCATEGORY(
      authenticatedRequest(`http://localhost/api/v1/admin/categories/${category.id}/subcategories`, admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { name: 'Draft Sub', slug: uniqueSlug('draft-sub') },
      }),
    );

    const res = await GET_CATEGORY_PUBLIC(new Request(`http://localhost/api/v1/categories/${category.id}`));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    const names = data.subcategories.map((s: { name: string }) => s.name);
    expect(names).toContain('Published Sub');
    expect(names).not.toContain('Draft Sub');
  });

  it('service detail only resolves for a published service — draft is 404, published is 200', async () => {
    resetRateLimitState();
    const admin = await registerContentAdmin();
    const catRes = await CREATE_CATEGORY(
      authenticatedRequest('http://localhost/api/v1/admin/categories', admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { name: 'Svc Parent', slug: uniqueSlug('svc-parent'), status: 'published' },
      }),
    );
    const category = (await catRes.json()).data;

    const svcRes = await CREATE_SERVICE(
      authenticatedRequest('http://localhost/api/v1/admin/services', admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { categoryId: category.id, name: 'Draft Service', slug: uniqueSlug('draft-service'), pricingModel: 'quote' },
      }),
    );
    const service = (await svcRes.json()).data;

    const draftRead = await GET_SERVICE_PUBLIC(new Request(`http://localhost/api/v1/services/${service.id}`));
    expect(draftRead.status).toBe(404);

    await EDIT_SERVICE(
      authenticatedRequest(`http://localhost/api/v1/admin/services/${service.id}`, admin.sessionId, admin.csrfToken, {
        method: 'PATCH',
        body: { status: 'published', expectedVersion: 1 },
      }),
    );

    const publishedRead = await GET_SERVICE_PUBLIC(new Request(`http://localhost/api/v1/services/${service.id}`));
    expect(publishedRead.status).toBe(200);
    expect((await publishedRead.json()).data.status).toBe('published');
  });
});
