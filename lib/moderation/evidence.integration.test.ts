import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { getFileContextPolicy } from '@/lib/files/contexts/registry';
import type { FileAssetRow } from '@/lib/files/assets';
import { getModerationActionDetail } from './read';
import { moderationEvidencePolicy } from './evidence-policy';
import {
  adminWithRole,
  auditEvents,
  initiate,
  isDatabaseReachable,
  resetModerationForTests,
  seedCustomer,
  useModerationIntegration,
} from './moderation-test-support';

const dbReachable = await isDatabaseReachable();

afterAll(async () => {
  await getPool().end();
});

/** A ready, clean evidence row, as spec 027's finalize+scan would leave it. */
async function seedEvidence(uploaderUserId: string, actionId: string): Promise<FileAssetRow> {
  const [row] = await queryRows<FileAssetRow>(
    getDb(),
    sql`INSERT INTO file_assets (uploaded_by_user_id, kind, visibility, status, storage_key, mime_type, size_bytes, file_name,
                                 context_type, context_id, scan_outcome, ready_at)
        VALUES (${uploaderUserId}, 'image', 'private', 'ready', ${`${uploaderUserId}/${randomUUID()}`}, 'image/png', 10, 'proof.png',
                'moderation_evidence', ${actionId}, 'clean', clock_timestamp())
        RETURNING *`,
  );
  return row!;
}

/** Spec 038 §3.8 / AC-9 — private, permissioned, audited, legally held. */
describe.skipIf(!dbReachable)('moderation evidence (spec 038 AC-9)', { timeout: 120_000 }, () => {
  beforeEach(() => useModerationIntegration());
  afterEach(async () => {
    resetModerationForTests();
    // Leave no `moderation_evidence` rows in the shared test database: an older migration's down
    // file (e.g. spec 032's 0029 rollback test) restores a context vocabulary without this value,
    // and rows left behind here would make that unrelated suite's constraint re-add fail.
    await getDb().execute(sql`DELETE FROM file_assets WHERE context_type = 'moderation_evidence'`);
  });

  it('the context is registered, never public-eligible, capped at 10', () => {
    const policy = getFileContextPolicy('moderation_evidence');
    expect(policy).toBe(moderationEvidencePolicy);
    expect(policy!.publicEligible).toBe(false);
    expect(policy!.maxPerContext).toBe(10);
  });

  it('upload: only an admin holding the action type permission, only while pending or active', async () => {
    const [ts, ops] = [await adminWithRole(), await adminWithRole('operations_admin')];
    const target = await seedCustomer();
    const { action } = await initiate(ts, { actionType: 'suspension', scope: 'account', targetUserId: target.userId });
    const input = (userId: string) => ({ userId, activeMode: 'customer' as const, contextId: action.id });
    expect(await moderationEvidencePolicy.canUpload(input(ts.userId))).toBe(true);
    expect(await moderationEvidencePolicy.canUpload(input(ops.userId))).toBe(false);
    expect(await moderationEvidencePolicy.canUpload(input(target.userId))).toBe(false);
    expect(await moderationEvidencePolicy.canUpload({ ...input(ts.userId), contextId: null })).toBe(false);
  });

  it('read: admins with moderation/read only, audited BEFORE disclosure; the target never', async () => {
    const [ts, ops, finance] = [await adminWithRole(), await adminWithRole('operations_admin'), await adminWithRole('finance_admin')];
    const target = await seedCustomer();
    const { action } = await initiate(ts, { actionType: 'restriction', scope: 'account', targetUserId: target.userId });
    const asset = await seedEvidence(ts.userId, action.id);

    expect(await moderationEvidencePolicy.canRead({ userId: target.userId, activeMode: 'customer', asset })).toBe(false);
    expect(await moderationEvidencePolicy.canRead({ userId: finance.userId, activeMode: 'customer', asset })).toBe(false);
    expect((await auditEvents('moderation.evidence_read', action.id)).length).toBe(0);

    expect(await moderationEvidencePolicy.canRead({ userId: ops.userId, activeMode: 'customer', asset })).toBe(true);
    const events = await auditEvents('moderation.evidence_read', action.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata.after).toMatchObject({ fileAssetId: asset.id });
  });

  it('the detail read lists the evidence ids and places them under legal_hold', async () => {
    const ts = await adminWithRole();
    const target = await seedCustomer();
    const { action } = await initiate(ts, { actionType: 'warning', scope: 'account', targetUserId: target.userId });
    const asset = await seedEvidence(ts.userId, action.id);
    const detail = await getModerationActionDetail(ts.userId, action.id, null);
    expect(detail.evidenceFileAssetIds).toEqual([asset.id]);
    const [row] = await queryRows<{ legal_hold: boolean; visibility: string }>(getDb(), sql`SELECT legal_hold, visibility FROM file_assets WHERE id = ${asset.id}`);
    expect(row).toEqual({ legal_hold: true, visibility: 'private' });
  });
});
