/**
 * Spec 030 §6 (AC-3) — evidence authorization, and the `legal_hold` stamp that is the whole of
 * retention (DECIDED-5).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { getFileContextPolicy } from '@/lib/files/contexts/registry';
import { safetyEvidencePolicy } from './evidence-policy';
import { holdEvidenceFor, listEvidenceFor } from './evidence';
import { resolveSafetyReport, SAFETY_EVENT_TYPES } from './reports';
import { MAX_SAFETY_EVIDENCE, SAFETY_EVIDENCE_CONTEXT } from './limits';
import {
  isDatabaseReachable,
  registerAdminWithPermission,
  resetSafetyIntegrationForTests,
  safetyAuditCount,
  seedBareUser,
  seedPermission,
  seedSafetyReport,
  useSafetyIntegration,
} from './safety-test-support';
import type { FileAssetRow } from '@/lib/files/assets';

const dbReachable = await isDatabaseReachable();

/**
 * Spec 027 pairs `status = 'ready'` with `ready_at` (`file_assets_ready_pairing_ck`) and requires a
 * clean scan for `ready` — so a fixture must satisfy that spec's own invariants rather than insert
 * a shape the application could never produce.
 */
async function seedEvidence(uploaderUserId: string, reportId: string, status = 'ready'): Promise<FileAssetRow> {
  const ready = status === 'ready';
  const [row] = await queryRows<FileAssetRow>(
    getDb(),
    sql`INSERT INTO file_assets
          (uploaded_by_user_id, kind, visibility, status, context_type, context_id,
           storage_key, mime_type, size_bytes, file_name, scan_outcome, ready_at)
        VALUES (${uploaderUserId}, 'image', 'private', ${status}, ${SAFETY_EVIDENCE_CONTEXT}, ${reportId},
                ${`safety/${reportId}/${status}-${Math.random().toString(36).slice(2)}`},
                'image/png', 1024, 'evidence.png',
                ${ready ? 'clean' : null},
                ${ready ? sql`clock_timestamp()` : sql`null`})
        RETURNING *`,
  );
  return row!;
}

describe.skipIf(!dbReachable)('spec 030 safety evidence (AC-3, integration)', () => {
  beforeEach(() => {
    useSafetyIntegration();
  });

  afterAll(async () => {
    resetSafetyIntegrationForTests();
    await getPool().end();
  });

  describe('the context policy', () => {
    it('is registered by registerSafetyIntegration, lifting spec 027 out of FILE_CONTEXT_NOT_AVAILABLE', () => {
      expect(getFileContextPolicy(SAFETY_EVIDENCE_CONTEXT)).toBe(safetyEvidencePolicy);
    });

    it('is never public-eligible, allows the three kinds a reporter might have, and caps at ten', () => {
      expect(safetyEvidencePolicy.publicEligible).toBe(false);
      expect([...safetyEvidencePolicy.allowedKinds].sort()).toEqual(['document', 'image', 'video']);
      expect(safetyEvidencePolicy.maxPerContext).toBe(MAX_SAFETY_EVIDENCE);
    });
  });

  describe('canUpload', () => {
    it('allows the reporter while the report is open', async () => {
      const reporter = await seedBareUser();
      const target = await seedBareUser();
      const id = await seedSafetyReport({ reporterUserId: reporter, targetUserId: target });

      expect(await safetyEvidencePolicy.canUpload({ userId: reporter, activeMode: 'customer', contextId: id })).toBe(true);
      // Either mode: a safety concern is not role-scoped.
      expect(await safetyEvidencePolicy.canUpload({ userId: reporter, activeMode: 'provider', contextId: id })).toBe(true);
    });

    it('refuses the REPORTED user and a stranger', async () => {
      const reporter = await seedBareUser();
      const target = await seedBareUser();
      const stranger = await seedBareUser();
      const id = await seedSafetyReport({ reporterUserId: reporter, targetUserId: target });

      expect(await safetyEvidencePolicy.canUpload({ userId: target, activeMode: 'customer', contextId: id })).toBe(false);
      expect(await safetyEvidencePolicy.canUpload({ userId: stranger, activeMode: 'customer', contextId: id })).toBe(false);
    });

    it('refuses once the report is resolved — evidence cannot be bolted onto a closed case', async () => {
      const admin = await registerAdminWithPermission('trust_safety_admin', 'safety_reports', 'resolve', 'medium');
      await seedPermission('trust_safety_admin', 'safety_reports', 'read', 'low');
      const reporter = await seedBareUser();
      const target = await seedBareUser();
      const id = await seedSafetyReport({ reporterUserId: reporter, targetUserId: target });

      await resolveSafetyReport({
        adminUserId: admin.userId, reportId: id, expectedStatus: 'submitted',
        reason: 'Closed after speaking to both parties about it.', correlationId: 'c',
      });

      expect(await safetyEvidencePolicy.canUpload({ userId: reporter, activeMode: 'customer', contextId: id })).toBe(false);
    });

    it('refuses a missing or malformed context id rather than reaching the database', async () => {
      const reporter = await seedBareUser();
      expect(await safetyEvidencePolicy.canUpload({ userId: reporter, activeMode: 'customer', contextId: null })).toBe(false);
      expect(await safetyEvidencePolicy.canUpload({ userId: reporter, activeMode: 'customer', contextId: 'nope' })).toBe(false);
    });
  });

  describe('canRead', () => {
    it('lets the reporter re-read their own attachment', async () => {
      const reporter = await seedBareUser();
      const target = await seedBareUser();
      const id = await seedSafetyReport({ reporterUserId: reporter, targetUserId: target });
      const asset = await seedEvidence(reporter, id);

      expect(await safetyEvidencePolicy.canRead({ userId: reporter, activeMode: 'customer', asset })).toBe(true);
    });

    it('refuses the REPORTED user and a stranger outright', async () => {
      const reporter = await seedBareUser();
      const target = await seedBareUser();
      const stranger = await seedBareUser();
      const id = await seedSafetyReport({ reporterUserId: reporter, targetUserId: target });
      const asset = await seedEvidence(reporter, id);

      expect(await safetyEvidencePolicy.canRead({ userId: target, activeMode: 'customer', asset })).toBe(false);
      expect(await safetyEvidencePolicy.canRead({ userId: stranger, activeMode: 'customer', asset })).toBe(false);
    });

    it('lets a Trust & Safety admin read it, and AUDITS the read before disclosing', async () => {
      const admin = await registerAdminWithPermission('trust_safety_admin', 'safety_reports', 'read', 'low');
      const reporter = await seedBareUser();
      const target = await seedBareUser();
      const id = await seedSafetyReport({ reporterUserId: reporter, targetUserId: target });
      const asset = await seedEvidence(reporter, id);

      const before = await safetyAuditCount(SAFETY_EVENT_TYPES.evidenceRead, id);
      expect(await safetyEvidencePolicy.canRead({ userId: admin.userId, activeMode: 'customer', asset, correlationId: 'c' })).toBe(true);
      expect(await safetyAuditCount(SAFETY_EVENT_TYPES.evidenceRead, id)).toBe(before + 1);
    });

    it('refuses an admin WITHOUT the read permission, and writes no audit event for them', async () => {
      const admin = await registerAdminWithPermission('finance_admin', 'payouts', 'read', 'low');
      const reporter = await seedBareUser();
      const target = await seedBareUser();
      const id = await seedSafetyReport({ reporterUserId: reporter, targetUserId: target });
      const asset = await seedEvidence(reporter, id);

      const before = await safetyAuditCount(SAFETY_EVENT_TYPES.evidenceRead, id);
      expect(await safetyEvidencePolicy.canRead({ userId: admin.userId, activeMode: 'customer', asset })).toBe(false);
      expect(await safetyAuditCount(SAFETY_EVENT_TYPES.evidenceRead, id)).toBe(before);
    });
  });

  describe('DECIDED-5: retention uses the EXISTING legal_hold mechanism', () => {
    it('stamps legal_hold, which spec 027 purge already honours — no new mechanism', async () => {
      const reporter = await seedBareUser();
      const target = await seedBareUser();
      const id = await seedSafetyReport({ reporterUserId: reporter, targetUserId: target });
      const asset = await seedEvidence(reporter, id);
      expect(asset.legal_hold).toBe(false);

      await holdEvidenceFor(id);

      const [row] = await queryRows<{ legal_hold: boolean }>(
        getDb(),
        sql`SELECT legal_hold FROM file_assets WHERE id = ${asset.id}`,
      );
      expect(row!.legal_hold).toBe(true);
    });

    it('is idempotent', async () => {
      const reporter = await seedBareUser();
      const target = await seedBareUser();
      const id = await seedSafetyReport({ reporterUserId: reporter, targetUserId: target });
      await seedEvidence(reporter, id);
      await holdEvidenceFor(id);
      await expect(holdEvidenceFor(id)).resolves.toBeUndefined();
    });
  });

  describe('listing', () => {
    it('returns only ready, live assets — a scanning or deleted one is never shown', async () => {
      const reporter = await seedBareUser();
      const target = await seedBareUser();
      const id = await seedSafetyReport({ reporterUserId: reporter, targetUserId: target });

      const ready = await seedEvidence(reporter, id, 'ready');
      await seedEvidence(reporter, id, 'scanning');
      const deleted = await seedEvidence(reporter, id, 'ready');
      await getDb().execute(sql`UPDATE file_assets SET deleted_at = clock_timestamp() WHERE id = ${deleted.id}`);

      const listed = await listEvidenceFor(id);
      expect(listed.map((a) => a.id)).toEqual([ready.id]);
    });
  });
});
