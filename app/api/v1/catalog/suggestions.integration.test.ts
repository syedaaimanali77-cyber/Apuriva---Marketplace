import { describe, expect, it } from 'vitest';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { POST as CREATE_SUGGESTION } from '@/app/api/v1/admin/catalog/suggestions/route';
import { GET as LIST_PENDING_REVIEW } from '@/app/api/v1/admin/catalog/pending-review/route';
import { POST as APPROVE_SUGGESTION } from '@/app/api/v1/admin/catalog/pending-review/[id]/approve/route';
import { POST as REJECT_SUGGESTION } from '@/app/api/v1/admin/catalog/pending-review/[id]/reject/route';
import { GET as GET_CATEGORY_ADMIN } from '@/app/api/v1/admin/categories/[id]/route';
import { GET as GET_CATEGORY_PUBLIC } from '@/app/api/v1/categories/[id]/route';
import { authenticatedRequest, isDatabaseReachable, registerAdmin, registerContentAdmin } from './catalog-test-support';

const dbReachable = await isDatabaseReachable();

function uniqueSlug(base: string): string {
  return `${base}-${Math.random().toString(36).slice(2, 10)}`;
}

describe.skipIf(!dbReachable)('AI catalog suggestions (spec 010 AC-3, integration)', () => {
  it('creating a suggestion never creates or publishes a catalog entity — persisted pending_review only', async () => {
    resetRateLimitState();
    const anyAuthenticated = await registerAdmin();

    const res = await CREATE_SUGGESTION(
      authenticatedRequest('http://localhost/api/v1/admin/catalog/suggestions', anyAuthenticated.sessionId, anyAuthenticated.csrfToken, {
        method: 'POST',
        body: { entityType: 'category', proposedName: 'AI Category', proposedSlug: uniqueSlug('ai-category'), source: 'ai_assistant' },
      }),
    );
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data).toMatchObject({ status: 'pending_review', resultingEntityId: null, reviewedAt: null, reviewedBy: null });
  });

  it('a non-Content/Marketplace admin cannot list, approve, or reject — 403 FORBIDDEN', async () => {
    resetRateLimitState();
    const creator = await registerAdmin();
    const nonContentAdmin = await registerAdmin();

    const createRes = await CREATE_SUGGESTION(
      authenticatedRequest('http://localhost/api/v1/admin/catalog/suggestions', creator.sessionId, creator.csrfToken, {
        method: 'POST',
        body: { entityType: 'category', proposedName: 'X', proposedSlug: uniqueSlug('x'), source: 'ai_assistant' },
      }),
    );
    const suggestion = (await createRes.json()).data;

    const list = await LIST_PENDING_REVIEW(
      authenticatedRequest('http://localhost/api/v1/admin/catalog/pending-review', nonContentAdmin.sessionId, nonContentAdmin.csrfToken, { method: 'GET' }),
    );
    expect(list.status).toBe(403);

    const approve = await APPROVE_SUGGESTION(
      authenticatedRequest(`http://localhost/api/v1/admin/catalog/pending-review/${suggestion.id}/approve`, nonContentAdmin.sessionId, nonContentAdmin.csrfToken, { method: 'POST' }),
    );
    expect(approve.status).toBe(403);

    const reject = await REJECT_SUGGESTION(
      authenticatedRequest(`http://localhost/api/v1/admin/catalog/pending-review/${suggestion.id}/reject`, nonContentAdmin.sessionId, nonContentAdmin.csrfToken, { method: 'POST' }),
    );
    expect(reject.status).toBe(403);
  });

  it('approve validates the proposal, creates the entity as pending_review (never published), and records reviewer fields — AI never publishes directly', async () => {
    resetRateLimitState();
    const contentAdmin = await registerContentAdmin();

    const createRes = await CREATE_SUGGESTION(
      authenticatedRequest('http://localhost/api/v1/admin/catalog/suggestions', contentAdmin.sessionId, contentAdmin.csrfToken, {
        method: 'POST',
        body: { entityType: 'category', proposedName: 'Approved Category', proposedSlug: uniqueSlug('approved-category'), source: 'ai_assistant', rationale: 'trend data' },
      }),
    );
    const suggestion = (await createRes.json()).data;

    const res = await APPROVE_SUGGESTION(
      authenticatedRequest(`http://localhost/api/v1/admin/catalog/pending-review/${suggestion.id}/approve`, contentAdmin.sessionId, contentAdmin.csrfToken, { method: 'POST' }),
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.status).toBe('approved');
    expect(data.reviewedBy).toBe(contentAdmin.userId);
    expect(data.reviewedAt).not.toBeNull();
    expect(data.resultingEntityId).not.toBeNull();

    // The resulting entity exists (admin-visible) but is NOT customer-visible — approval alone
    // never publishes it.
    const adminView = await GET_CATEGORY_ADMIN(
      authenticatedRequest(`http://localhost/api/v1/admin/categories/${data.resultingEntityId}`, contentAdmin.sessionId, contentAdmin.csrfToken, { method: 'GET' }),
    );
    expect(adminView.status).toBe(200);
    expect((await adminView.json()).data.status).toBe('pending_review');

    const publicView = await GET_CATEGORY_PUBLIC(new Request(`http://localhost/api/v1/categories/${data.resultingEntityId}`));
    expect(publicView.status).toBe(404);
  });

  it('approving an already-reviewed suggestion returns 409 SUGGESTION_ALREADY_REVIEWED', async () => {
    resetRateLimitState();
    const contentAdmin = await registerContentAdmin();
    const createRes = await CREATE_SUGGESTION(
      authenticatedRequest('http://localhost/api/v1/admin/catalog/suggestions', contentAdmin.sessionId, contentAdmin.csrfToken, {
        method: 'POST',
        body: { entityType: 'category', proposedName: 'Double Review', proposedSlug: uniqueSlug('double-review'), source: 'ai_assistant' },
      }),
    );
    const suggestion = (await createRes.json()).data;

    await APPROVE_SUGGESTION(
      authenticatedRequest(`http://localhost/api/v1/admin/catalog/pending-review/${suggestion.id}/approve`, contentAdmin.sessionId, contentAdmin.csrfToken, { method: 'POST' }),
    );
    const second = await APPROVE_SUGGESTION(
      authenticatedRequest(`http://localhost/api/v1/admin/catalog/pending-review/${suggestion.id}/approve`, contentAdmin.sessionId, contentAdmin.csrfToken, { method: 'POST' }),
    );
    expect(second.status).toBe(409);
    expect((await second.json()).code).toBe('SUGGESTION_ALREADY_REVIEWED');
  });

  it('reject records reviewer/time and leaves nothing published; rejecting again returns 409', async () => {
    resetRateLimitState();
    const contentAdmin = await registerContentAdmin();
    const createRes = await CREATE_SUGGESTION(
      authenticatedRequest('http://localhost/api/v1/admin/catalog/suggestions', contentAdmin.sessionId, contentAdmin.csrfToken, {
        method: 'POST',
        body: { entityType: 'category', proposedName: 'Rejected Category', proposedSlug: uniqueSlug('rejected-category'), source: 'ai_assistant' },
      }),
    );
    const suggestion = (await createRes.json()).data;

    const res = await REJECT_SUGGESTION(
      authenticatedRequest(`http://localhost/api/v1/admin/catalog/pending-review/${suggestion.id}/reject`, contentAdmin.sessionId, contentAdmin.csrfToken, { method: 'POST' }),
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.status).toBe('rejected');
    expect(data.resultingEntityId).toBeNull();
    expect(data.reviewedBy).toBe(contentAdmin.userId);

    const again = await REJECT_SUGGESTION(
      authenticatedRequest(`http://localhost/api/v1/admin/catalog/pending-review/${suggestion.id}/reject`, contentAdmin.sessionId, contentAdmin.csrfToken, { method: 'POST' }),
    );
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe('SUGGESTION_ALREADY_REVIEWED');
  });

  it('GET pending-review lists only pending_review suggestions for a Content/Marketplace admin', async () => {
    resetRateLimitState();
    const contentAdmin = await registerContentAdmin();
    const createRes = await CREATE_SUGGESTION(
      authenticatedRequest('http://localhost/api/v1/admin/catalog/suggestions', contentAdmin.sessionId, contentAdmin.csrfToken, {
        method: 'POST',
        body: { entityType: 'category', proposedName: 'Listed Suggestion', proposedSlug: uniqueSlug('listed-suggestion'), source: 'ai_assistant' },
      }),
    );
    const suggestion = (await createRes.json()).data;

    const res = await LIST_PENDING_REVIEW(
      authenticatedRequest('http://localhost/api/v1/admin/catalog/pending-review', contentAdmin.sessionId, contentAdmin.csrfToken, { method: 'GET' }),
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.some((s: { id: string }) => s.id === suggestion.id)).toBe(true);
  });
});
