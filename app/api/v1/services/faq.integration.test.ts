import { describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { categories, serviceFaqs, services } from '@/lib/db/schema';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { POST as CREATE_OFFICIAL_FAQ } from '@/app/api/v1/admin/services/[id]/faqs/route';
import { POST as CREATE_PROVIDER_FAQ } from '@/app/api/v1/providers/me/services/[id]/faqs/route';
import { POST as APPROVE_AI_FAQ } from '@/app/api/v1/admin/services/[id]/faqs/ai-suggestions/[suggestionId]/approve/route';
import { GET as GET_SERVICE_PAGE_PUBLIC } from '@/app/api/v1/services/[id]/page/route';
import {
  authenticatedRequest,
  isDatabaseReachable,
  registerAdmin,
  registerProviderNotOffering,
  registerProviderOffering,
  registerServicePageAdmin,
} from './service-page-test-support';

const dbReachable = await isDatabaseReachable();

function uniqueSlug(base: string): string {
  return `${base}-${Math.random().toString(36).slice(2, 10)}`;
}

async function createPublishedService(): Promise<string> {
  const [category] = await getDb().insert(categories).values({ name: 'FAQ Test', slug: uniqueSlug('faq-test-cat'), status: 'published' }).returning({ id: categories.id });
  const [service] = await getDb()
    .insert(services)
    .values({ categoryId: category!.id, name: 'FAQ Test Service', slug: uniqueSlug('faq-test-svc'), pricingModel: 'quote', status: 'published' })
    .returning({ id: services.id });
  return service!.id;
}

describe.skipIf(!dbReachable)('service FAQ ownership + AI-suggestion lifecycle (spec 011 AC-5/AC-6, integration)', () => {
  it('a Content/Marketplace admin adds an official FAQ, published immediately', async () => {
    resetRateLimitState();
    const admin = await registerServicePageAdmin();
    const serviceId = await createPublishedService();

    const res = await CREATE_OFFICIAL_FAQ(
      authenticatedRequest(`http://localhost/api/v1/admin/services/${serviceId}/faqs`, admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { question: 'How long does it take?', answer: 'Usually 1-2 hours.' },
      }),
    );
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data).toMatchObject({ source: 'official', status: 'published', providerId: null });
  });

  it('a non-Content/Marketplace admin cannot add an official FAQ — 403 FORBIDDEN', async () => {
    resetRateLimitState();
    const plainAdmin = await registerAdmin();
    const serviceId = await createPublishedService();

    const res = await CREATE_OFFICIAL_FAQ(
      authenticatedRequest(`http://localhost/api/v1/admin/services/${serviceId}/faqs`, plainAdmin.sessionId, plainAdmin.csrfToken, {
        method: 'POST',
        body: { question: 'Q', answer: 'A' },
      }),
    );
    expect(res.status).toBe(403);
  });

  it('AC-6: a provider who offers the service can add their own FAQ, visibly source: provider', async () => {
    resetRateLimitState();
    const serviceId = await createPublishedService();
    const provider = await registerProviderOffering(serviceId);

    const res = await CREATE_PROVIDER_FAQ(
      authenticatedRequest(`http://localhost/api/v1/providers/me/services/${serviceId}/faqs`, provider.sessionId, provider.csrfToken, {
        method: 'POST',
        body: { question: 'Do you bring your own equipment?', answer: 'Yes, always.' },
      }),
    );
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data).toMatchObject({ source: 'provider', status: 'published', providerId: provider.providerProfileId });
  });

  it('a provider NOT offering the service is rejected — 403 FORBIDDEN (ownership-checked)', async () => {
    resetRateLimitState();
    const serviceId = await createPublishedService();
    const provider = await registerProviderNotOffering();

    const res = await CREATE_PROVIDER_FAQ(
      authenticatedRequest(`http://localhost/api/v1/providers/me/services/${serviceId}/faqs`, provider.sessionId, provider.csrfToken, {
        method: 'POST',
        body: { question: 'Q', answer: 'A' },
      }),
    );
    expect(res.status).toBe(403);
  });

  it('AC-5: an AI-suggested FAQ is never shown to customers until an admin approves it, then displays as official', async () => {
    resetRateLimitState();
    const admin = await registerServicePageAdmin();
    const serviceId = await createPublishedService();

    const [suggestion] = await getDb()
      .insert(serviceFaqs)
      .values({ serviceId, providerProfileId: null, question: 'Is a deposit required?', answer: 'A 20% deposit is typical.', source: 'ai_suggested', status: 'pending_review' })
      .returning();

    const beforeApproval = await GET_SERVICE_PAGE_PUBLIC(new Request(`http://localhost/api/v1/services/${serviceId}/page`));
    const beforeData = (await beforeApproval.json()).data;
    expect(beforeData.faqs.some((f: { id: string }) => f.id === suggestion!.id)).toBe(false);

    const approveRes = await APPROVE_AI_FAQ(
      authenticatedRequest(`http://localhost/api/v1/admin/services/${serviceId}/faqs/ai-suggestions/${suggestion!.id}/approve`, admin.sessionId, admin.csrfToken, {
        method: 'POST',
      }),
    );
    expect(approveRes.status).toBe(200);
    expect((await approveRes.json()).data.status).toBe('published');

    const afterApproval = await GET_SERVICE_PAGE_PUBLIC(new Request(`http://localhost/api/v1/services/${serviceId}/page`));
    const afterData = (await afterApproval.json()).data;
    const published = afterData.faqs.find((f: { id: string }) => f.id === suggestion!.id);
    expect(published).toBeTruthy();
    expect(published.source).toBe('official');
  });

  it('approving an already-approved AI suggestion returns 409 CONFLICT', async () => {
    resetRateLimitState();
    const admin = await registerServicePageAdmin();
    const serviceId = await createPublishedService();
    const [suggestion] = await getDb()
      .insert(serviceFaqs)
      .values({ serviceId, question: 'Q', answer: 'A', source: 'ai_suggested', status: 'pending_review' })
      .returning();

    await APPROVE_AI_FAQ(
      authenticatedRequest(`http://localhost/api/v1/admin/services/${serviceId}/faqs/ai-suggestions/${suggestion!.id}/approve`, admin.sessionId, admin.csrfToken, { method: 'POST' }),
    );
    const second = await APPROVE_AI_FAQ(
      authenticatedRequest(`http://localhost/api/v1/admin/services/${serviceId}/faqs/ai-suggestions/${suggestion!.id}/approve`, admin.sessionId, admin.csrfToken, { method: 'POST' }),
    );
    expect(second.status).toBe(409);
  });

  it('the AI itself never has a path to publish — approving a non-ai_suggested FAQ is rejected', async () => {
    resetRateLimitState();
    const admin = await registerServicePageAdmin();
    const serviceId = await createPublishedService();
    const [official] = await getDb().insert(serviceFaqs).values({ serviceId, question: 'Q', answer: 'A', source: 'official', status: 'published' }).returning();

    const res = await APPROVE_AI_FAQ(
      authenticatedRequest(`http://localhost/api/v1/admin/services/${serviceId}/faqs/ai-suggestions/${official!.id}/approve`, admin.sessionId, admin.csrfToken, { method: 'POST' }),
    );
    expect(res.status).toBe(422);
  });
});
