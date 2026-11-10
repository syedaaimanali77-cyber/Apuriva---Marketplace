/**
 * Spec 041 §3.5, §3.6 F1/F2, §3.9 — the admin flag surface. The ONLY writer of
 * `feature_flag_environment_values` (`boundary.test.ts` asserts it).
 *
 * RBAC (master §69/§71): business flags → `feature_flags/read`/`toggle` (content_admin,
 * operations_admin, super_admin); developer flags → `read_technical`/`toggle_technical` (super_admin
 * only; no developer role exists, D-1). Every check goes through spec 009's `resolvePermission`,
 * fresh on each call.
 *
 * A deployment reads and writes only its own environment's value (§3.2, AC-6).
 */
import { sql } from 'drizzle-orm';
import { ApiRouteError, forbiddenError, validationError } from '@/lib/api/errors';
import { getDb } from '@/lib/db';
import { queryRows, type Executor } from '@/lib/offers/db';
import { recordAdminAuditEvent } from '@/lib/admin-rbac/audit';
import { getAdminProfileId, getAdminRoleNames, resolvePermission } from '@/lib/admin-rbac/permissions';
import type { FeatureFlagDto, FlagEnvironment, UpdateFeatureFlagRequest } from '@/lib/types/feature-flags';
import { currentFlagEnvironment, isFlagEnvironment } from './environment';
import { envOverride, FEATURE_FLAG_REGISTRY, flagDefinition, isFeatureFlagKey, type FeatureFlagKey } from './registry';

export const FEATURE_FLAGS_RESOURCE = 'feature_flags';
/** Spec 041 §3.9 — the audit resource of a developer-flag change; readable by Super Admin only (X-7). */
export const FEATURE_FLAGS_TECHNICAL_AUDIT_RESOURCE = 'feature_flags.technical';
export const FEATURE_FLAG_ACTIONS = {
  read: 'read',
  toggle: 'toggle',
  readTechnical: 'read_technical',
  toggleTechnical: 'toggle_technical',
} as const;
export const MAX_REASON_LENGTH = 500;

async function holds(userId: string, action: string): Promise<boolean> {
  return (await resolvePermission(userId, FEATURE_FLAGS_RESOURCE, action)).allowed;
}

export function flagNotRegisteredError(): ApiRouteError {
  return new ApiRouteError('FLAG_NOT_REGISTERED', 'No feature flag with that key is registered.', { status: 404 });
}

export function flagEnvironmentMismatchError(current: FlagEnvironment): ApiRouteError {
  return new ApiRouteError('FLAG_ENVIRONMENT_MISMATCH', `This deployment is "${current}"; only its own environment can be changed here.`, {
    status: 409,
  });
}

export function flagVersionConflictError(currentVersion: number): ApiRouteError {
  return new ApiRouteError('CONFLICT', `This flag was changed by someone else. Current version is ${currentVersion}; refetch and retry.`, {
    details: { currentVersion },
  });
}

interface StoredRow {
  key: string;
  description: string;
  controlled_by: 'business' | 'developer';
  is_kill_switch: boolean;
  client_readable: boolean;
  removal_criteria: string | null;
  enabled: boolean | null;
  version: number | null;
  updated_at: Date | string | null;
}

function toDto(row: StoredRow, environment: FlagEnvironment): FeatureFlagDto {
  const key = row.key as FeatureFlagKey;
  const override = envOverride(key);
  const enabled = row.enabled ?? flagDefinition(key).defaults[environment];
  return {
    key,
    description: row.description,
    controlledBy: row.controlled_by,
    isKillSwitch: row.is_kill_switch,
    clientReadable: row.client_readable,
    removalCriteria: row.removal_criteria,
    environment,
    enabled,
    effective: override ?? enabled,
    overriddenBy: override === null ? null : flagDefinition(key).overrideVar,
    version: row.version ?? 0,
    updatedAt: row.updated_at === null ? new Date(0).toISOString() : new Date(row.updated_at).toISOString(),
  };
}

async function readRows(db: Executor, environment: FlagEnvironment, key?: string): Promise<StoredRow[]> {
  return queryRows<StoredRow>(
    db,
    sql`SELECT f.key, f.description, f.controlled_by, f.is_kill_switch, f.client_readable, f.removal_criteria,
               v.enabled, v.version, v.updated_at
          FROM feature_flags f
          LEFT JOIN feature_flag_environment_values v ON v.feature_flag_id = f.id AND v.environment = ${environment}
         WHERE ${key === undefined ? sql`true` : sql`f.key = ${key}`}`,
  );
}

const REGISTRY_ORDER = new Map<string, number>(FEATURE_FLAG_REGISTRY.map((f, i) => [f.key, i]));

/**
 * F1 — the flags the caller may see, for the running environment, in registry order. Business
 * flags need `feature_flags/read`; developer flags also need `read_technical` and are otherwise
 * ABSENT, not merely disabled (AC-2).
 */
export async function listFeatureFlags(userId: string, db: Executor = getDb()): Promise<FeatureFlagDto[]> {
  if (!(await holds(userId, FEATURE_FLAG_ACTIONS.read))) throw forbiddenError('You do not have access to feature flags.');
  const technical = await holds(userId, FEATURE_FLAG_ACTIONS.readTechnical);
  const environment = currentFlagEnvironment();
  return (await readRows(db, environment))
    .filter((row) => isFeatureFlagKey(row.key))
    .filter((row) => technical || row.controlled_by === 'business')
    .sort((a, b) => REGISTRY_ORDER.get(a.key)! - REGISTRY_ORDER.get(b.key)!)
    .map((row) => toDto(row, environment));
}

function parseBody(raw: unknown): UpdateFeatureFlagRequest {
  const body = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const errors: { field: string; message: string }[] = [];
  if (!isFlagEnvironment(body.environment)) errors.push({ field: 'environment', message: 'must be development, staging or production' });
  if (typeof body.enabled !== 'boolean') errors.push({ field: 'enabled', message: 'must be a boolean' });
  if (!(typeof body.expectedVersion === 'number' && Number.isInteger(body.expectedVersion) && body.expectedVersion >= 1)) {
    errors.push({ field: 'expectedVersion', message: 'must be a positive integer' });
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length === 0 || reason.length > MAX_REASON_LENGTH) {
    errors.push({ field: 'reason', message: `is required (1-${MAX_REASON_LENGTH} characters)` });
  }
  if (errors.length > 0) throw validationError(errors);
  return {
    environment: body.environment as FlagEnvironment,
    enabled: body.enabled as boolean,
    expectedVersion: body.expectedVersion as number,
    reason,
  };
}

/**
 * F2 — change one flag for the running environment (AC-1). Order: validation (400) → registered
 * (404) → permission for the flag's class (403) → environment (409) → in one transaction: lock the
 * row, version check (409), no-op or update. The spec 039 audit row is written right after the
 * commit (§3.9); a refused, invalid or no-op request writes none (AC-3).
 */
export async function toggleFeatureFlag(userId: string, key: string, raw: unknown): Promise<FeatureFlagDto> {
  const body = parseBody(raw);
  if (!isFeatureFlagKey(key)) throw flagNotRegisteredError();
  const definition = flagDefinition(key);
  const technical = definition.controlledBy === 'developer';
  const action = technical ? FEATURE_FLAG_ACTIONS.toggleTechnical : FEATURE_FLAG_ACTIONS.toggle;
  if (!(await holds(userId, action))) throw forbiddenError('You do not have permission to change this flag.');

  const environment = currentFlagEnvironment();
  if (body.environment !== environment) throw flagEnvironmentMismatchError(environment);
  const adminProfileId = await getAdminProfileId(userId);

  const outcome = await getDb().transaction(async (tx) => {
    const [row] = await queryRows<{ id: string; enabled: boolean; version: number }>(
      tx,
      sql`SELECT v.id, v.enabled, v.version
            FROM feature_flag_environment_values v
            JOIN feature_flags f ON f.id = v.feature_flag_id
           WHERE f.key = ${key} AND v.environment = ${environment}
           FOR UPDATE OF v`,
    );
    if (!row) throw flagNotRegisteredError();
    if (row.version !== body.expectedVersion) throw flagVersionConflictError(row.version);
    if (row.enabled === body.enabled) return { changed: false as const };
    await tx.execute(sql`
      UPDATE feature_flag_environment_values
         SET enabled = ${body.enabled}, updated_by_admin_id = ${adminProfileId}, updated_at = clock_timestamp(),
             version = version + 1
       WHERE id = ${row.id}
    `);
    return { changed: true as const, before: row.enabled };
  });

  if (outcome.changed) {
    const before = { environment, enabled: outcome.before };
    const after = { environment, enabled: body.enabled };
    await recordAdminAuditEvent({
      actorUserId: userId,
      actorRoles: await getAdminRoleNames(userId),
      eventType: 'feature_flag.toggled',
      ...(technical
        ? { resource: FEATURE_FLAGS_TECHNICAL_AUDIT_RESOURCE, action: FEATURE_FLAG_ACTIONS.toggleTechnical }
        : { resource: FEATURE_FLAGS_RESOURCE, action: FEATURE_FLAG_ACTIONS.toggle }),
      targetType: 'feature_flag',
      targetId: key,
      reason: body.reason,
      // A medium-tier action needs no approval, so the chain is empty (spec 009 §3.1.4).
      approvalChain: [],
      before,
      after,
    });
    const line = { key, environment, before: outcome.before, after: body.enabled, at: new Date().toISOString() };
    console.log(JSON.stringify({ event: 'feature_flags.toggled', ...line }));
    // Master §117: a kill switch firing is alert-worthy; the paging rule itself is spec 046's.
    if (definition.isKillSwitch) console.warn(JSON.stringify({ event: 'feature_flags.kill_switch_changed', ...line }));
  }

  const [fresh] = await readRows(getDb(), environment, key);
  return toDto(fresh!, environment);
}
