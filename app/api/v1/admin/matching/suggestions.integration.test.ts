import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { services } from '@/lib/db/schema';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { registerAdmin, registerAdminWithPermission } from '@/app/api/v1/admin/admin-rbac-test-support';
import { recordMatchingSuggestion } from '@/lib/matching/admin';
import { DEFAULT_MATCHING_WEIGHTS } from '@/lib/matching/weights';
import { GET as LIST_SUGGESTIONS } from './suggestions/route';
import { POST as APPROVE } from './suggestions/[id]/approve/route';
import { POST as REJECT } from './suggestions/[id]/reject/route';
import { authenticatedRequest, isDatabaseReachable, registerProvider, seedProviderService, sessionGet } from '@/lib/matching/matching-test-support';
import type { TestSession } from '@/lib/matching/matching-test-support';

const dbReachable = await isDatabaseReachable();

function mutate(url: string, admin: TestSession): Request {
  return authenticatedRequest(url, admin.sessionId, admin.csrfToken, { method: 'POST' });
}

async function seedService(): Promise<{ serviceId: string }> {
  const provider = await registerProvider();
  return seedProviderService(provider.providerProfileId);
}

describe.skipIf(!dbReachable)('AI matching-suggestion review workflow (spec 017 AC-7, integration)', () => {
  afterAll(async () => {
    await getPool().end();
  });

  beforeEach(() => {
    resetRateLimitState();
  });

  it('a recorded suggestion is listed pending_review and never alters live weights on its own', async () => {
    const { serviceId } = await seedService();
    const proposed = { ...DEFAULT_MATCHING_WEIGHTS, rating: 30, serviceMatch: 5 };
    const suggestion = await recordMatchingSuggestion({
      serviceId,
      suggestedWeights: proposed,
      rationale: 'Ratings correlate strongly with completion in this category.',
      source: 'ai-assistant-v1',
    });
    expect(suggestion.status).toBe('pending_review');

    const admin = await registerAdminWithPermission('operations_admin', 'matching.config', 'read', 'low');
    const res = await LIST_SUGGESTIONS(sessionGet('http://localhost/api/v1/admin/matching/suggestions', admin));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.map((s: { id: string }) => s.id)).toContain(suggestion.id);

    // Recording alone must never touch services.matching_weights.
    const [row] = await getDb().select({ matchingWeights: services.matchingWeights }).from(services).where(eq(services.id, serviceId));
    expect(row!.matchingWeights).toBeNull();
  });

  it('approving applies the suggested weights to the target service — the only path that can', async () => {
    const { serviceId } = await seedService();
    const proposed = { ...DEFAULT_MATCHING_WEIGHTS, rating: 30, serviceMatch: 5 };
    const suggestion = await recordMatchingSuggestion({ serviceId, suggestedWeights: proposed, source: 'ai-assistant-v1' });

    const admin = await registerAdminWithPermission('operations_admin', 'matching.config', 'configure', 'medium');
    const res = await APPROVE(mutate(`http://localhost/api/v1/admin/matching/suggestions/${suggestion.id}/approve`, admin));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.status).toBe('approved');

    const [row] = await getDb().select({ matchingWeights: services.matchingWeights }).from(services).where(eq(services.id, serviceId));
    expect(row!.matchingWeights).toEqual(proposed);
  });

  it('rejecting records the decision and never touches live weights', async () => {
    const { serviceId } = await seedService();
    const suggestion = await recordMatchingSuggestion({
      serviceId,
      suggestedWeights: { ...DEFAULT_MATCHING_WEIGHTS, rating: 30, serviceMatch: 5 },
      source: 'ai-assistant-v1',
    });

    const admin = await registerAdminWithPermission('operations_admin', 'matching.config', 'configure', 'medium');
    const res = await REJECT(mutate(`http://localhost/api/v1/admin/matching/suggestions/${suggestion.id}/reject`, admin));
    expect(res.status).toBe(200);
    expect((await res.json()).data.status).toBe('rejected');

    const [row] = await getDb().select({ matchingWeights: services.matchingWeights }).from(services).where(eq(services.id, serviceId));
    expect(row!.matchingWeights).toBeNull();
  });

  it('approving an already-reviewed suggestion is 409 SUGGESTION_ALREADY_REVIEWED', async () => {
    const { serviceId } = await seedService();
    const suggestion = await recordMatchingSuggestion({
      serviceId,
      suggestedWeights: DEFAULT_MATCHING_WEIGHTS,
      source: 'ai-assistant-v1',
    });
    const admin = await registerAdminWithPermission('operations_admin', 'matching.config', 'configure', 'medium');

    await APPROVE(mutate(`http://localhost/api/v1/admin/matching/suggestions/${suggestion.id}/approve`, admin));
    const second = await APPROVE(mutate(`http://localhost/api/v1/admin/matching/suggestions/${suggestion.id}/approve`, admin));
    expect(second.status).toBe(409);
    expect((await second.json()).code).toBe('SUGGESTION_ALREADY_REVIEWED');
  });

  it('rejecting an already-approved suggestion is also 409 SUGGESTION_ALREADY_REVIEWED', async () => {
    const { serviceId } = await seedService();
    const suggestion = await recordMatchingSuggestion({
      serviceId,
      suggestedWeights: DEFAULT_MATCHING_WEIGHTS,
      source: 'ai-assistant-v1',
    });
    const admin = await registerAdminWithPermission('operations_admin', 'matching.config', 'configure', 'medium');

    await APPROVE(mutate(`http://localhost/api/v1/admin/matching/suggestions/${suggestion.id}/approve`, admin));
    const res = await REJECT(mutate(`http://localhost/api/v1/admin/matching/suggestions/${suggestion.id}/reject`, admin));
    expect(res.status).toBe(409);
  });

  it('an admin lacking matching.config/configure cannot approve', async () => {
    const { serviceId } = await seedService();
    const suggestion = await recordMatchingSuggestion({
      serviceId,
      suggestedWeights: DEFAULT_MATCHING_WEIGHTS,
      source: 'ai-assistant-v1',
    });
    const admin = await registerAdmin();
    const res = await APPROVE(mutate(`http://localhost/api/v1/admin/matching/suggestions/${suggestion.id}/approve`, admin));
    expect(res.status).toBe(403);
  });

  it('recordMatchingSuggestion rejects invalid weights before ever creating a pending row', async () => {
    await expect(
      recordMatchingSuggestion({ suggestedWeights: { ...DEFAULT_MATCHING_WEIGHTS, rating: 999 }, source: 'ai-assistant-v1' }),
    ).rejects.toMatchObject({ code: 'INVALID_MATCHING_WEIGHTS' });
  });

  it('a platform-wide suggestion (serviceId null) is reviewable but applies to no service automatically', async () => {
    const suggestion = await recordMatchingSuggestion({
      serviceId: null,
      suggestedWeights: { ...DEFAULT_MATCHING_WEIGHTS, rating: 30, serviceMatch: 5 },
      source: 'ai-assistant-v1',
    });
    const admin = await registerAdminWithPermission('operations_admin', 'matching.config', 'configure', 'medium');
    const res = await APPROVE(mutate(`http://localhost/api/v1/admin/matching/suggestions/${suggestion.id}/approve`, admin));
    expect(res.status).toBe(200);
    expect((await res.json()).data.status).toBe('approved');
    // No service was targeted, so nothing to assert changed — the point is this doesn't throw.
  });
});
