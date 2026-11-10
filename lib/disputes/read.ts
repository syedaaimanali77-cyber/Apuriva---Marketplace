/**
 * Spec 031 §3 — reads, the audit helper, and the participant/admin access resolution every other
 * module in this spec routes through.
 *
 * TWO ACCESS RULES, AND ONLY TWO:
 *
 *   `resolveParticipantAccess`  — the caller must be the booking's customer or provider. A
 *                                 non-participant gets `404`, never `403`, so a dispute's existence
 *                                 is not probeable. Either active mode is accepted: a disagreement
 *                                 is not role-scoped, and forcing a mode switch mid-argument is a
 *                                 barrier at exactly the wrong moment.
 *
 *   `resolveAdminAccess`        — the caller must hold the named permission AND must not be a
 *                                 participant of the booking (`DISPUTE_PARTICIPANT_CONFLICT`). The
 *                                 conflict check is a participation query, never a role check, so
 *                                 it holds however the admin acquired the role — and it applies to
 *                                 READS too, because an admin should not be able to read the other
 *                                 side's evidence in their own argument.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows, type Executor } from '@/lib/offers/db';
import { getAdminRoleNames } from '@/lib/admin-rbac/permissions';
import { recordAdminAuditEvent } from '@/lib/admin-rbac/audit';
import { isUuid } from '@/lib/offers/validation';
import type { PageParams } from '@/lib/api/pagination';
import type { DisputeRefundState } from '@/lib/types/disputes';
import { disputeNotFoundError, disputeParticipantConflictError } from './errors';
import { appealWindowEndsAt } from './limits';
import { isContributable } from './transitions';
import {
  ADMIN_COLUMNS,
  PARTICIPANT_COLUMNS,
  toAdminDisputeDto,
  toAdminDisputeSummaryDto,
  toDisputeDto,
  toDisputeSummaryDto,
  type AdminDisputeRow,
  type AdminQueueRow,
  type AppealRow,
  type DisputeAggregate,
  type ParticipantDisputeRow,
  type ResolutionRow,
} from './rows';
import type { AdminDisputeDto, AdminDisputeSummaryDto, DisputeDto, DisputeSummaryDto } from '@/lib/types/disputes';

export const DISPUTES_RESOURCE_NAME = 'disputes';

/** §8 "Audit events" — every dispute-sensitive admin action AND every admin read, namespaced `disputes.*`. */
export const DISPUTE_EVENT_TYPES = {
  opened: 'disputes.opened',
  queueRead: 'disputes.queue_read',
  detailRead: 'disputes.detail_read',
  evidenceRead: 'disputes.evidence_read',
  messagesRead: 'disputes.messages_read',
  adminMessagePosted: 'disputes.admin_message_posted',
  claimed: 'disputes.claimed',
  resolved: 'disputes.resolved',
  refundLinked: 'disputes.refund_linked',
  refundFailed: 'disputes.refund_failed',
  payoutHoldApplied: 'disputes.payout_hold_applied',
  payoutHoldReleased: 'disputes.payout_hold_released',
  appealFiled: 'disputes.appeal_filed',
  appealRead: 'disputes.appeal_read',
  appealDecided: 'disputes.appeal_decided',
  legalHoldSet: 'disputes.legal_hold_set',
  legalHoldCleared: 'disputes.legal_hold_cleared',
  safetyEscalated: 'disputes.safety_escalated',
  closed: 'disputes.closed',
} as const;

/**
 * Writes one `security_events` row through spec 009's function. No second audit store.
 *
 * `actorRoles` is empty for a participant action (`disputes.opened`, `disputes.appeal_filed`):
 * they are not an admin and hold no roles, but the action is still worth recording against the
 * dispute. Spec 039 consolidates all of this later; until then this is exactly what specs
 * 023/025/029/030 do.
 */
export async function auditDispute(input: {
  actorUserId: string;
  eventType: string;
  targetId: string;
  reason?: string | null;
  correlationId?: string | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  const actorRoles = await getAdminRoleNames(input.actorUserId);
  await recordAdminAuditEvent({
    actorUserId: input.actorUserId,
    actorRoles,
    eventType: input.eventType,
    resource: DISPUTES_RESOURCE_NAME,
    action: input.eventType.replace('disputes.', ''),
    targetType: 'dispute',
    targetId: input.targetId,
    reason: input.reason ?? null,
    // Spec 031 initiates no approval-bearing action of its own (DECIDED-2), so there is never an
    // approval chain to carry. The refund's chain lives on spec 022's own audit records.
    approvalChain: input.details ?? [],
    correlationId: input.correlationId ?? null,
  });
}

export interface BookingParties {
  bookingId: string;
  customerUserId: string;
  providerUserId: string;
}

/** The two user ids behind a booking, resolved through its profile rows. */
export async function loadBookingParties(db: Executor, bookingId: string): Promise<BookingParties | null> {
  const [row] = await queryRows<{ booking_id: string; customer_user_id: string; provider_user_id: string }>(
    db,
    sql`SELECT b.id AS booking_id, cp.user_id AS customer_user_id, pp.user_id AS provider_user_id
          FROM bookings b
          JOIN customer_profiles cp ON cp.id = b.customer_profile_id
          JOIN provider_profiles pp ON pp.id = b.provider_profile_id
         WHERE b.id = ${bookingId}`,
  );
  if (!row) return null;
  return { bookingId: row.booking_id, customerUserId: row.customer_user_id, providerUserId: row.provider_user_id };
}

export interface DisputeOwnership {
  id: string;
  bookingId: string;
  status: ParticipantDisputeRow['status'];
  openedByUserId: string;
  customerUserId: string;
  providerUserId: string;
  legalHold: boolean;
}

/** The minimal identity/ownership facts every access check needs. Used by the evidence policy too. */
export async function loadDisputeOwnership(disputeId: string, db: Executor = getDb()): Promise<DisputeOwnership | null> {
  if (!isUuid(disputeId)) return null;
  const [row] = await queryRows<{
    id: string;
    booking_id: string;
    status: ParticipantDisputeRow['status'];
    opened_by_user_id: string;
    legal_hold: boolean;
    customer_user_id: string;
    provider_user_id: string;
  }>(
    db,
    sql`SELECT d.id, d.booking_id, d.status, d.opened_by_user_id, d.legal_hold,
               cp.user_id AS customer_user_id, pp.user_id AS provider_user_id
          FROM disputes d
          JOIN bookings b ON b.id = d.booking_id
          JOIN customer_profiles cp ON cp.id = b.customer_profile_id
          JOIN provider_profiles pp ON pp.id = b.provider_profile_id
         WHERE d.id = ${disputeId}`,
  );
  if (!row) return null;
  return {
    id: row.id,
    bookingId: row.booking_id,
    status: row.status,
    openedByUserId: row.opened_by_user_id,
    customerUserId: row.customer_user_id,
    providerUserId: row.provider_user_id,
    legalHold: row.legal_hold,
  };
}

export function isDisputeParticipant(ownership: DisputeOwnership, userId: string): boolean {
  return ownership.customerUserId === userId || ownership.providerUserId === userId;
}

/**
 * The participant gate. `404` for a non-participant — never `403`, so a dispute's existence on
 * someone else's booking is not probeable.
 */
export async function resolveParticipantAccess(disputeId: string, userId: string): Promise<DisputeOwnership> {
  const ownership = await loadDisputeOwnership(disputeId);
  if (!ownership || !isDisputeParticipant(ownership, userId)) throw disputeNotFoundError();
  return ownership;
}

/**
 * The admin gate. Permission first, then the participation conflict.
 *
 * The order matters: an admin who lacks the permission gets `403 FORBIDDEN` regardless of whether
 * they are a party, so the conflict code never tells an unauthorized caller that a dispute exists.
 */
export async function resolveAdminAccess(
  disputeId: string,
  adminUserId: string,
  requirePermission: (adminUserId: string) => Promise<void>,
): Promise<DisputeOwnership> {
  await requirePermission(adminUserId);
  const ownership = await loadDisputeOwnership(disputeId);
  if (!ownership) throw disputeNotFoundError();
  if (isDisputeParticipant(ownership, adminUserId)) throw disputeParticipantConflictError();
  return ownership;
}

export async function loadResolutionRow(db: Executor, disputeId: string): Promise<ResolutionRow | null> {
  const [row] = await queryRows<ResolutionRow>(
    db,
    sql`SELECT dispute_id, decision, reasoning, resolved_by_admin_user_id, resolved_at,
               proposed_refund_amount_minor_units, proposed_refund_currency_code, refund_admin_action_id
          FROM dispute_resolutions WHERE dispute_id = ${disputeId}`,
  );
  return row ?? null;
}

export async function loadAppealRow(db: Executor, disputeId: string): Promise<AppealRow | null> {
  const [row] = await queryRows<AppealRow>(
    db,
    sql`SELECT dispute_id, appellant_user_id, reason, outcome, reasoning,
               reviewed_by_admin_user_id, decided_at, created_at
          FROM dispute_appeals WHERE dispute_id = ${disputeId}`,
  );
  return row ?? null;
}

/**
 * Where a proposed refund has got to — DERIVED by reading spec 022, never stored (DECIDED-5).
 *
 * Storing it would create a second copy of spec 022's truth that could drift the moment a refund
 * failed or reconciled without this spec noticing. Reading it means the dispute can never disagree
 * with the refund record.
 */
export async function resolveRefundState(db: Executor, resolution: ResolutionRow | null): Promise<DisputeRefundState> {
  if (!resolution || resolution.proposed_refund_amount_minor_units === null) return 'none';
  if (!resolution.refund_admin_action_id) return 'proposed';

  const [refund] = await queryRows<{ status: string }>(
    db,
    sql`SELECT status FROM refunds WHERE admin_action_id = ${resolution.refund_admin_action_id} ORDER BY created_at DESC LIMIT 1`,
  );
  if (!refund) return 'initiated';
  if (refund.status === 'completed') return 'completed';
  if (refund.status === 'failed') return 'failed';
  // `requested` and `processing` — including spec 022's deliberately-sticky `unknown` outcome.
  return 'initiated';
}

async function loadAggregate(db: Executor, disputeId: string): Promise<{ aggregate: DisputeAggregate; resolutionRow: ResolutionRow | null }> {
  const resolutionRow = await loadResolutionRow(db, disputeId);
  const appeal = await loadAppealRow(db, disputeId);
  const refundState = await resolveRefundState(db, resolutionRow);

  const [counts] = await queryRows<{ evidence_count: number; message_count: number }>(
    db,
    sql`SELECT (SELECT COUNT(*)::int FROM dispute_evidence WHERE dispute_id = ${disputeId}) AS evidence_count,
               (SELECT COUNT(*)::int FROM dispute_messages WHERE dispute_id = ${disputeId}) AS message_count`,
  );

  const { toResolutionDto } = await import('./rows');
  return {
    resolutionRow,
    aggregate: {
      resolution: resolutionRow ? toResolutionDto(resolutionRow, refundState) : null,
      appeal,
      evidenceCount: counts?.evidence_count ?? 0,
      messageCount: counts?.message_count ?? 0,
      appealWindowEndsAt: resolutionRow ? appealWindowEndsAt(resolutionRow.resolved_at) : null,
    },
  };
}

/** AC-3/AC-4 — the participant's view of one dispute. */
export async function getDisputeForParticipant(disputeId: string, userId: string): Promise<DisputeDto> {
  await resolveParticipantAccess(disputeId, userId);
  const db = getDb();

  const [row] = await queryRows<ParticipantDisputeRow>(
    db,
    sql`SELECT ${sql.raw(PARTICIPANT_COLUMNS)} FROM disputes WHERE id = ${disputeId}`,
  );
  if (!row) throw disputeNotFoundError();

  const { aggregate } = await loadAggregate(db, disputeId);

  // `canAppeal` is this caller's capability, not the dispute's: it is false once anyone has
  // appealed, false outside the window, and false for a dispute that is not `resolved`.
  const windowOpen = aggregate.appealWindowEndsAt !== null && aggregate.appealWindowEndsAt.getTime() > Date.now();
  const canAppeal = row.status === 'resolved' && aggregate.appeal === null && windowOpen;

  return toDisputeDto(row, userId, aggregate, {
    canAppeal,
    canPostMessage: isContributable(row.status),
    canSubmitEvidence: isContributable(row.status),
  });
}

/** The caller's own disputes, newest first. Added during review (DECIDED-11). */
export async function listDisputesForUser(userId: string, page: PageParams): Promise<{ items: DisputeSummaryDto[]; total: number }> {
  const db = getDb();
  const rows = await queryRows<ParticipantDisputeRow>(
    db,
    sql`SELECT ${sql.raw(PARTICIPANT_COLUMNS.split(', ').map((c) => `d.${c}`).join(', '))}
          FROM disputes d
          JOIN bookings b ON b.id = d.booking_id
          JOIN customer_profiles cp ON cp.id = b.customer_profile_id
          JOIN provider_profiles pp ON pp.id = b.provider_profile_id
         WHERE cp.user_id = ${userId} OR pp.user_id = ${userId}
         ORDER BY d.created_at DESC
         LIMIT ${page.limit} OFFSET ${page.offset}`,
  );
  const [count] = await queryRows<{ total: number }>(
    db,
    sql`SELECT COUNT(*)::int AS total
          FROM disputes d
          JOIN bookings b ON b.id = d.booking_id
          JOIN customer_profiles cp ON cp.id = b.customer_profile_id
          JOIN provider_profiles pp ON pp.id = b.provider_profile_id
         WHERE cp.user_id = ${userId} OR pp.user_id = ${userId}`,
  );
  return { items: rows.map(toDisputeSummaryDto), total: count?.total ?? 0 };
}

/** AC-3 — the admin's full view. Audited separately from the queue. */
export async function getDisputeForAdmin(
  disputeId: string,
  adminUserId: string,
  correlationId: string | null,
  requirePermission: (adminUserId: string) => Promise<void>,
): Promise<AdminDisputeDto> {
  const ownership = await resolveAdminAccess(disputeId, adminUserId, requirePermission);
  const db = getDb();

  const [row] = await queryRows<AdminDisputeRow>(
    db,
    sql`SELECT ${sql.raw(ADMIN_COLUMNS)} FROM disputes WHERE id = ${disputeId}`,
  );
  if (!row) throw disputeNotFoundError();

  const { aggregate, resolutionRow } = await loadAggregate(db, disputeId);

  await auditDispute({
    actorUserId: adminUserId,
    eventType: DISPUTE_EVENT_TYPES.detailRead,
    targetId: disputeId,
    correlationId,
  });

  return toAdminDisputeDto(
    row,
    aggregate,
    { customerUserId: ownership.customerUserId, providerUserId: ownership.providerUserId },
    resolutionRow,
  );
}

/**
 * The Trust & Safety queue: live disputes first, then FIFO by `created_at`.
 *
 * FIFO among equals is the same fairness property spec 030's queue has — nothing waits
 * indefinitely because something newer keeps arriving.
 */
export async function listDisputeQueue(
  adminUserId: string,
  page: PageParams,
  correlationId: string | null,
  filters: { status?: ParticipantDisputeRow['status'] } = {},
): Promise<{ items: AdminDisputeSummaryDto[]; total: number }> {
  const db = getDb();
  const statusFilter = filters.status ? sql`WHERE d.status = ${filters.status}` : sql``;

  const rows = await queryRows<AdminQueueRow>(
    db,
    sql`SELECT d.id, d.booking_id, d.status, d.created_at, d.claimed_by_admin_user_id, d.legal_hold,
               (r.proposed_refund_amount_minor_units IS NOT NULL) AS has_proposed_refund
          FROM disputes d
          LEFT JOIN dispute_resolutions r ON r.dispute_id = d.id
          ${statusFilter}
         ORDER BY (d.status = 'closed') ASC, d.created_at ASC
         LIMIT ${page.limit} OFFSET ${page.offset}`,
  );
  const [count] = await queryRows<{ total: number }>(
    db,
    sql`SELECT COUNT(*)::int AS total FROM disputes d ${statusFilter}`,
  );

  await auditDispute({
    actorUserId: adminUserId,
    eventType: DISPUTE_EVENT_TYPES.queueRead,
    targetId: 'queue',
    correlationId,
    details: { returned: rows.length },
  });

  return { items: rows.map(toAdminDisputeSummaryDto), total: count?.total ?? 0 };
}

/**
 * The booking DTO's dispute pointer — the only change this spec makes to spec 020's read surface.
 * Nullable and additive, so no existing consumer breaks.
 */
export async function loadBookingDisputePointer(
  bookingId: string,
): Promise<{ disputeId: string; disputeStatus: ParticipantDisputeRow['status'] } | null> {
  const [row] = await queryRows<{ id: string; status: ParticipantDisputeRow['status'] }>(
    getDb(),
    sql`SELECT id, status FROM disputes WHERE booking_id = ${bookingId} ORDER BY created_at DESC LIMIT 1`,
  );
  return row ? { disputeId: row.id, disputeStatus: row.status } : null;
}
