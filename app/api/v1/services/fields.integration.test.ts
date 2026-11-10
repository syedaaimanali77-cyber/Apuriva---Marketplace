import { describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { categories, services } from '@/lib/db/schema';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { POST as CREATE_FIELD } from '@/app/api/v1/admin/services/[id]/fields/route';
import { GET as LIST_FIELDS_PUBLIC } from '@/app/api/v1/services/[id]/fields/route';
import { authenticatedRequest, isDatabaseReachable, registerAdmin, registerServicePageAdmin } from './service-page-test-support';

const dbReachable = await isDatabaseReachable();

function uniqueSlug(base: string): string {
  return `${base}-${Math.random().toString(36).slice(2, 10)}`;
}

async function createPublishedService(): Promise<string> {
  const [category] = await getDb().insert(categories).values({ name: 'Fields Test', slug: uniqueSlug('fields-test-cat'), status: 'published' }).returning({ id: categories.id });
  const [service] = await getDb()
    .insert(services)
    .values({ categoryId: category!.id, name: 'Fields Test Service', slug: uniqueSlug('fields-test-svc'), pricingModel: 'quote', status: 'published' })
    .returning({ id: services.id });
  return service!.id;
}

describe.skipIf(!dbReachable)('service field definitions (spec 011 AC-3, integration)', () => {
  it('a Content/Marketplace admin can define a field for a service', async () => {
    resetRateLimitState();
    const admin = await registerServicePageAdmin();
    const serviceId = await createPublishedService();

    const res = await CREATE_FIELD(
      authenticatedRequest(`http://localhost/api/v1/admin/services/${serviceId}/fields`, admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { key: 'square_footage', label: 'Square footage', type: 'number', required: true },
      }),
    );
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data).toMatchObject({ serviceId, key: 'square_footage', type: 'number', required: true });
  });

  it('a select field with no options returns 400 VALIDATION_ERROR — the field definition itself is malformed', async () => {
    resetRateLimitState();
    const admin = await registerServicePageAdmin();
    const serviceId = await createPublishedService();

    const res = await CREATE_FIELD(
      authenticatedRequest(`http://localhost/api/v1/admin/services/${serviceId}/fields`, admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { key: 'room_type', label: 'Room type', type: 'select' },
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.errors[0].field).toBe('options');
  });

  it('a non-Content/Marketplace admin cannot define a field — 403 FORBIDDEN', async () => {
    resetRateLimitState();
    const plainAdmin = await registerAdmin();
    const serviceId = await createPublishedService();

    const res = await CREATE_FIELD(
      authenticatedRequest(`http://localhost/api/v1/admin/services/${serviceId}/fields`, plainAdmin.sessionId, plainAdmin.csrfToken, {
        method: 'POST',
        body: { key: 'x', label: 'X', type: 'text' },
      }),
    );
    expect(res.status).toBe(403);
  });

  it('GET .../fields is public and returns fields ordered by sortOrder — consumed identically by the form and the AI', async () => {
    resetRateLimitState();
    const admin = await registerServicePageAdmin();
    const serviceId = await createPublishedService();

    await CREATE_FIELD(
      authenticatedRequest(`http://localhost/api/v1/admin/services/${serviceId}/fields`, admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { key: 'second', label: 'Second', type: 'text', sortOrder: 2 },
      }),
    );
    await CREATE_FIELD(
      authenticatedRequest(`http://localhost/api/v1/admin/services/${serviceId}/fields`, admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { key: 'first', label: 'First', type: 'text', sortOrder: 1 },
      }),
    );

    const res = await LIST_FIELDS_PUBLIC(new Request(`http://localhost/api/v1/services/${serviceId}/fields`));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.map((f: { key: string }) => f.key)).toEqual(['first', 'second']);
  });
});
