/**
 * Spec 030 §6 (AC-3 / DECIDED-5) — export and retention.
 *
 * The assertions that matter are the ABSENCES: a user's export must not become a way to learn who
 * reported them, nor a way to read the platform's internal triage of their conduct.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { generateExportPayload } from '@/lib/privacy/export';
import { createBlock } from './blocks';
import {
  isDatabaseReachable,
  resetSafetyIntegrationForTests,
  seedBareUser,
  seedSafetyReport,
  useSafetyIntegration,
} from './safety-test-support';

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('spec 030 privacy and retention (integration)', () => {
  beforeEach(() => {
    useSafetyIntegration();
  });

  afterAll(async () => {
    resetSafetyIntegrationForTests();
    await getPool().end();
  });

  describe('export', () => {
    it('includes the reports the user FILED, with their own words', async () => {
      const reporter = await seedBareUser();
      const target = await seedBareUser();
      await seedSafetyReport({
        reporterUserId: reporter,
        targetUserId: target,
        description: 'They refused to leave when I asked them to.',
      });

      const exported = await generateExportPayload(reporter);
      expect(exported.safetyReports).toHaveLength(1);
      expect(exported.safetyReports[0]!.description).toBe('They refused to leave when I asked them to.');
      expect(exported.safetyReports[0]!.status).toBe('submitted');
    });

    it('does NOT include a report filed ABOUT them — that would tell them they were reported', async () => {
      const reporter = await seedBareUser();
      const target = await seedBareUser();
      await seedSafetyReport({ reporterUserId: reporter, targetUserId: target });

      const exported = await generateExportPayload(target);
      expect(exported.safetyReports).toHaveLength(0);
    });

    it('never exports priority, the AI summary, an admin identity or a resolution reason', async () => {
      const reporter = await seedBareUser();
      const target = await seedBareUser();
      const id = await seedSafetyReport({ reporterUserId: reporter, targetUserId: target });
      await getDb().execute(
        sql`UPDATE safety_reports SET priority = 'critical', ai_summary = 'An AI paraphrase.' WHERE id = ${id}`,
      );

      const exported = await generateExportPayload(reporter);
      const row = exported.safetyReports[0]!;
      expect(Object.keys(row).sort()).toEqual(['category', 'createdAt', 'description', 'id', 'status']);
      expect(JSON.stringify(exported)).not.toContain('An AI paraphrase.');
    });

    it('never exports the target\'s user id — an export is a document that travels', async () => {
      const reporter = await seedBareUser();
      const target = await seedBareUser();
      await seedSafetyReport({ reporterUserId: reporter, targetUserId: target });

      const exported = await generateExportPayload(reporter);
      expect(JSON.stringify(exported.safetyReports)).not.toContain(target);
    });

    it('includes the blocks the user CREATED, but never who blocked THEM', async () => {
      const a = await seedBareUser();
      const b = await seedBareUser();
      await createBlock(a, b);

      const blockerExport = await generateExportPayload(a);
      expect(blockerExport.blocks).toHaveLength(1);

      // The blocked party learns nothing: their export shows no block at all.
      const blockedExport = await generateExportPayload(b);
      expect(blockedExport.blocks).toHaveLength(0);
    });
  });

  describe('DECIDED-5: retention', () => {
    it('keeps report rows through account deletion — the FK is `restrict`, so the sweep cannot remove them', async () => {
      const reporter = await seedBareUser();
      const target = await seedBareUser();
      const id = await seedSafetyReport({ reporterUserId: reporter, targetUserId: target });

      // The sweep's own move. A safety record must survive its reporter closing their account.
      await getDb().execute(sql`UPDATE users SET lifecycle_status = 'deleted' WHERE id = ${reporter}`);

      const [row] = await queryRows<{ id: string; description: string }>(
        getDb(),
        sql`SELECT id, description FROM safety_reports WHERE id = ${id}`,
      );
      expect(row!.id).toBe(id);
      // The description is NOT redacted: master §64 requires evidence preservation, and otherwise
      // anyone could erase a safety finding about a third party by deleting themselves.
      expect(row!.description).not.toBe('[redacted]');
    });

    it('cannot have its reporter hard-deleted while a report exists', async () => {
      const reporter = await seedBareUser();
      const target = await seedBareUser();
      await seedSafetyReport({ reporterUserId: reporter, targetUserId: target });

      await expect(getDb().execute(sql`DELETE FROM users WHERE id = ${reporter}`)).rejects.toThrow();
    });
  });
});
