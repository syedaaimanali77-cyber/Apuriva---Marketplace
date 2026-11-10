import { describe, expect, it } from 'vitest';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { GET as GET_ADMIN_CATEGORIES, POST as CREATE_CATEGORY } from '@/app/api/v1/admin/categories/route';
import { GET as GET_ADMIN_CATEGORY, PATCH as EDIT_CATEGORY } from '@/app/api/v1/admin/categories/[id]/route';
import { authenticatedRequest, isDatabaseReachable, registerAdmin, registerContentAdmin } from './catalog-test-support';

const dbReachable = await isDatabaseReachable();

function uniqueSlug(base: string): string {
  return `${base}-${Math.random().toString(36).slice(2, 10)}`;
}

describe.skipIf(!dbReachable)('admin category CRUD (spec 010 AC-2, integration)', () => {
  it('a Content/Marketplace admin can create a category — validated, versioned, audited', async () => {
    resetRateLimitState();
    const admin = await registerContentAdmin();
    const slug = uniqueSlug('test-category');

    const res = await CREATE_CATEGORY(
      authenticatedRequest('http://localhost/api/v1/admin/categories', admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { name: 'Test Category', slug },
      }),
    );
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data).toMatchObject({ name: 'Test Category', slug, status: 'draft', version: 1 });
  });

  it('a non-Content/Marketplace admin cannot create a category — 403 FORBIDDEN', async () => {
    resetRateLimitState();
    const plainAdmin = await registerAdmin();

    const res = await CREATE_CATEGORY(
      authenticatedRequest('http://localhost/api/v1/admin/categories', plainAdmin.sessionId, plainAdmin.csrfToken, {
        method: 'POST',
        body: { name: 'X', slug: uniqueSlug('x') },
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('FORBIDDEN');
  });

  it('missing required fields return 400 VALIDATION_ERROR', async () => {
    resetRateLimitState();
    const admin = await registerContentAdmin();

    const res = await CREATE_CATEGORY(
      authenticatedRequest('http://localhost/api/v1/admin/categories', admin.sessionId, admin.csrfToken, { method: 'POST', body: {} }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
  });

  it('a duplicate slug returns 409 CONFLICT', async () => {
    resetRateLimitState();
    const admin = await registerContentAdmin();
    const slug = uniqueSlug('dup-category');

    await CREATE_CATEGORY(
      authenticatedRequest('http://localhost/api/v1/admin/categories', admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { name: 'First', slug },
      }),
    );
    const res = await CREATE_CATEGORY(
      authenticatedRequest('http://localhost/api/v1/admin/categories', admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { name: 'Second', slug },
      }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CONFLICT');
  });

  it('editing with the correct expectedVersion succeeds and increments version', async () => {
    resetRateLimitState();
    const admin = await registerContentAdmin();
    const created = await CREATE_CATEGORY(
      authenticatedRequest('http://localhost/api/v1/admin/categories', admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { name: 'Edit Me', slug: uniqueSlug('edit-me') },
      }),
    );
    const { data: category } = await created.json();

    const res = await EDIT_CATEGORY(
      authenticatedRequest(`http://localhost/api/v1/admin/categories/${category.id}`, admin.sessionId, admin.csrfToken, {
        method: 'PATCH',
        body: { name: 'Edited', expectedVersion: 1 },
      }),
    );
    expect(res.status).toBe(200);
    const { data: updated } = await res.json();
    expect(updated.name).toBe('Edited');
    expect(updated.version).toBe(2);
  });

  it('editing with a stale expectedVersion returns 409 CONFLICT, never a silent overwrite', async () => {
    resetRateLimitState();
    const admin = await registerContentAdmin();
    const created = await CREATE_CATEGORY(
      authenticatedRequest('http://localhost/api/v1/admin/categories', admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { name: 'Stale', slug: uniqueSlug('stale') },
      }),
    );
    const { data: category } = await created.json();

    const res = await EDIT_CATEGORY(
      authenticatedRequest(`http://localhost/api/v1/admin/categories/${category.id}`, admin.sessionId, admin.csrfToken, {
        method: 'PATCH',
        body: { name: 'Should not apply', expectedVersion: 999 },
      }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CONFLICT');

    const reread = await GET_ADMIN_CATEGORY(authenticatedRequest(`http://localhost/api/v1/admin/categories/${category.id}`, admin.sessionId, admin.csrfToken, { method: 'GET' }));
    expect((await reread.json()).data.name).toBe('Stale');
  });

  it('an invalid lifecycle transition (retired -> published) returns 422 INVALID_LIFECYCLE_TRANSITION', async () => {
    resetRateLimitState();
    const admin = await registerContentAdmin();
    const created = await CREATE_CATEGORY(
      authenticatedRequest('http://localhost/api/v1/admin/categories', admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { name: 'Terminal', slug: uniqueSlug('terminal'), status: 'retired' },
      }),
    );
    const { data: category } = await created.json();

    const res = await EDIT_CATEGORY(
      authenticatedRequest(`http://localhost/api/v1/admin/categories/${category.id}`, admin.sessionId, admin.csrfToken, {
        method: 'PATCH',
        body: { status: 'published' },
      }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('INVALID_LIFECYCLE_TRANSITION');
  });

  it('GET /api/v1/admin/categories lists all statuses for a Content/Marketplace admin', async () => {
    resetRateLimitState();
    const admin = await registerContentAdmin();
    await CREATE_CATEGORY(
      authenticatedRequest('http://localhost/api/v1/admin/categories', admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { name: 'Draft One', slug: uniqueSlug('draft-one') },
      }),
    );

    const res = await GET_ADMIN_CATEGORIES(authenticatedRequest('http://localhost/api/v1/admin/categories', admin.sessionId, admin.csrfToken, { method: 'GET' }));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.some((c: { name: string }) => c.name === 'Draft One')).toBe(true);
  });
});
