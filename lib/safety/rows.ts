/**
 * Spec 030 §4 "Retention and privacy" — row → DTO mapping, and the column allowlists that make the
 * two audiences structurally different rather than differing by a runtime `if`.
 *
 * THE REPORTER AND THE ADMIN GET DIFFERENT SHAPES BY CONSTRUCTION. `toSafetyReportDto` cannot leak
 * a priority, an AI summary, an admin identity or a resolution reason, because it never receives
 * them — the reporter's query selects a narrower column set. A reporter learning their report was
 * triaged `low` would be told about the platform's internal judgement, not about themselves.
 *
 * THE REPORTED USER GETS NOTHING. There is no DTO here for them and no route that returns one
 * (master §64).
 */
import type { FileAssetDto } from '@/lib/types/files';
import type {
  AdminSafetyReportDto,
  SafetyCategory,
  SafetyPriority,
  SafetyReportDto,
  SafetyReportStatus,
} from '@/lib/types/safety';
import type { BlockDto } from '@/lib/types/safety';

/** The columns a REPORTER may see. Deliberately missing everything moderation-internal. */
export interface ReporterReportRow {
  id: string;
  status: SafetyReportStatus;
  category: SafetyCategory;
  created_at: Date;
}

/** The columns an ADMIN may see, behind `safety_reports/read`. */
export interface AdminReportRow extends ReporterReportRow {
  reporter_user_id: string;
  target_user_id: string;
  booking_id: string | null;
  description: string;
  priority: SafetyPriority;
  ai_summary: string | null;
  claimed_by_admin_id: string | null;
  escalated_at: Date | null;
  resolved_at: Date | null;
  resolution_reason: string | null;
  restriction_requested_at: Date | null;
  version: number;
}

export interface BlockRow {
  id: string;
  blocked_user_id: string;
  created_at: Date;
}

const iso = (value: Date | null): string | null => (value === null ? null : new Date(value).toISOString());

export function toSafetyReportDto(row: ReporterReportRow, evidence: FileAssetDto[]): SafetyReportDto {
  return {
    id: row.id,
    status: row.status,
    category: row.category,
    createdAt: new Date(row.created_at).toISOString(),
    evidence,
  };
}

export function toAdminSafetyReportDto(row: AdminReportRow, evidence: FileAssetDto[]): AdminSafetyReportDto {
  return {
    ...toSafetyReportDto(row, evidence),
    reporterUserId: row.reporter_user_id,
    targetUserId: row.target_user_id,
    bookingId: row.booking_id,
    description: row.description,
    priority: row.priority,
    aiSummary: row.ai_summary,
    claimedByAdminId: row.claimed_by_admin_id,
    escalatedAt: iso(row.escalated_at),
    resolvedAt: iso(row.resolved_at),
    resolutionReason: row.resolution_reason,
    restrictionRequestedAt: iso(row.restriction_requested_at),
    version: row.version,
  };
}

export function toBlockDto(row: BlockRow): BlockDto {
  return {
    id: row.id,
    blockedUserId: row.blocked_user_id,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** The SELECT list for a reporter's own report. */
export const REPORTER_COLUMNS = 'id, status, category, created_at';

/**
 * The SELECT list for an admin. Note what is still absent even here: `idempotency_key`,
 * `idempotency_fingerprint` and `restriction_moderation_action_id` never reach any DTO.
 */
export const ADMIN_COLUMNS = `id, status, category, created_at, reporter_user_id, target_user_id, booking_id,
   description, priority, ai_summary, claimed_by_admin_id, escalated_at, resolved_at, resolution_reason,
   restriction_requested_at, version`;
