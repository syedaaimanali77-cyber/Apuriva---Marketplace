/**
 * Spec 023 §3 "Admin resolution" (AC-5, AC-9) — the ONLY place a no-show outcome is ever set.
 *
 * Three properties this module exists to guarantee:
 *
 *  1. **No automatic accusation.** Nothing else in `lib/no-show/**` writes `outcome`. No timer, no
 *     sweep, no timestamp comparison and no location value can produce a fault finding — only an
 *     authenticated Trust & Safety admin choosing from a closed set (master spec §51).
 *  2. **No consequence before the other party was heard.** A resolution attempted while the report
 *     is still `awaiting_response` and the window has not elapsed is refused outright.
 *  3. **No location-based fault.** This function takes no location argument at all, and reads none.
 *     The signal exists for the admin to look at; it cannot reach the decision path.
 *
 * Authorization is spec 009's existing model at the `medium` tier, so a single authorized admin
 * resolves and the action is audited — no `AdminAction`, no second approval framework. The admin
 * never chooses an amount: the financial consequence is computed by spec 023 from the booking's own
 * snapshotted policy version.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { recordAdminAuditEvent } from '@/lib/admin-rbac/audit';
import { adminForbiddenError } from '@/lib/admin-rbac/errors';
import { getAdminProfileId, getAdminRoleNames, resolvePermission } from '@/lib/admin-rbac/permissions';
import { cancelBooking, isCancellableBookingStatus } from '@/lib/cancellation/cancel';
import { emitCancellationNotification } from '@/lib/cancellation/notifications';
import { isUniqueViolation, queryRows } from '@/lib/offers/db';
import type { BookingStatus } from '@/lib/types/bookings';
import { NO_SHOW_OUTCOMES, isFaultOutcome, type NoShowOutcome } from '@/lib/types/no-show';
import type { AdminNoShowReportDto } from '@/lib/types/no-show';
import {
  noShowFaultAlreadyRecordedError,
  noShowOutcomeInvalidError,
  noShowReportAlreadyResolvedError,
  noShowReportNotFoundError,
  noShowResponseRequiredError,
  noShowSelfActionNotAllowedError,
} from './errors';
import { loadReportRow, toAdminDto, REPORT_COLUMNS } from './report';
import { emitReliabilitySignal } from './reliability';
import { recordNoShowTransition } from './state-machine';

export const NO_SHOW_RESOURCE = 'no_show_reports';
export const NO_SHOW_READ_ACTION = 'read';
export const NO_SHOW_RESOLVE_ACTION = 'resolve';

async function requireNoShowPermission(adminUserId: string, action: string): Promise<void> {
  const decision = await resolvePermission(adminUserId, NO_SHOW_RESOURCE, action);
  if (!decision.allowed) throw adminForbiddenError();
}

export async function requireNoShowReadPermission(adminUserId: string): Promise<void> {
  await requireNoShowPermission(adminUserId, NO_SHOW_READ_ACTION);
}

export async function requireNoShowResolvePermission(adminUserId: string): Promise<void> {
  await requireNoShowPermission(adminUserId, NO_SHOW_RESOLVE_ACTION);
}

/**
 * What each outcome does to the booking and the money. A CLOSED mapping — an admin picks a row of
 * this table, never an amount.
 *
 * `no_show_confirmed_provider` forces a full refund regardless of tier: a customer must never pay a
 * timing fee because the provider did not attend. `no_fault` does the same, because nobody has been
 * found at fault and the customer should not bear a fee for it. `inconclusive` and
 * `escalated_to_dispute` deliberately change nothing financial — an undecided report is not a
 * silent finding against either party, and spec 031 owns whatever comes next.
 */
const CONSEQUENCE: Record<NoShowOutcome, { cancel: boolean; forceFullRefund: boolean; escalated: boolean }> = {
  no_show_confirmed_customer: { cancel: true, forceFullRefund: false, escalated: false },
  no_show_confirmed_provider: { cancel: true, forceFullRefund: true, escalated: false },
  no_fault: { cancel: true, forceFullRefund: true, escalated: false },
  inconclusive: { cancel: false, forceFullRefund: false, escalated: false },
  escalated_to_dispute: { cancel: false, forceFullRefund: false, escalated: true },
};

export interface ResolveNoShowInput {
  adminUserId: string;
  reportId: string;
  outcome: NoShowOutcome;
  reason: string;
}

/**
 * Resolves one report.
 *
 * Ordering matters: the booking is cancelled FIRST (inside `cancelBooking`, under the booking row
 * lock, through spec 020's transition primitive), then the report is marked `resolved` by a
 * conditional update. A second resolver's update matches zero rows and is refused `409` — the same
 * "exactly one winner" shape spec 009 uses for approvals, without a new mechanism.
 *
 * An already-`cancelled` booking is not an error here: the fault finding is still meaningful, and a
 * cancellation racing a resolution should not lose the Trust & Safety decision (§3 "Idempotency and
 * concurrency").
 */
export async function resolveNoShowReport(input: ResolveNoShowInput): Promise<AdminNoShowReportDto> {
  if (!NO_SHOW_OUTCOMES.includes(input.outcome)) {
    throw noShowOutcomeInvalidError('outcome', `must be one of: ${NO_SHOW_OUTCOMES.join(', ')}`);
  }
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
    throw noShowOutcomeInvalidError('reason', 'is required');
  }

  await requireNoShowResolvePermission(input.adminUserId);
  const adminProfileId = await getAdminProfileId(input.adminUserId);
  if (!adminProfileId) throw adminForbiddenError();

  const report = await loadReportRow(getDb(), input.reportId);
  if (!report) throw noShowReportNotFoundError();
  // Structural rather than hypothetical: an admin is never a booking participant in practice, but
  // the reporter must never be the resolver under any circumstances (AC-9).
  if (report.reporter_user_id === input.adminUserId) throw noShowSelfActionNotAllowedError();

  if (report.status === 'resolved' || report.status === 'withdrawn') throw noShowReportAlreadyResolvedError();
  if (report.status !== 'under_review') {
    // AC-5 at the API surface: the other party has not been heard and their window has not elapsed.
    throw noShowResponseRequiredError(new Date(report.respond_by_at).toISOString());
  }

  const consequence = CONSEQUENCE[input.outcome];

  // AC-6 "exactly once": refuse early and clearly if the counterpart report already carries fault.
  // The partial unique index is the real guarantee; this turns it into a good error message.
  if (isFaultOutcome(input.outcome)) {
    const [existingFault] = await queryRows<{ id: string }>(
      getDb(),
      sql`SELECT id FROM no_show_reports
           WHERE booking_id = ${report.booking_id}
             AND id <> ${input.reportId}
             AND outcome IN ('no_show_confirmed_customer','no_show_confirmed_provider')
           LIMIT 1`,
    );
    if (existingFault) throw noShowFaultAlreadyRecordedError();
  }

  if (consequence.cancel) {
    const [booking] = await queryRows<{ status: BookingStatus }>(
      getDb(),
      sql`SELECT status FROM bookings WHERE id = ${report.booking_id}`,
    );
    if (booking && isCancellableBookingStatus(booking.status)) {
      await cancelBooking({
        bookingId: report.booking_id,
        idempotencyKey: `no-show-${input.reportId}`,
        actorUserId: input.adminUserId,
        actorRole: 'admin',
        body: { reasonCode: `no_show_${input.outcome}` },
        noShowReportId: input.reportId,
        forceFullRefund: consequence.forceFullRefund,
      });
    }
    // An already-cancelled (or already-progressed) booking is left exactly as it is: the outcome
    // below still records the Trust & Safety finding, which is the part that must not be lost.
  }

  const resolved = await getDb().transaction(async (tx) => {
    let updated;
    try {
      [updated] = await queryRows<Parameters<typeof toAdminDto>[0]>(
        tx,
        sql`UPDATE no_show_reports
               SET status = 'resolved',
                   outcome = ${input.outcome},
                   resolution_reason = ${input.reason},
                   resolved_by_admin_id = ${adminProfileId},
                   resolved_at = clock_timestamp(),
                   escalated = ${consequence.escalated},
                   updated_at = clock_timestamp(),
                   version = version + 1
             WHERE id = ${input.reportId} AND status = 'under_review'
             RETURNING ${REPORT_COLUMNS}`,
      );
    } catch (err) {
      if (isUniqueViolation(err, 'no_show_reports_booking_fault_uq')) throw noShowFaultAlreadyRecordedError();
      throw err;
    }
    if (!updated) throw noShowReportAlreadyResolvedError();

    await recordNoShowTransition(tx, {
      reportId: input.reportId,
      from: 'under_review',
      to: 'resolved',
      actorRole: 'admin',
      actorUserId: input.adminUserId,
      detail: input.outcome,
    });

    return updated;
  });

  await recordAdminAuditEvent({
    actorUserId: input.adminUserId,
    actorRoles: await getAdminRoleNames(input.adminUserId),
    eventType: 'admin_rbac.no_show_resolved',
    resource: NO_SHOW_RESOURCE,
    action: NO_SHOW_RESOLVE_ACTION,
    targetType: 'no_show_report',
    targetId: input.reportId,
    reason: input.reason,
    // A `medium`-tier action needs no approval, so the chain is empty by definition (spec 009).
    approvalChain: [],
  });

  if (isFaultOutcome(input.outcome)) {
    await emitReliabilitySignal({
      reportId: input.reportId,
      bookingId: report.booking_id,
      outcome: input.outcome,
    });
  }

  for (const recipientUserId of await bookingParties(report.booking_id)) {
    void emitCancellationNotification({
      kind: 'no_show_resolved',
      reportId: input.reportId,
      recipientUserId,
      outcome: input.outcome,
    });
  }

  console.log(
    JSON.stringify({
      event: 'no_show.resolved',
      reportId: input.reportId,
      bookingId: report.booking_id,
      outcome: input.outcome,
    }),
  );

  return toAdminDto(resolved);
}

async function bookingParties(bookingId: string): Promise<string[]> {
  const [row] = await queryRows<{ customer_user_id: string; provider_user_id: string }>(
    getDb(),
    sql`SELECT cp.user_id AS customer_user_id, pp.user_id AS provider_user_id
          FROM bookings b
          JOIN customer_profiles cp ON cp.id = b.customer_profile_id
          JOIN provider_profiles pp ON pp.id = b.provider_profile_id
         WHERE b.id = ${bookingId}`,
  );
  return row ? [row.customer_user_id, row.provider_user_id] : [];
}

/** `GET /admin/no-show-reports` — the Trust & Safety queue. */
export async function listNoShowReportsForAdmin(filters: {
  status?: string;
  outcome?: string;
  limit: number;
  offset: number;
}): Promise<AdminNoShowReportDto[]> {
  const rows = await queryRows<Parameters<typeof toAdminDto>[0]>(
    getDb(),
    sql`SELECT ${REPORT_COLUMNS} FROM no_show_reports
         WHERE (${filters.status ?? null}::text IS NULL OR status = ${filters.status ?? null})
           AND (${filters.outcome ?? null}::text IS NULL OR outcome = ${filters.outcome ?? null})
         ORDER BY created_at DESC
         LIMIT ${filters.limit} OFFSET ${filters.offset}`,
  );
  return rows.map(toAdminDto);
}

/** `GET /admin/no-show-reports/{id}` — the full evidence bundle for review. */
export async function readNoShowReportForAdmin(reportId: string): Promise<AdminNoShowReportDto> {
  const row = await loadReportRow(getDb(), reportId);
  if (!row) throw noShowReportNotFoundError();
  return toAdminDto(row);
}
