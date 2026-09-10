import { desc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { securityEvents } from '@/lib/db/schema';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { POST as CREATE_CATEGORY } from '@/app/api/v1/admin/categories/route';
import { POST as RETIRE_CATEGORY } from '@/app/api/v1/admin/categories/[id]/retire/route';
import { POST as CREATE_SUGGESTION } from '@/app/api/v1/admin/catalog/suggestions/route';
import { POST as APPROVE_SUGGESTION } from '@/app/api/v1/admin/catalog/pending-review/[id]/approve/route';
import { authenticatedRequest, isDatabaseReachable, registerContentAdmin } from './catalog-test-support';

const dbReachable = await isDatabaseReachable();

function uniqueSlug(base: string): string {
  return `${base}-${Math.random().toString(36).slice(2, 10)}`;
}

async function latestEventFor(userId: string, eventType: string) {
  const [row] = await getDb().select().from(securityEvents).where(eq(securityEvents.userId, userId)).orderBy(desc(securityEvents.createdAt));
  expect(row?.eventType).toBe(eventType);
  return row!;
}

describe.skipIf(!dbReachable)('catalog mutations are audited (spec 010 AC-2, integration)', () => {
  it('creating a category emits an audit event with actor/role/resource/action/target', async () => {
    resetRateLimitState();
    const admin = await registerContentAdmin();
    const res = await CREATE_CATEGORY(
      authenticatedRequest('http://localhost/api/v1/admin/categories', admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { name: 'Audited', slug: uniqueSlug('audited') },
      }),
    );
    const { data: category } = await res.json();

    const event = await latestEventFor(admin.userId, 'catalog.category_created');
    const metadata = event.metadata as Record<string, unknown>;
    expect(metadata.actorRoles).toEqual(['content_admin']);
    expect(metadata.resource).toBe('catalog.category');
    expect(metadata.action).toBe('create');
    expect(metadata.targetType).toBe('category');
    expect(metadata.targetId).toBe(category.id);
  });

  it('retiring a category emits an audit event with the retire action and target', async () => {
    resetRateLimitState();
    const admin = await registerContentAdmin();
    const created = await CREATE_CATEGORY(
      authenticatedRequest('http://localhost/api/v1/admin/categories', admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { name: 'Retire Audited', slug: uniqueSlug('retire-audited') },
      }),
    );
    const { data: category } = await created.json();

    await RETIRE_CATEGORY(authenticatedRequest(`http://localhost/api/v1/admin/categories/${category.id}/retire`, admin.sessionId, admin.csrfToken, { method: 'POST' }));

    const event = await latestEventFor(admin.userId, 'catalog.category_retired');
    const metadata = event.metadata as Record<string, unknown>;
    expect(metadata.action).toBe('retire');
    expect(metadata.targetId).toBe(category.id);
  });

  it('approving an AI suggestion emits an audit event carrying the review outcome (reviewedBy/reviewedAt/resultingEntityId)', async () => {
    resetRateLimitState();
    const admin = await registerContentAdmin();
    const createRes = await CREATE_SUGGESTION(
      authenticatedRequest('http://localhost/api/v1/admin/catalog/suggestions', admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { entityType: 'category', proposedName: 'Audit Suggestion', proposedSlug: uniqueSlug('audit-suggestion'), source: 'ai_assistant' },
      }),
    );
    const suggestion = (await createRes.json()).data;

    await APPROVE_SUGGESTION(
      authenticatedRequest(`http://localhost/api/v1/admin/catalog/pending-review/${suggestion.id}/approve`, admin.sessionId, admin.csrfToken, { method: 'POST' }),
    );

    const event = await latestEventFor(admin.userId, 'catalog.suggestion_approved');
    const metadata = event.metadata as Record<string, unknown>;
    expect(metadata.resource).toBe('catalog.suggestion');
    expect(metadata.action).toBe('approve');
    const approvalChain = metadata.approvalChain as Record<string, unknown>;
    expect(approvalChain.reviewedBy).toBe(admin.userId);
    expect(approvalChain.resultingEntityId).toBeTruthy();
  });
});
