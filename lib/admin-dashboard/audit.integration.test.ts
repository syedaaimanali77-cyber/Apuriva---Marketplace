import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { recordAdminAuditEvent } from '@/lib/admin-rbac/audit';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { getDb, getPool } from '@/lib/db';
import { PLATFORM_DEFAULT_CANCELLATION_CONFIG } from '@/lib/cancellation/policy-config';
import { DEFAULT_MATCHING_WEIGHTS } from '@/lib/matching/weights';
import { queryRows } from '@/lib/offers/db';
import { authenticatedRequest } from '@/app/api/v1/auth/test-support';
import { PATCH as PATCH_WEIGHTS } from '@/app/api/v1/admin/services/[id]/matching-weights/route';
import { POST as APPROVE_SUGGESTION } from '@/app/api/v1/admin/matching/suggestions/[id]/approve/route';
import { POST as PUBLISH_POLICY } from '@/app/api/v1/admin/cancellation-policies/route';
import type { TestAdmin } from '@/app/api/v1/admin/admin-rbac-test-support';
import { adminWithRole, isDatabaseReachable } from './admin-dashboard-test-support';

const dbReachable = await isDatabaseReachable();
const BASE = 'http://localhost/api/v1';

interface AuditRow {
  event_type: string;
  metadata: Record<string, unknown>;
}

async function eventsFor(userId: string, eventType: string): Promise<AuditRow[]> {
  return queryRows<AuditRow>(
    getDb(),
    sql`SELECT event_type, metadata FROM security_events
         WHERE user_id = ${userId} AND event_type = ${eventType} ORDER BY created_at ASC`,
  );
}

/** A committed category + service of this test's own (no other test reads them). */
async function seedService(): Promise<{ categoryId: string; serviceId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [category] = await queryRows<{ id: string }>(
    getDb(),
    sql`INSERT INTO categories (name, slug) VALUES (${`Audit ${suffix}`}, ${`audit-${suffix}`}) RETURNING id`,
  );
  const [service] = await queryRows<{ id: string }>(
    getDb(),
    sql`INSERT INTO services (category_id, name, slug)
        VALUES (${category!.id}, ${`Audit Service ${suffix}`}, ${`audit-service-${suffix}`}) RETURNING id`,
  );
  return { categoryId: category!.id, serviceId: service!.id };
}

async function serviceVersion(serviceId: string): Promise<number> {
  const [row] = await queryRows<{ version: number }>(getDb(), sql`SELECT version FROM services WHERE id = ${serviceId}`);
  return row!.version;
}

function patchWeights(admin: TestAdmin, serviceId: string, body: unknown): Request {
  return authenticatedRequest(`${BASE}/admin/services/${serviceId}/matching-weights`, admin.sessionId, admin.csrfToken, {
    method: 'PATCH',
    body,
  });
}

async function insertSuggestion(serviceId: string | null, weights: Record<string, number>): Promise<string> {
  const [row] = await queryRows<{ id: string }>(
    getDb(),
    sql`INSERT INTO matching_suggestions (service_id, suggested_weights, source)
        VALUES (${serviceId}, ${JSON.stringify(weights)}::jsonb, 'spec-037-test') RETURNING id`,
  );
  return row!.id;
}

const CUSTOM = { ...DEFAULT_MATCHING_WEIGHTS, rating: 20, reliability: 0 };
const SUGGESTED = { ...DEFAULT_MATCHING_WEIGHTS, rating: 15, reliability: 5 };
const SECOND_POLICY = { tiers: [{ minHoursBefore: null, maxHoursBefore: null, feePercent: 10 }] };

describe.skipIf(!dbReachable)('spec 037 AC-5 — audit with before/after on the owning write paths (integration)', () => {
  beforeEach(() => resetRateLimitState());

  afterAll(async () => {
    await getPool().end();
  });

  it('X-1: the helper records before/after only when provided; an existing caller is unchanged', async () => {
    const admin = await adminWithRole('support_admin');
    const base = {
      actorUserId: admin.userId,
      actorRoles: ['support_admin' as const],
      resource: 'fixture',
      action: 'fixture',
      approvalChain: [],
    };
    await recordAdminAuditEvent({ ...base, eventType: 'admin_rbac.spec037_without' });
    await recordAdminAuditEvent({ ...base, eventType: 'admin_rbac.spec037_with', before: null, after: { x: 1 } });

    const [without] = await eventsFor(admin.userId, 'admin_rbac.spec037_without');
    expect(without!.metadata).not.toHaveProperty('before');
    expect(without!.metadata).not.toHaveProperty('after');
    const [withValues] = await eventsFor(admin.userId, 'admin_rbac.spec037_with');
    expect(withValues!.metadata.before).toBeNull();
    expect(withValues!.metadata.after).toEqual({ x: 1 });
  });

  it('X-2: matching weight update is audited with before and after', async () => {
    const admin = await adminWithRole('operations_admin');
    const { serviceId } = await seedService();

    expect((await PATCH_WEIGHTS(patchWeights(admin, serviceId, { weights: CUSTOM, poolSize: 25 }))).status).toBe(200);
    expect((await PATCH_WEIGHTS(patchWeights(admin, serviceId, { poolSize: 30 }))).status).toBe(200);

    const events = await eventsFor(admin.userId, 'admin_rbac.matching_weights_updated');
    expect(events).toHaveLength(2);
    expect(events[0]!.metadata).toMatchObject({
      actorRoles: ['operations_admin'],
      resource: 'matching.config',
      action: 'configure',
      targetType: 'service',
      targetId: serviceId,
      reason: null,
      approvalChain: [],
      before: { weights: null, poolSize: null },
      after: { weights: CUSTOM, poolSize: 25 },
    });
    // The second write's `before` is the first write's `after`; untouched weights carry over.
    expect(events[1]!.metadata).toMatchObject({
      before: { weights: CUSTOM, poolSize: 25 },
      after: { weights: CUSTOM, poolSize: 30 },
    });
  });

  it('a rejected update records no event: 422 invalid weights, 409 stale version, 404 unknown service', async () => {
    const admin = await adminWithRole('operations_admin');
    const { serviceId } = await seedService();
    const version = await serviceVersion(serviceId);

    expect((await PATCH_WEIGHTS(patchWeights(admin, serviceId, { weights: { ...DEFAULT_MATCHING_WEIGHTS, rating: 999 } }))).status).toBe(422);
    expect((await PATCH_WEIGHTS(patchWeights(admin, serviceId, { poolSize: 10, expectedVersion: version + 5 }))).status).toBe(409);
    expect((await PATCH_WEIGHTS(patchWeights(admin, randomUUID(), { poolSize: 10 }))).status).toBe(404);

    expect(await eventsFor(admin.userId, 'admin_rbac.matching_weights_updated')).toEqual([]);
    expect(await serviceVersion(serviceId)).toBe(version); // and the write path itself is unchanged
  });

  it('X-3: service-scoped suggestion approval is audited with before and after', async () => {
    const admin = await adminWithRole('operations_admin');
    const { serviceId } = await seedService();
    const suggestionId = await insertSuggestion(serviceId, SUGGESTED);

    const res = await APPROVE_SUGGESTION(
      authenticatedRequest(`${BASE}/admin/matching/suggestions/${suggestionId}/approve`, admin.sessionId, admin.csrfToken),
    );
    expect(res.status).toBe(200);

    const events = await eventsFor(admin.userId, 'admin_rbac.matching_suggestion_approved');
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toMatchObject({
      actorRoles: ['operations_admin'],
      resource: 'matching.config',
      action: 'configure',
      targetType: 'service',
      targetId: serviceId,
      reason: null,
      before: { weights: null, poolSize: null },
      after: { weights: SUGGESTED, poolSize: null },
    });
  });

  it('a platform-wide suggestion (no service) writes no weights and records no new event', async () => {
    const admin = await adminWithRole('operations_admin');
    const suggestionId = await insertSuggestion(null, SUGGESTED);
    const res = await APPROVE_SUGGESTION(
      authenticatedRequest(`${BASE}/admin/matching/suggestions/${suggestionId}/approve`, admin.sessionId, admin.csrfToken),
    );
    expect(res.status).toBe(200);
    expect(await eventsFor(admin.userId, 'admin_rbac.matching_suggestion_approved')).toEqual([]);
  });

  it('X-4: policy publish is audited with before and after, the note as reason', async () => {
    const admin = await adminWithRole('operations_admin');
    const { categoryId } = await seedService();
    const publish = (config: unknown, note: string) =>
      PUBLISH_POLICY(
        authenticatedRequest(`${BASE}/admin/cancellation-policies`, admin.sessionId, admin.csrfToken, {
          body: { scope: 'category', scopeId: categoryId, config, note },
        }),
      );

    expect((await publish(PLATFORM_DEFAULT_CANCELLATION_CONFIG, 'first version')).status).toBe(201);
    expect((await publish(SECOND_POLICY, 'raise the fee')).status).toBe(201);

    const events = (await eventsFor(admin.userId, 'admin_rbac.cancellation_policy_published')).map((e) => e.metadata);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      resource: 'cancellation_policy',
      action: 'configure',
      reason: 'first version',
      before: null,
      after: PLATFORM_DEFAULT_CANCELLATION_CONFIG,
    });
    expect(events[1]).toMatchObject({ reason: 'raise the fee', before: PLATFORM_DEFAULT_CANCELLATION_CONFIG, after: SECOND_POLICY });
  });

  it('a rejected publish records no event', async () => {
    const admin = await adminWithRole('operations_admin');
    const { categoryId } = await seedService();
    const res = await PUBLISH_POLICY(
      authenticatedRequest(`${BASE}/admin/cancellation-policies`, admin.sessionId, admin.csrfToken, {
        body: { scope: 'category', scopeId: categoryId, config: { tiers: 'not-a-list' } },
      }),
    );
    expect(res.status).toBe(422);
    expect(await eventsFor(admin.userId, 'admin_rbac.cancellation_policy_published')).toEqual([]);
  });
});
