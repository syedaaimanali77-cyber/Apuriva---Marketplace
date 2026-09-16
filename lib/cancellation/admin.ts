/**
 * Spec 023 §3 "Configuration ownership" — the minimum admin data/API seam.
 *
 * Spec 023 owns the policy DATA, its validation and its API; spec 041 owns the later admin
 * configuration UI. That split is what keeps the core system executable today — the migration seeds
 * a working platform default and these two functions are all an admin needs to read and publish —
 * and it removes the circular dependency the draft had on a future UI spec.
 *
 * Publishing is APPEND-ONLY. A version is never edited: publishing closes the previous version's
 * interval and inserts a new one, which is precisely what makes an existing booking's snapshot
 * unalterable (AC-1). `policy_versions_immutable_trg` enforces that at the database too.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { recordAdminAuditEvent } from '@/lib/admin-rbac/audit';
import { adminForbiddenError } from '@/lib/admin-rbac/errors';
import { getAdminRoleNames, resolvePermission } from '@/lib/admin-rbac/permissions';
import { pgError, queryRows } from '@/lib/offers/db';
import type {
  AdminCancellationPolicyDto,
  AdminCancellationPolicyVersionDto,
  CancellationPolicyConfig,
  PolicyScope,
  PublishCancellationPolicyRequest,
} from '@/lib/types/cancellation';
import { policyConfigInvalidError, policyVersionOverlapError } from './errors';
import { validateCancellationPolicyConfig } from './policy-config';

export const CANCELLATION_POLICY_RESOURCE = 'cancellation_policy';
export const CANCELLATION_POLICY_READ_ACTION = 'read';
export const CANCELLATION_POLICY_CONFIGURE_ACTION = 'configure';

/**
 * Spec 009's existing permission model, unchanged. Both actions are `low`/`medium`, so they resolve
 * through that spec's plain permit branch — no `AdminAction`, no second approval framework.
 */
async function requireCancellationPolicyPermission(adminUserId: string, action: string): Promise<void> {
  const decision = await resolvePermission(adminUserId, CANCELLATION_POLICY_RESOURCE, action);
  if (!decision.allowed) throw adminForbiddenError();
}

export async function requireCancellationPolicyReadPermission(adminUserId: string): Promise<void> {
  await requireCancellationPolicyPermission(adminUserId, CANCELLATION_POLICY_READ_ACTION);
}

export async function requireCancellationPolicyConfigurePermission(adminUserId: string): Promise<void> {
  await requireCancellationPolicyPermission(adminUserId, CANCELLATION_POLICY_CONFIGURE_ACTION);
}

interface PolicyRow {
  id: string;
  type: 'cancellation';
  scope: PolicyScope;
  scope_id: string | null;
  is_active: boolean;
}

interface VersionRow {
  id: string;
  policy_id: string;
  effective_from: Date;
  effective_to: Date | null;
  config: unknown;
  note: string | null;
  created_at: Date;
}

function toVersionDto(row: VersionRow): AdminCancellationPolicyVersionDto {
  return {
    id: row.id,
    effectiveFrom: new Date(row.effective_from).toISOString(),
    effectiveTo: row.effective_to ? new Date(row.effective_to).toISOString() : null,
    config: row.config as CancellationPolicyConfig,
    note: row.note,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** `GET /admin/cancellation-policies` — every scope with its current and historical versions. */
export async function listCancellationPolicies(): Promise<AdminCancellationPolicyDto[]> {
  const db = getDb();
  const policies = await queryRows<PolicyRow>(
    db,
    sql`SELECT id, type, scope, scope_id, is_active FROM policies WHERE type = 'cancellation'
         ORDER BY CASE scope WHEN 'service' THEN 1 WHEN 'category' THEN 2 ELSE 3 END, created_at`,
  );
  if (policies.length === 0) return [];

  const versions = await queryRows<VersionRow>(
    db,
    sql`SELECT pv.id, pv.policy_id, pv.effective_from, pv.effective_to, pv.config, pv.note, pv.created_at
          FROM policy_versions pv
          JOIN policies p ON p.id = pv.policy_id AND p.type = 'cancellation'
         ORDER BY pv.effective_from DESC`,
  );

  return policies.map((policy) => ({
    id: policy.id,
    type: 'cancellation' as const,
    scope: policy.scope,
    scopeId: policy.scope_id,
    isActive: policy.is_active,
    versions: versions.filter((v) => v.policy_id === policy.id).map(toVersionDto),
  }));
}

/**
 * `POST /admin/cancellation-policies` — publishes a NEW immutable version for a scope.
 *
 * The whole publish is one transaction: close the open version's interval, then insert the new one.
 * If the exclusion constraint rejects the pair, nothing is written at all and the caller gets
 * `409 POLICY_VERSION_OVERLAP` — so a scope can never end up with two versions covering an instant,
 * which is the condition resolution refuses to guess about.
 *
 * `effective_from` is the SERVER's clock, never a caller-supplied instant: a client that could
 * choose the effective moment could retroactively re-price bookings created before it.
 */
export async function publishCancellationPolicy(
  adminUserId: string,
  adminProfileId: string,
  request: PublishCancellationPolicyRequest,
): Promise<AdminCancellationPolicyDto> {
  const config = validateCancellationPolicyConfig(request.config);

  const scope = request.scope;
  const scopeId = scope === 'platform' ? null : (request.scopeId ?? null);
  if (scope !== 'platform' && !scopeId) {
    throw policyConfigInvalidError([{ field: 'scopeId', message: 'is required for a category or service policy' }]);
  }

  const policyId = await getDb().transaction(async (tx) => {
    const [existing] = await queryRows<{ id: string }>(
      tx,
      scopeId === null
        ? sql`SELECT id FROM policies
               WHERE type = 'cancellation' AND scope = 'platform' AND scope_id IS NULL AND is_active
               FOR UPDATE`
        : sql`SELECT id FROM policies
               WHERE type = 'cancellation' AND scope = ${scope} AND scope_id = ${scopeId} AND is_active
               FOR UPDATE`,
    );

    let id = existing?.id;
    if (!id) {
      const [created] = await queryRows<{ id: string }>(
        tx,
        sql`INSERT INTO policies (type, scope, scope_id, is_active)
            VALUES ('cancellation', ${scope}, ${scopeId}, true) RETURNING id`,
      );
      id = created!.id;
    }

    // Close the currently open version, then open the new one at the same instant, so the two
    // intervals abut exactly and no gap exists in which a booking would resolve to nothing.
    const [closed] = await queryRows<{ effective_to: Date }>(
      tx,
      sql`UPDATE policy_versions SET effective_to = clock_timestamp(), updated_at = clock_timestamp()
           WHERE policy_id = ${id} AND effective_to IS NULL
           RETURNING effective_to`,
    );

    try {
      await tx.execute(sql`
        INSERT INTO policy_versions (policy_id, config, effective_from, effective_to, created_by_admin_id, note)
        VALUES (${id}, ${JSON.stringify(config)}::jsonb,
                ${closed ? closed.effective_to : sql`clock_timestamp()`}, NULL, ${adminProfileId},
                ${request.note ?? null})
      `);
    } catch (err) {
      // 23P01 = exclusion_violation, the `policy_versions_no_overlap_ex` constraint.
      if (pgError(err)?.code === '23P01') throw policyVersionOverlapError();
      throw err;
    }

    return id;
  });

  await recordAdminAuditEvent({
    actorUserId: adminUserId,
    actorRoles: await getAdminRoleNames(adminUserId),
    eventType: 'admin_rbac.cancellation_policy_published',
    resource: CANCELLATION_POLICY_RESOURCE,
    action: CANCELLATION_POLICY_CONFIGURE_ACTION,
    targetType: 'policy',
    targetId: policyId,
    reason: request.note ?? null,
    // A `medium`-tier action needs no approval, so the chain is empty by definition (spec 009 §3.1.4).
    approvalChain: [],
  });

  const all = await listCancellationPolicies();
  return all.find((policy) => policy.id === policyId)!;
}
