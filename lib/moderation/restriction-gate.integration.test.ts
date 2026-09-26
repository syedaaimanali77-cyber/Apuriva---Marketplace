import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { resolveSafetyReport } from '@/lib/safety';
import { requestRestriction } from '@/lib/safety/restriction-gate';
import {
  adminWithRole,
  isDatabaseReachable,
  resetModerationForTests,
  seedCustomer,
  useModerationIntegration,
  userStatus,
} from './moderation-test-support';

const dbReachable = await isDatabaseReachable();

afterAll(async () => {
  await getPool().end();
});

async function seedReport(reporterUserId: string, targetUserId: string): Promise<string> {
  const [row] = await queryRows<{ id: string }>(
    getDb(),
    sql`INSERT INTO safety_reports (reporter_user_id, target_user_id, category, description, idempotency_key, idempotency_fingerprint)
        VALUES (${reporterUserId}, ${targetUserId}, 'threat', 'They threatened me when I asked them to leave.', ${randomUUID()}, 'fp')
        RETURNING id`,
  );
  return row!.id;
}

/** Spec 038 §3.16 / AC-8 — spec 030's `SafetyRestrictionGate`, made real. Spec 030 stays the caller. */
describe.skipIf(!dbReachable)('spec 030 restriction gate (spec 038 AC-8)', { timeout: 120_000 }, () => {
  beforeEach(() => useModerationIntegration());
  afterEach(() => resetModerationForTests());

  it('resolving a report with requestRestriction restricts the account and stores the action id', async () => {
    const admin = await adminWithRole();
    const [reporter, target] = [await seedCustomer(), await seedCustomer()];
    const reportId = await seedReport(reporter.userId, target.userId);

    await resolveSafetyReport({
      adminUserId: admin.userId,
      reportId,
      expectedStatus: 'submitted',
      reason: 'Credible threat; restricting pending review.',
      correlationId: null,
      requestRestriction: true,
    });

    const [report] = await queryRows<{ status: string; restriction_moderation_action_id: string }>(
      getDb(),
      sql`SELECT status, restriction_moderation_action_id FROM safety_reports WHERE id = ${reportId}`,
    );
    const [action] = await queryRows<{ id: string; action_type: string; scope: string; status: string }>(
      getDb(),
      sql`SELECT id, action_type, scope, status FROM moderation_actions WHERE origin_safety_report_id = ${reportId}`,
    );
    expect(report!.status).toBe('resolved');
    expect(action).toMatchObject({ action_type: 'restriction', scope: 'account', status: 'active' });
    expect(report!.restriction_moderation_action_id).toBe(action!.id);
    expect(await userStatus(target.userId)).toBe('restricted');
  });

  it('a retried request for the same report returns the same action — never a second restriction', async () => {
    const admin = await adminWithRole();
    const [reporter, target] = [await seedCustomer(), await seedCustomer()];
    const reportId = await seedReport(reporter.userId, target.userId);
    const request = { safetyReportId: reportId, targetUserId: target.userId, requestedByAdminUserId: admin.userId, reason: 'Threat.', correlationId: null };
    const first = await requestRestriction(request);
    const second = await requestRestriction(request);
    expect(second.moderationActionId).toBe(first.moderationActionId);
    const [row] = await queryRows<{ n: number }>(getDb(), sql`SELECT count(*)::int AS n FROM moderation_actions WHERE origin_safety_report_id = ${reportId}`);
    expect(row!.n).toBe(1);
  });

  it('an admin without moderation/restrict is refused 403 and the report stays open', async () => {
    const support = await adminWithRole('operations_admin');
    const [reporter, target] = [await seedCustomer(), await seedCustomer()];
    const reportId = await seedReport(reporter.userId, target.userId);
    await expect(
      requestRestriction({ safetyReportId: reportId, targetUserId: target.userId, requestedByAdminUserId: support.userId, reason: 'x', correlationId: null }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const [report] = await queryRows<{ status: string }>(getDb(), sql`SELECT status FROM safety_reports WHERE id = ${reportId}`);
    expect(report!.status).toBe('submitted');
    expect(await userStatus(target.userId)).toBe('active');
  });

  it('an empty reason is a 400, not a restriction', async () => {
    const admin = await adminWithRole();
    const [reporter, target] = [await seedCustomer(), await seedCustomer()];
    const reportId = await seedReport(reporter.userId, target.userId);
    await expect(
      requestRestriction({ safetyReportId: reportId, targetUserId: target.userId, requestedByAdminUserId: admin.userId, reason: '', correlationId: null }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
