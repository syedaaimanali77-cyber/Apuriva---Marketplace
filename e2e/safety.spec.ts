/**
 * Spec 030 §6 "E2E" — the whole journey, through the real routes:
 *
 *   block a user → file a safety report → attach evidence → Trust & Safety claims, escalates,
 *   and resolves it.
 *
 * Vitest, not Playwright: this repository has no browser runner, and `e2e/*.spec.ts` is the
 * filename convention spec 005 §6 established for end-to-end coverage.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { POST as CREATE_BLOCK } from '@/app/api/v1/blocks/route';
import { POST as CREATE_REPORT } from '@/app/api/v1/safety-reports/route';
import { GET as READ_REPORT } from '@/app/api/v1/safety-reports/[id]/route';
import { GET as ADMIN_QUEUE } from '@/app/api/v1/admin/safety-reports/route';
import { GET as ADMIN_DETAIL } from '@/app/api/v1/admin/safety-reports/[id]/route';
import { POST as CLAIM } from '@/app/api/v1/admin/safety-reports/[id]/claim/route';
import { POST as ESCALATE } from '@/app/api/v1/admin/safety-reports/[id]/escalate/route';
import { POST as RESOLVE } from '@/app/api/v1/admin/safety-reports/[id]/resolve/route';
import { checkConversationBlock } from '@/lib/messaging/block-gate';
import { holdEvidenceFor, listEvidenceFor } from '@/lib/safety';
import { SAFETY_EVIDENCE_CONTEXT } from '@/lib/safety/limits';
import {
  BASE,
  isDatabaseReachable,
  registerAdminWithPermission,
  registerCustomer,
  resetSafetyIntegrationForTests,
  seedBareUser,
  seedPermission,
  sessionGet,
  sessionMutate,
  useSafetyIntegration,
} from '@/lib/safety/safety-test-support';

const dbReachable = await isDatabaseReachable();
const REASON = 'Spoke to both parties, reviewed the evidence, and recorded the outcome here.';

function withKey(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.set('idempotency-key', crypto.randomUUID());
  return new Request(request, { headers });
}

const json = async (response: Response) => (await response.json()) as Record<string, any>;

describe.skipIf(!dbReachable)('spec 030 end to end', () => {
  beforeEach(() => {
    useSafetyIntegration();
    resetRateLimitState();
  });

  afterAll(async () => {
    resetSafetyIntegrationForTests();
    await getPool().end();
  });

  it('runs the full journey, and enforces nothing against the reported account along the way', async () => {
    const reporter = await registerCustomer();
    const offender = await seedBareUser();

    // 1. The reporter blocks the other person. Messaging is severed in both directions at once.
    const blockResponse = await CREATE_BLOCK(
      withKey(sessionMutate(`${BASE}/blocks`, reporter, 'POST', { targetUserId: offender })),
    );
    expect(blockResponse.status).toBe(201);
    expect((await checkConversationBlock(getDb(), reporter.userId, offender, 'c')).blocked).toBe(true);
    expect((await checkConversationBlock(getDb(), offender, reporter.userId, 'c')).blocked).toBe(true);

    // 2. They file a safety report.
    const created = await json(
      await CREATE_REPORT(
        withKey(
          sessionMutate(`${BASE}/safety-reports`, reporter, 'POST', {
            targetUserId: offender,
            category: 'threat',
            description: 'They threatened me when I asked them to leave the property.',
          }),
        ),
      ),
    );
    const reportId = created.data.id as string;
    expect(created.data.status).toBe('submitted');

    // 3. Evidence is attached to the report and placed under legal hold (DECIDED-5).
    await getDb().execute(
      sql`INSERT INTO file_assets
            (uploaded_by_user_id, kind, visibility, status, context_type, context_id,
             storage_key, mime_type, size_bytes, file_name, scan_outcome, ready_at)
          VALUES (${reporter.userId}, 'image', 'private', 'ready', ${SAFETY_EVIDENCE_CONTEXT}, ${reportId},
                  ${`safety/${reportId}/shot.png`}, 'image/png', 2048, 'shot.png', 'clean', clock_timestamp())`,
    );
    await holdEvidenceFor(reportId);
    expect(await listEvidenceFor(reportId)).toHaveLength(1);

    // 4. Trust & Safety works the queue.
    const admin = await registerAdminWithPermission('trust_safety_admin', 'safety_reports', 'read', 'low');
    await seedPermission('trust_safety_admin', 'safety_reports', 'escalate', 'medium');
    await seedPermission('trust_safety_admin', 'safety_reports', 'resolve', 'medium');

    // The queue is reachable. Deliberately NOT asserting this report appears on page one: the
    // queue is FIFO among equal priorities and the shared test database accumulates reports from
    // every other suite, so its position is not this test's business. The detail route below is
    // the deterministic proof that an admin can reach this specific report.
    const queue = await ADMIN_QUEUE(sessionGet(`${BASE}/admin/safety-reports`, admin));
    expect(queue.status).toBe(200);

    const detail = await json(
      await ADMIN_DETAIL(sessionGet(`${BASE}/admin/safety-reports/${reportId}`, admin)),
    );
    expect(detail.data.id).toBe(reportId);
    expect(detail.data.description).toContain('threatened me');

    const claimed = await json(
      await CLAIM(
        sessionMutate(`${BASE}/admin/safety-reports/${reportId}/claim`, admin, 'POST', { expectedStatus: 'submitted' }),
      ),
    );
    expect(claimed.data.status).toBe('under_review');

    const escalated = await json(
      await ESCALATE(
        sessionMutate(`${BASE}/admin/safety-reports/${reportId}/escalate`, admin, 'POST', {
          expectedStatus: 'under_review',
          reason: REASON,
        }),
      ),
    );
    expect(escalated.data.status).toBe('escalated');

    const resolved = await json(
      await RESOLVE(
        sessionMutate(`${BASE}/admin/safety-reports/${reportId}/resolve`, admin, 'POST', {
          expectedStatus: 'escalated',
          reason: REASON,
        }),
      ),
    );
    expect(resolved.data.status).toBe('resolved');
    expect(resolved.data.resolutionReason).toBe(REASON);

    // 5. The reporter sees only that it closed — never the priority, reason or admin identity.
    const reporterView = await json(await READ_REPORT(sessionGet(`${BASE}/safety-reports/${reportId}`, reporter)));
    expect(reporterView.data.status).toBe('resolved');
    expect(reporterView.data).not.toHaveProperty('resolutionReason');
    expect(reporterView.data).not.toHaveProperty('priority');

    // 6. THE WHOLE POINT OF DECIDED-3: after a complete safety journey ending in a resolution, the
    //    reported account is untouched. Spec 030 enforced nothing, because it cannot.
    const [account] = await queryRows<{ lifecycle_status: string }>(
      getDb(),
      sql`SELECT lifecycle_status FROM users WHERE id = ${offender}`,
    );
    expect(account!.lifecycle_status).toBe('active');

    // 7. Evidence survives under legal hold, ready for spec 038 or a later investigation.
    const [asset] = await queryRows<{ legal_hold: boolean }>(
      getDb(),
      sql`SELECT legal_hold FROM file_assets WHERE context_id = ${reportId}`,
    );
    expect(asset!.legal_hold).toBe(true);
  });
});
