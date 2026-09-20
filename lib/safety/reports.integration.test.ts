/**
 * Spec 030 §6 (AC-2, AC-3, AC-5) — creation, the lifecycle, audit, and the guarantees that hold
 * even against a direct database write.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { registerSafetyRestrictionGate, resetSafetyRestrictionGate } from './restriction-gate';
import {
  claimSafetyReport,
  createSafetyReport,
  escalateSafetyReport,
  getSafetyReportForAdmin,
  getSafetyReportForReporter,
  listSafetyQueue,
  resolveSafetyReport,
  setSafetyPriority,
  SAFETY_EVENT_TYPES,
} from './reports';
import { DEFAULT_SAFETY_PRIORITY } from './limits';
import {
  isDatabaseReachable,
  registerAdminWithPermission,
  seedPermission,
  reportRow,
  resetSafetyIntegrationForTests,
  safetyAuditCount,
  seedBareUser,
  seedSafetyReport,
  useSafetyIntegration,
  userLifecycleStatus,
  type TestAdmin,
} from './safety-test-support';

const dbReachable = await isDatabaseReachable();
const REASON = 'Reviewed the account history and spoke to both parties before closing this.';

/**
 * A Trust & Safety admin holding all three of this spec's permissions — and, deliberately, nothing
 * that could sanction anyone: there is no fourth permission to grant (DECIDED-3).
 */
async function safetyAdmin(): Promise<TestAdmin> {
  const admin = await registerAdminWithPermission('trust_safety_admin', 'safety_reports', 'read', 'low');
  await seedPermission('trust_safety_admin', 'safety_reports', 'escalate', 'medium');
  await seedPermission('trust_safety_admin', 'safety_reports', 'resolve', 'medium');
  return admin;
}

describe.skipIf(!dbReachable)('spec 030 safety reports (integration)', () => {
  beforeEach(() => {
    useSafetyIntegration();
  });

  afterAll(async () => {
    resetSafetyIntegrationForTests();
    await getPool().end();
  });

  describe('AC-2: creation', () => {
    it('creates a submitted report carrying reporter, target and category', async () => {
      const reporter = await seedBareUser();
      const target = await seedBareUser();

      const { report, replayed } = await createSafetyReport(
        reporter,
        { targetUserId: target, category: 'threat', description: 'They threatened me at the door.', bookingId: null },
        { key: 'k-1', fingerprint: 'f-1' },
      );

      expect(replayed).toBe(false);
      expect(report.status).toBe('submitted');
      expect(report.category).toBe('threat');

      const row = await reportRow(report.id);
      expect(row.reporter_user_id).toBe(reporter);
      expect(row.target_user_id).toBe(target);
    });

    it('DECIDED-1: creates every report at the same constant priority, whatever the category', async () => {
      const reporter = await seedBareUser();
      const created: string[] = [];
      for (const category of ['harassment', 'threat', 'property_damage'] as const) {
        const target = await seedBareUser();
        const { report } = await createSafetyReport(
          reporter,
          { targetUserId: target, category, description: 'A description long enough to pass.', bookingId: null },
          { key: `k-${category}`, fingerprint: 'f' },
        );
        created.push(report.id);
      }
      for (const id of created) {
        expect((await reportRow(id)).priority).toBe(DEFAULT_SAFETY_PRIORITY);
      }
    });

    it('replays an idempotent retry rather than creating a second report', async () => {
      const reporter = await seedBareUser();
      const target = await seedBareUser();
      const input = { targetUserId: target, category: 'harassment' as const, description: 'Same words twice over.', bookingId: null };

      const first = await createSafetyReport(reporter, input, { key: 'dup', fingerprint: 'f' });
      const second = await createSafetyReport(reporter, input, { key: 'dup', fingerprint: 'f' });

      expect(second.replayed).toBe(true);
      expect(second.report.id).toBe(first.report.id);
    });

    it('rejects reporting yourself, and the database forbids it independently', async () => {
      const reporter = await seedBareUser();
      await expect(
        createSafetyReport(
          reporter,
          { targetUserId: reporter, category: 'other', description: 'Reporting myself somehow.', bookingId: null },
          { key: 'self', fingerprint: 'f' },
        ),
      ).rejects.toMatchObject({ code: 'CANNOT_REPORT_SELF' });

      await expect(
        getDb().execute(
          sql`INSERT INTO safety_reports (reporter_user_id, target_user_id, category, description, idempotency_key, idempotency_fingerprint)
              VALUES (${reporter}, ${reporter}, 'other', 'Direct write bypassing the check.', 'k', 'f')`,
        ),
      ).rejects.toThrow();
    });
  });

  describe('AC-3: who may read what', () => {
    it('gives the reporter a restricted view with no moderation internals', async () => {
      const reporter = await seedBareUser();
      const target = await seedBareUser();
      const id = await seedSafetyReport({ reporterUserId: reporter, targetUserId: target });

      const dto = await getSafetyReportForReporter(reporter, id);
      expect(dto.id).toBe(id);
      expect(Object.keys(dto).sort()).toEqual(['category', 'createdAt', 'evidence', 'id', 'status']);
      expect(dto).not.toHaveProperty('priority');
      expect(dto).not.toHaveProperty('aiSummary');
      expect(dto).not.toHaveProperty('description');
    });

    it('gives the REPORTED user 404, never 403 — they are never told a report exists', async () => {
      const reporter = await seedBareUser();
      const target = await seedBareUser();
      const id = await seedSafetyReport({ reporterUserId: reporter, targetUserId: target });

      await expect(getSafetyReportForReporter(target, id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('audits an admin detail read before returning it', async () => {
      const admin = await safetyAdmin();
      const reporter = await seedBareUser();
      const target = await seedBareUser();
      const id = await seedSafetyReport({ reporterUserId: reporter, targetUserId: target });

      const before = await safetyAuditCount(SAFETY_EVENT_TYPES.reportRead, id);
      await getSafetyReportForAdmin(admin.userId, id, 'corr-1');
      expect(await safetyAuditCount(SAFETY_EVENT_TYPES.reportRead, id)).toBe(before + 1);
    });

    it('audits a queue read too', async () => {
      const admin = await safetyAdmin();
      const before = await safetyAuditCount(SAFETY_EVENT_TYPES.queueRead);
      await listSafetyQueue(admin.userId, { limit: 20, offset: 0 }, 'corr-2');
      expect(await safetyAuditCount(SAFETY_EVENT_TYPES.queueRead)).toBe(before + 1);
    });
  });

  describe('the lifecycle', () => {
    it('claims, escalates and resolves, auditing each step', async () => {
      const admin = await safetyAdmin();
      const reporter = await seedBareUser();
      const target = await seedBareUser();
      const id = await seedSafetyReport({ reporterUserId: reporter, targetUserId: target });

      const claimed = await claimSafetyReport({
        adminUserId: admin.userId, reportId: id, expectedStatus: 'submitted', reason: null, correlationId: 'c',
      });
      expect(claimed.status).toBe('under_review');

      const escalated = await escalateSafetyReport({
        adminUserId: admin.userId, reportId: id, expectedStatus: 'under_review', reason: REASON, correlationId: 'c',
      });
      expect(escalated.status).toBe('escalated');
      expect(escalated.escalatedAt).not.toBeNull();

      const resolved = await resolveSafetyReport({
        adminUserId: admin.userId, reportId: id, expectedStatus: 'escalated', reason: REASON, correlationId: 'c',
      });
      expect(resolved.status).toBe('resolved');
      expect(resolved.resolutionReason).toBe(REASON);

      expect(await safetyAuditCount(SAFETY_EVENT_TYPES.claimed, id)).toBe(1);
      expect(await safetyAuditCount(SAFETY_EVENT_TYPES.escalated, id)).toBe(1);
      expect(await safetyAuditCount(SAFETY_EVENT_TYPES.resolved, id)).toBe(1);
    });

    it('rejects a stale expectedStatus with 409 so two admins cannot overwrite each other', async () => {
      const admin = await safetyAdmin();
      const reporter = await seedBareUser();
      const target = await seedBareUser();
      const id = await seedSafetyReport({ reporterUserId: reporter, targetUserId: target });

      await claimSafetyReport({
        adminUserId: admin.userId, reportId: id, expectedStatus: 'submitted', reason: null, correlationId: 'c',
      });

      // A second admin still holding the old view.
      await expect(
        claimSafetyReport({
          adminUserId: admin.userId, reportId: id, expectedStatus: 'submitted', reason: null, correlationId: 'c',
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT', details: { currentStatus: 'under_review' } });
    });

    it('DECIDED-4: refuses to move anything out of resolved', async () => {
      const admin = await safetyAdmin();
      const reporter = await seedBareUser();
      const target = await seedBareUser();
      const id = await seedSafetyReport({ reporterUserId: reporter, targetUserId: target });

      await resolveSafetyReport({
        adminUserId: admin.userId, reportId: id, expectedStatus: 'submitted', reason: REASON, correlationId: 'c',
      });

      await expect(
        escalateSafetyReport({
          adminUserId: admin.userId, reportId: id, expectedStatus: 'resolved', reason: REASON, correlationId: 'c',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_SAFETY_TRANSITION' });
    });

    it('AC-3: a resolution without a reason and a named admin is unrepresentable at the database', async () => {
      const reporter = await seedBareUser();
      const target = await seedBareUser();
      const id = await seedSafetyReport({ reporterUserId: reporter, targetUserId: target });

      // The direct write the application path can never produce.
      await expect(
        getDb().execute(sql`UPDATE safety_reports SET status = 'resolved' WHERE id = ${id}`),
      ).rejects.toThrow();
    });
  });

  describe('DECIDED-1: priority is human-set only', () => {
    it('changes priority and audits both values', async () => {
      const admin = await safetyAdmin();
      const reporter = await seedBareUser();
      const target = await seedBareUser();
      const id = await seedSafetyReport({ reporterUserId: reporter, targetUserId: target });

      const updated = await setSafetyPriority({
        adminUserId: admin.userId, reportId: id, priority: 'critical', expectedStatus: 'submitted', correlationId: 'c',
      });
      expect(updated.priority).toBe('critical');
      expect(await safetyAuditCount(SAFETY_EVENT_TYPES.priorityChanged, id)).toBe(1);
    });
  });

  describe('AC-5 / DECIDED-3: restrictions are spec 038\'s', () => {
    it('refuses a restriction request when the gate is unregistered, and leaves the report OPEN', async () => {
      resetSafetyRestrictionGate();
      const admin = await safetyAdmin();
      const reporter = await seedBareUser();
      const target = await seedBareUser();
      const id = await seedSafetyReport({ reporterUserId: reporter, targetUserId: target });

      await expect(
        resolveSafetyReport({
          adminUserId: admin.userId, reportId: id, expectedStatus: 'submitted', reason: REASON,
          correlationId: 'c', requestRestriction: true,
        }),
      ).rejects.toMatchObject({ code: 'RESTRICTION_UNAVAILABLE' });

      // The report did NOT close, and the account was not touched.
      expect((await reportRow(id)).status).toBe('submitted');
      expect(await userLifecycleStatus(target)).toBe('active');
    });

    it('hands a registered gate the report, target, admin and reason, and records the request', async () => {
      const admin = await safetyAdmin();
      const reporter = await seedBareUser();
      const target = await seedBareUser();
      const id = await seedSafetyReport({ reporterUserId: reporter, targetUserId: target });

      const seen: unknown[] = [];
      registerSafetyRestrictionGate(async (req) => {
        seen.push(req);
        return { moderationActionId: '22222222-2222-2222-2222-222222222222' };
      });

      const resolved = await resolveSafetyReport({
        adminUserId: admin.userId, reportId: id, expectedStatus: 'submitted', reason: REASON,
        correlationId: 'corr-9', requestRestriction: true,
      });

      expect(seen).toEqual([
        {
          safetyReportId: id,
          targetUserId: target,
          requestedByAdminUserId: admin.userId,
          reason: REASON,
          correlationId: 'corr-9',
        },
      ]);
      expect(resolved.restrictionRequestedAt).not.toBeNull();
      expect(await safetyAuditCount(SAFETY_EVENT_TYPES.restrictionRequested, id)).toBe(1);

      // EVEN WITH A GATE REGISTERED, spec 030 changed no account state: spec 038 owns that.
      expect(await userLifecycleStatus(target)).toBe('active');
      resetSafetyRestrictionGate();
    });

    it('resolves normally when no restriction is requested', async () => {
      const admin = await safetyAdmin();
      const reporter = await seedBareUser();
      const target = await seedBareUser();
      const id = await seedSafetyReport({ reporterUserId: reporter, targetUserId: target });

      const resolved = await resolveSafetyReport({
        adminUserId: admin.userId, reportId: id, expectedStatus: 'submitted', reason: REASON, correlationId: 'c',
      });
      expect(resolved.status).toBe('resolved');
      expect(resolved.restrictionRequestedAt).toBeNull();
    });
  });
});
