/**
 * Spec 031 §3 "Privacy and data exposure" (DECIDED-10) — row → DTO mapping, and the column
 * allowlists that make the two audiences structurally different rather than differing by a
 * runtime `if`.
 *
 * THE PARTICIPANT AND THE ADMIN GET DIFFERENT SHAPES BY CONSTRUCTION. `toDisputeDto` cannot leak an
 * admin identity, the AI summary, the refund approval chain, the safety cross-reference or the
 * legal-hold flag, because it never receives them — the participant query selects a narrower column
 * set (`PARTICIPANT_COLUMNS`) and the DTO has no field to put them in.
 *
 * EVERY ACTOR IS PROJECTED TO A RELATIVE ROLE. A participant never receives another user's id, so
 * `actorRole()` is the single place that decision is made, and `lib/disputes/privacy.test.ts`
 * asserts over serialized JSON that no uuid belonging to anyone else survives the boundary.
 */
import type {
  AdminDisputeDto,
  AdminDisputeSummaryDto,
  DisputeActorRole,
  DisputeAppealDto,
  DisputeAppealOutcome,
  DisputeDecision,
  DisputeDto,
  DisputeEvidenceDto,
  DisputeMessageDto,
  DisputeRefundState,
  DisputeResolutionDto,
  DisputeStatus,
  DisputeSummaryDto,
} from '@/lib/types/disputes';

/** The columns a PARTICIPANT may see. Deliberately missing everything moderation-internal. */
export const PARTICIPANT_COLUMNS = 'id, booking_id, opened_by_user_id, status, reason, created_at, closed_at';

/** The columns an ADMIN may see, behind `disputes/read`. */
export const ADMIN_COLUMNS = `${PARTICIPANT_COLUMNS}, claimed_by_admin_user_id, ai_summary, legal_hold, escalated_safety_report_id, version`;

export interface ParticipantDisputeRow {
  id: string;
  booking_id: string;
  opened_by_user_id: string;
  status: DisputeStatus;
  reason: string;
  created_at: Date;
  closed_at: Date | null;
}

export interface AdminDisputeRow extends ParticipantDisputeRow {
  claimed_by_admin_user_id: string | null;
  ai_summary: string | null;
  legal_hold: boolean;
  escalated_safety_report_id: string | null;
  version: number;
}

export interface ResolutionRow {
  dispute_id: string;
  decision: DisputeDecision;
  reasoning: string;
  resolved_by_admin_user_id: string;
  resolved_at: Date;
  proposed_refund_amount_minor_units: number | null;
  proposed_refund_currency_code: string | null;
  refund_admin_action_id: string | null;
}

export interface AppealRow {
  dispute_id: string;
  appellant_user_id: string;
  reason: string;
  outcome: DisputeAppealOutcome | null;
  reasoning: string | null;
  reviewed_by_admin_user_id: string | null;
  decided_at: Date | null;
  created_at: Date;
}

export interface EvidenceRow {
  id: string;
  file_asset_id: string;
  submitted_by_user_id: string;
  created_at: Date;
}

export interface MessageRow {
  id: string;
  sender_user_id: string;
  body: string;
  is_admin: boolean;
  created_at: Date;
}

const iso = (value: Date | null): string | null => (value === null ? null : new Date(value).toISOString());
const isoRequired = (value: Date): string => new Date(value).toISOString();

/**
 * How `viewerUserId` should see `actorUserId`.
 *
 * `isAdmin` is passed rather than inferred: an admin's id must never be compared against a
 * participant's, because the answer would be "counterparty" and that would imply the admin is a
 * party to the booking.
 */
export function actorRole(viewerUserId: string, actorUserId: string, isAdmin = false): DisputeActorRole {
  if (isAdmin) return 'admin';
  return actorUserId === viewerUserId ? 'me' : 'counterparty';
}

/**
 * The resolution as both audiences see it — identical, deliberately.
 *
 * Master §2.3 requires the REASONING to reach the parties, not just the outcome, and the proposed
 * amount is a promise made to the customer about their own money. What the participant does NOT
 * get is `resolvedByAdminUserId` and `refundAdminActionId`, neither of which has a field here;
 * they live on `AdminDisputeDto` instead.
 */
export function toResolutionDto(row: ResolutionRow, refundState: DisputeRefundState): DisputeResolutionDto {
  return {
    disputeId: row.dispute_id,
    decision: row.decision,
    reasoning: row.reasoning,
    resolvedAt: isoRequired(row.resolved_at),
    proposedRefundAmountMinorUnits: row.proposed_refund_amount_minor_units,
    proposedRefundCurrencyCode: row.proposed_refund_currency_code,
    refundState,
  };
}

export function toAppealDto(row: AppealRow, viewerUserId: string): DisputeAppealDto {
  return {
    disputeId: row.dispute_id,
    filedBy: row.appellant_user_id === viewerUserId ? 'me' : 'counterparty',
    reason: row.reason,
    filedAt: isoRequired(row.created_at),
    outcome: row.outcome,
    reasoning: row.reasoning,
    decidedAt: iso(row.decided_at),
  };
}

export function toEvidenceDto(row: EvidenceRow, viewerUserId: string, adminUserIds: ReadonlySet<string>): DisputeEvidenceDto {
  return {
    id: row.id,
    fileAssetId: row.file_asset_id,
    submittedBy: actorRole(viewerUserId, row.submitted_by_user_id, adminUserIds.has(row.submitted_by_user_id)),
    createdAt: isoRequired(row.created_at),
  };
}

export function toMessageDto(row: MessageRow, viewerUserId: string): DisputeMessageDto {
  return {
    id: row.id,
    body: row.body,
    // `is_admin` is stored, so an admin message is labelled from the row rather than guessed.
    authorRole: actorRole(viewerUserId, row.sender_user_id, row.is_admin),
    isAdmin: row.is_admin,
    createdAt: isoRequired(row.created_at),
  };
}

export interface DisputeAggregate {
  resolution: DisputeResolutionDto | null;
  appeal: AppealRow | null;
  evidenceCount: number;
  messageCount: number;
  appealWindowEndsAt: Date | null;
}

export function toDisputeDto(
  row: ParticipantDisputeRow,
  viewerUserId: string,
  aggregate: DisputeAggregate,
  capabilities: { canAppeal: boolean; canPostMessage: boolean; canSubmitEvidence: boolean },
): DisputeDto {
  return {
    id: row.id,
    bookingId: row.booking_id,
    status: row.status,
    openedBy: row.opened_by_user_id === viewerUserId ? 'me' : 'counterparty',
    reason: row.reason,
    createdAt: isoRequired(row.created_at),
    evidenceCount: aggregate.evidenceCount,
    messageCount: aggregate.messageCount,
    resolution: aggregate.resolution,
    appeal: aggregate.appeal ? toAppealDto(aggregate.appeal, viewerUserId) : null,
    appealWindowEndsAt: iso(aggregate.appealWindowEndsAt),
    canAppeal: capabilities.canAppeal,
    canPostMessage: capabilities.canPostMessage,
    canSubmitEvidence: capabilities.canSubmitEvidence,
  };
}

export function toDisputeSummaryDto(row: ParticipantDisputeRow): DisputeSummaryDto {
  return {
    id: row.id,
    bookingId: row.booking_id,
    status: row.status,
    createdAt: isoRequired(row.created_at),
  };
}

export function toAdminDisputeDto(
  row: AdminDisputeRow,
  aggregate: DisputeAggregate,
  parties: { customerUserId: string; providerUserId: string },
  resolutionRow: ResolutionRow | null,
): AdminDisputeDto {
  return {
    id: row.id,
    bookingId: row.booking_id,
    status: row.status,
    reason: row.reason,
    createdAt: isoRequired(row.created_at),
    evidenceCount: aggregate.evidenceCount,
    messageCount: aggregate.messageCount,
    resolution: aggregate.resolution,
    // An admin sees real ids on the appeal too; `toAppealDto` is reused with a viewer id that
    // matches nobody, so `filedBy` reads 'counterparty' rather than falsely claiming 'me'.
    appeal: aggregate.appeal ? toAppealDto(aggregate.appeal, '') : null,
    appealWindowEndsAt: iso(aggregate.appealWindowEndsAt),
    openedByUserId: row.opened_by_user_id,
    customerUserId: parties.customerUserId,
    providerUserId: parties.providerUserId,
    claimedByAdminUserId: row.claimed_by_admin_user_id,
    resolvedByAdminUserId: resolutionRow?.resolved_by_admin_user_id ?? null,
    aiSummary: row.ai_summary,
    refundAdminActionId: resolutionRow?.refund_admin_action_id ?? null,
    escalatedSafetyReportId: row.escalated_safety_report_id,
    legalHold: row.legal_hold,
    version: row.version,
  };
}

export interface AdminQueueRow {
  id: string;
  booking_id: string;
  status: DisputeStatus;
  created_at: Date;
  claimed_by_admin_user_id: string | null;
  has_proposed_refund: boolean;
  legal_hold: boolean;
}

export function toAdminDisputeSummaryDto(row: AdminQueueRow): AdminDisputeSummaryDto {
  return {
    id: row.id,
    bookingId: row.booking_id,
    status: row.status,
    createdAt: isoRequired(row.created_at),
    claimedByAdminUserId: row.claimed_by_admin_user_id,
    hasProposedRefund: row.has_proposed_refund,
    legalHold: row.legal_hold,
  };
}
