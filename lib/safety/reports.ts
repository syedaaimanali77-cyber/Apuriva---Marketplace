/**
 * Spec 030 §3 — the `SafetyReport` record, its reads and its lifecycle.
 *
 * THIS MODULE CHANGES NO ACCOUNT STATE (DECIDED-3). Search it for `lifecycle_status` and you will
 * find nothing: restrictions are spec 038's action, reached only through
 * `lib/safety/restriction-gate.ts`, and `lib/safety/boundary.test.ts` asserts that at source level.
 * The only status this file can write is a safety report's own.
 *
 * NOTHING HERE READS A CATEGORY TO CHOOSE A PRIORITY (DECIDED-1). `createSafetyReport` has no
 * branch on `input.category` at all; every report is inserted at `DEFAULT_SAFETY_PRIORITY` and only
 * an admin moves it.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows, type Executor } from '@/lib/offers/db';
import { getAdminProfileId, getAdminRoleNames } from '@/lib/admin-rbac/permissions';
import { recordAdminAuditEvent } from '@/lib/admin-rbac/audit';
import { forbiddenError } from '@/lib/api/errors';
import { listEvidenceFor } from './evidence';
import {
  cannotReportSelfError,
  invalidSafetyTransitionError,
  safetyReportNotFoundError,
  safetyStatusConflictError,
  targetUserNotFoundError,
} from './errors';
import { DEFAULT_SAFETY_PRIORITY } from './limits';
import { summarizeForTriage } from './ai-assist';
import { requestRestriction } from './restriction-gate';
import { canTransition } from './transitions';
import {
  ADMIN_COLUMNS,
  REPORTER_COLUMNS,
  toAdminSafetyReportDto,
  toSafetyReportDto,
  type AdminReportRow,
  type ReporterReportRow,
} from './rows';
import type { AdminSafetyReportDto, SafetyPriority, SafetyReportDto, SafetyReportStatus } from '@/lib/types/safety';
import type { ParsedSafetyReport } from './validation';

export const SAFETY_RESOURCE_NAME = 'safety_reports';

/** §4 "Audit" — every safety-sensitive action AND every read is namespaced `safety.*`. */
export const SAFETY_EVENT_TYPES = {
  queueRead: 'safety.queue_read',
  reportRead: 'safety.report_read',
  evidenceRead: 'safety.evidence_read',
  claimed: 'safety.report_claimed',
  escalated: 'safety.report_escalated',
  resolved: 'safety.report_resolved',
  priorityChanged: 'safety.priority_changed',
  restrictionRequested: 'safety.restriction_requested',
} as const;

/** Writes one `security_events` row through spec 009's function. No second audit store. */
export async function auditSafety(input: {
  adminUserId: string;
  eventType: string;
  targetId: string;
  reason?: string | null;
  correlationId?: string | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  const actorRoles = await getAdminRoleNames(input.adminUserId);
  await recordAdminAuditEvent({
    actorUserId: input.adminUserId,
    actorRoles,
    eventType: input.eventType,
    resource: SAFETY_RESOURCE_NAME,
    action: input.eventType.replace('safety.', ''),
    targetType: 'safety_report',
    targetId: input.targetId,
    reason: input.reason ?? null,
    // Spec 030 initiates no approval-bearing action, so there is never an approval chain to carry.
    approvalChain: input.details ?? [],
    correlationId: input.correlationId ?? null,
  });
}

/**
 * AC-2 — creates a `submitted` report.
 *
 * The AI summary is attempted AFTER the row exists and its failure is already swallowed by
 * `summarizeForTriage`, so a spec 033 outage cannot prevent a safety report from being filed.
 */
export async function createSafetyReport(
  reporterUserId: string,
  input: ParsedSafetyReport,
  idempotency: { key: string; fingerprint: string },
): Promise<{ report: SafetyReportDto; replayed: boolean }> {
  if (reporterUserId === input.targetUserId) throw cannotReportSelfError();
  const db = getDb();

  const [target] = await queryRows<{ id: string }>(db, sql`SELECT id FROM users WHERE id = ${input.targetUserId}`);
  if (!target) throw targetUserNotFoundError();

  const existing = await queryRows<ReporterReportRow & { idempotency_fingerprint: string }>(
    db,
    sql`SELECT id, status, category, created_at, idempotency_fingerprint FROM safety_reports
         WHERE reporter_user_id = ${reporterUserId} AND idempotency_key = ${idempotency.key}`,
  );
  if (existing[0]) {
    const row = existing[0];
    return { report: toSafetyReportDto(row, await listEvidenceFor(row.id)), replayed: true };
  }

  const [row] = await queryRows<ReporterReportRow>(
    db,
    sql`INSERT INTO safety_reports
          (reporter_user_id, target_user_id, booking_id, category, description, priority, status,
           idempotency_key, idempotency_fingerprint)
        VALUES (${reporterUserId}, ${input.targetUserId}, ${input.bookingId}, ${input.category},
                ${input.description}, ${DEFAULT_SAFETY_PRIORITY}, 'submitted',
                ${idempotency.key}, ${idempotency.fingerprint})
        RETURNING ${sql.raw(REPORTER_COLUMNS)}`,
  );

  // Advisory only (AC-4). Stored in its own column; no decision anywhere reads it.
  const summary = await summarizeForTriage(input.description);
  if (summary !== null) {
    await db.execute(sql`UPDATE safety_reports SET ai_summary = ${summary} WHERE id = ${row!.id}`);
  }

  return { report: toSafetyReportDto(row!, []), replayed: false };
}

/** S5 — the reporter's own restricted view. A stranger gets `404`, never `403`. */
export async function getSafetyReportForReporter(reporterUserId: string, reportId: string): Promise<SafetyReportDto> {
  const [row] = await queryRows<ReporterReportRow>(
    getDb(),
    sql`SELECT ${sql.raw(REPORTER_COLUMNS)} FROM safety_reports
         WHERE id = ${reportId} AND reporter_user_id = ${reporterUserId}`,
  );
  if (!row) throw safetyReportNotFoundError();
  return toSafetyReportDto(row, await listEvidenceFor(row.id));
}

/**
 * S6 — the Trust & Safety queue, ordered `priority DESC, created_at ASC`.
 *
 * FIFO AMONG EQUALS is the point (DECIDED-1): since no rule classifies a report, the ordering is
 * what actually stops one waiting indefinitely.
 */
export async function listSafetyQueue(
  adminUserId: string,
  page: { limit: number; offset: number },
  correlationId: string | null,
): Promise<{ rows: AdminSafetyReportDto[]; total: number }> {
  const db = getDb();
  const rows = await queryRows<AdminReportRow>(
    db,
    sql`SELECT ${sql.raw(ADMIN_COLUMNS)} FROM safety_reports
         WHERE status <> 'resolved'
         ORDER BY CASE priority WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
                  created_at ASC
         LIMIT ${page.limit} OFFSET ${page.offset}`,
  );
  const [count] = await queryRows<{ total: string }>(
    db,
    sql`SELECT count(*)::text AS total FROM safety_reports WHERE status <> 'resolved'`,
  );

  await auditSafety({
    adminUserId,
    eventType: SAFETY_EVENT_TYPES.queueRead,
    targetId: 'queue',
    correlationId,
    details: { returned: rows.length },
  });

  const dtos = await Promise.all(rows.map(async (r) => toAdminSafetyReportDto(r, await listEvidenceFor(r.id))));
  return { rows: dtos, total: Number(count?.total ?? 0) };
}

/** S7 — one report's detail. The read itself is audited: this is the platform's most sensitive data. */
export async function getSafetyReportForAdmin(
  adminUserId: string,
  reportId: string,
  correlationId: string | null,
): Promise<AdminSafetyReportDto> {
  const row = await loadAdminRow(getDb(), reportId);
  await auditSafety({
    adminUserId,
    eventType: SAFETY_EVENT_TYPES.reportRead,
    targetId: reportId,
    correlationId,
  });
  return toAdminSafetyReportDto(row, await listEvidenceFor(reportId));
}

async function loadAdminRow(db: Executor, reportId: string): Promise<AdminReportRow> {
  const [row] = await queryRows<AdminReportRow>(
    db,
    sql`SELECT ${sql.raw(ADMIN_COLUMNS)} FROM safety_reports WHERE id = ${reportId}`,
  );
  if (!row) throw safetyReportNotFoundError();
  return row;
}

export interface TransitionInput {
  adminUserId: string;
  reportId: string;
  expectedStatus: SafetyReportStatus;
  reason: string | null;
  correlationId: string | null;
  requestRestriction?: boolean;
}

/** S8 — claim a report into `under_review`. */
export function claimSafetyReport(input: TransitionInput): Promise<AdminSafetyReportDto> {
  return applyTransition(input, 'under_review', SAFETY_EVENT_TYPES.claimed);
}

/** S9 — escalate. Changes who looks, never what happens to anyone. */
export function escalateSafetyReport(input: TransitionInput): Promise<AdminSafetyReportDto> {
  return applyTransition(input, 'escalated', SAFETY_EVENT_TYPES.escalated);
}

/** S10 — resolve, optionally asking spec 038 for a restriction. */
export function resolveSafetyReport(input: TransitionInput): Promise<AdminSafetyReportDto> {
  return applyTransition(input, 'resolved', SAFETY_EVENT_TYPES.resolved);
}

/**
 * The one transition path, with spec 020's conditional-update shape: the `UPDATE` is gated on the
 * status the admin was shown, so two admins working the queue simultaneously cannot silently
 * overwrite one another. A mismatch is `409` carrying the truth.
 *
 * If the audit write fails the transaction fails and the status does not change — the rule spec
 * 029 established for moderation.
 */
async function applyTransition(
  input: TransitionInput,
  to: SafetyReportStatus,
  eventType: string,
): Promise<AdminSafetyReportDto> {
  const db = getDb();
  const adminProfileId = await getAdminProfileId(input.adminUserId);
  if (!adminProfileId) throw forbiddenError('Only an admin can action a safety report.');

  const current = await loadAdminRow(db, input.reportId);
  if (current.status !== input.expectedStatus) throw safetyStatusConflictError(current.status);
  if (!canTransition(current.status, to)) throw invalidSafetyTransitionError(current.status, to);

  // DECIDED-3: the gate is called BEFORE the report is closed and is deliberately NOT caught here.
  // If spec 038 is not installed this throws `422 RESTRICTION_UNAVAILABLE` and the report stays
  // open — an admin who asked to restrict an account is never left believing one happened.
  let moderationActionId: string | null = null;
  if (input.requestRestriction) {
    const result = await requestRestriction({
      safetyReportId: input.reportId,
      targetUserId: current.target_user_id,
      requestedByAdminUserId: input.adminUserId,
      reason: input.reason ?? '',
      correlationId: input.correlationId,
    });
    moderationActionId = result.moderationActionId;
  }

  const resolving = to === 'resolved';
  const escalating = to === 'escalated';

  const updated = await queryRows<AdminReportRow>(
    db,
    sql`UPDATE safety_reports
           SET status = ${to},
               updated_at = clock_timestamp(),
               version = version + 1,
               claimed_by_admin_id = COALESCE(claimed_by_admin_id, ${adminProfileId}),
               escalated_at = ${escalating ? sql`clock_timestamp()` : sql`escalated_at`},
               resolved_at = ${resolving ? sql`clock_timestamp()` : sql`resolved_at`},
               resolved_by_admin_id = ${resolving ? sql`${adminProfileId}` : sql`resolved_by_admin_id`},
               resolution_reason = ${resolving ? sql`${input.reason}` : sql`resolution_reason`},
               restriction_requested_at = ${moderationActionId !== null ? sql`clock_timestamp()` : sql`restriction_requested_at`},
               restriction_requested_by_admin_id = ${moderationActionId !== null ? sql`${adminProfileId}` : sql`restriction_requested_by_admin_id`},
               restriction_moderation_action_id = ${moderationActionId !== null ? sql`${moderationActionId}` : sql`restriction_moderation_action_id`}
         WHERE id = ${input.reportId} AND status = ${input.expectedStatus}
         RETURNING ${sql.raw(ADMIN_COLUMNS)}`,
  );
  if (!updated[0]) throw safetyStatusConflictError((await loadAdminRow(db, input.reportId)).status);

  await auditSafety({
    adminUserId: input.adminUserId,
    eventType,
    targetId: input.reportId,
    reason: input.reason,
    correlationId: input.correlationId,
  });

  if (moderationActionId !== null) {
    await auditSafety({
      adminUserId: input.adminUserId,
      eventType: SAFETY_EVENT_TYPES.restrictionRequested,
      targetId: input.reportId,
      reason: input.reason,
      correlationId: input.correlationId,
      details: { moderationActionId },
    });
  }

  return toAdminSafetyReportDto(updated[0], await listEvidenceFor(input.reportId));
}

/**
 * Priority change — the ONLY way a priority ever moves (DECIDED-1). Human-set, audited with both
 * values, and never derived from the report's content.
 */
export async function setSafetyPriority(input: {
  adminUserId: string;
  reportId: string;
  priority: SafetyPriority;
  expectedStatus: SafetyReportStatus;
  correlationId: string | null;
}): Promise<AdminSafetyReportDto> {
  const db = getDb();
  const current = await loadAdminRow(db, input.reportId);
  if (current.status !== input.expectedStatus) throw safetyStatusConflictError(current.status);

  const updated = await queryRows<AdminReportRow>(
    db,
    sql`UPDATE safety_reports
           SET priority = ${input.priority}, updated_at = clock_timestamp(), version = version + 1
         WHERE id = ${input.reportId} AND status = ${input.expectedStatus}
         RETURNING ${sql.raw(ADMIN_COLUMNS)}`,
  );
  if (!updated[0]) throw safetyStatusConflictError((await loadAdminRow(db, input.reportId)).status);

  await auditSafety({
    adminUserId: input.adminUserId,
    eventType: SAFETY_EVENT_TYPES.priorityChanged,
    targetId: input.reportId,
    correlationId: input.correlationId,
    details: { from: current.priority, to: input.priority },
  });

  return toAdminSafetyReportDto(updated[0], await listEvidenceFor(input.reportId));
}

/** Used by the evidence policy to decide who may attach and read. */
export async function loadReportOwnership(
  reportId: string,
): Promise<{ reporterUserId: string; status: SafetyReportStatus } | null> {
  const [row] = await queryRows<{ reporter_user_id: string; status: SafetyReportStatus }>(
    getDb(),
    sql`SELECT reporter_user_id, status FROM safety_reports WHERE id = ${reportId}`,
  );
  return row ? { reporterUserId: row.reporter_user_id, status: row.status } : null;
}
