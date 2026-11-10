/**
 * Spec 032 §3 "Support ownership" (AC-9, DECIDED-1) — the one-way door out of support.
 *
 * THIS IS THE WHOLE OF WHAT SUPPORT CAN DO ABOUT A CONSEQUENTIAL MATTER. It records a POINTER and
 * sets a legal hold. It decides nothing:
 *
 *   - `safety`  — files a report through spec 030's OWN `createSafetyReport()`. No sanction, no
 *                 restriction, no `users.lifecycle_status` write. Spec 030's queue takes it from
 *                 there, at spec 030's own default priority, set by spec 030's own humans.
 *   - `dispute` — records the id of a dispute A PARTICIPANT ALREADY OPENED through spec 031's own
 *                 route. This spec creates no dispute, resolves none, and reads no reasoning: the
 *                 id is checked for existence and nothing about the dispute is projected.
 *   - `refunds` — records the intent and stops. Finance acts through spec 022's existing
 *                 `POST /api/v1/admin/refunds` four-eyes chain. No `refunds` row, no amount, no
 *                 provider call, no column of spec 022's touched.
 *
 * A HANDOFF IS NOT A TRANSITION. It records where the matter went; it does not move the ticket's
 * status. The admin resolves the ticket separately, as `handed_off`, when support's part is
 * finished. So the write below is a status-PRESERVING guarded update rather than a call through
 * `applyTransition()` — the transition table stays the authority for status, and nothing here
 * sneaks past it.
 *
 * NOTHING COMES BACK. The specialised record's outcome is never mirrored onto the ticket, because
 * two records of one decision can disagree and the participant already sees the real one in the
 * owning workflow.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { createSafetyReport } from '@/lib/safety';
import type { AdminSupportTicketDto } from '@/lib/types/support';
import { projectContext } from './context';
import { supportResolutionInvalidError, supportStatusConflictError } from './errors';
import { loadTicketRow } from './lifecycle';
import { auditSupport, SUPPORT_EVENT_TYPES } from './audit';
import { ADMIN_COLUMNS, toAdminSupportTicketDto, type AdminTicketRow } from './rows';
import { isTriageableStatus } from './transitions';
import type { ParsedHandOff } from './validation';

/**
 * Spec 030's report is filed as the TICKET'S REQUESTER, not as the acting admin.
 *
 * It is their account of what happened, so spec 030's reporter-facing reads
 * (`getSafetyReportForReporter`) correctly show it back to them, and an admin never appears in
 * spec 030's reporter queue views for a matter they merely relayed. The admin's involvement is
 * captured where it belongs — in the `support.handed_off` audit event.
 *
 * The category is ALWAYS `other`. Support does not classify a safety matter: it hands over the
 * facts and spec 030's own humans categorise and prioritise. This is spec 030's DECIDED-1 rule
 * (nothing derives severity) and spec 032's own rule (support owns the conversation, not the
 * consequence) agreeing with each other.
 *
 * The booking is linked only when the TICKET'S OWN CONTEXT is a booking — giving spec 030 the
 * linkage it already models, without inventing one where the ticket has none.
 */
async function fileSafetyReport(
  current: AdminTicketRow,
  request: ParsedHandOff,
  ticketId: string,
): Promise<string> {
  const bookingId = current.context_type === 'booking' ? current.context_id : null;

  const { report } = await createSafetyReport(
    current.requester_user_id,
    {
      targetUserId: request.targetUserId!,
      category: 'other',
      description: request.reason,
      bookingId,
    },
    // Deterministic, so a retried handoff replays spec 030's own idempotency rather than filing a
    // second report about the same thing.
    { key: `support-handoff:${ticketId}`, fingerprint: `support-handoff:${ticketId}` },
  );
  return report.id;
}

export async function handOffTicket(input: {
  adminUserId: string;
  ticketId: string;
  request: ParsedHandOff;
  correlationId: string | null;
}): Promise<AdminSupportTicketDto> {
  const db = getDb();
  const current = await loadTicketRow(input.ticketId, db);

  // A resolved or closed ticket is past the point of handing anywhere.
  if (!isTriageableStatus(current.status)) throw supportStatusConflictError(current.status);
  if (current.status !== input.request.expectedStatus) throw supportStatusConflictError(current.status);

  let safetyReportId: string | null = null;
  let disputeId: string | null = null;

  if (input.request.target === 'safety') {
    safetyReportId = await fileSafetyReport(current, input.request, input.ticketId);
  } else if (input.request.target === 'dispute') {
    // Existence only. Nothing about the dispute is read beyond its id — not its status, not its
    // reason, not its resolution, and none of it is ever projected to anyone through this spec.
    const [row] = await queryRows<{ id: string }>(
      db,
      sql`SELECT id FROM disputes WHERE id = ${input.request.disputeId}`,
    );
    if (!row) throw supportResolutionInvalidError('That dispute does not exist.');
    disputeId = row.id;
  }

  // Status-preserving and guarded on it, so a concurrent transition still loses cleanly.
  //
  // `handoff_target` is DELIBERATELY NOT written here. It is the RESOLUTION's field — paired with
  // `resolution_kind = 'handed_off'` by `support_tickets_handoff_pairing_ck` — and setting it while
  // the ticket is still live would leave the pair half-formed and hollow out that constraint. The
  // handoff's record is the pointer, the legal hold and the `support.handed_off` audit event; the
  // admin then resolves the ticket as `handed_off` when support's part is actually finished.
  const updated = await queryRows<AdminTicketRow>(
    db,
    sql`UPDATE support_tickets
           SET escalated_safety_report_id = coalesce(${safetyReportId}, escalated_safety_report_id),
               escalated_dispute_id = coalesce(${disputeId}, escalated_dispute_id),
               legal_hold = true,
               updated_at = clock_timestamp(),
               version = version + 1
         WHERE id = ${input.ticketId} AND status = ${input.request.expectedStatus}
        RETURNING ${sql.raw(ADMIN_COLUMNS)}`,
  );

  if (!updated[0]) throw supportStatusConflictError((await loadTicketRow(input.ticketId, db)).status);

  await auditSupport({
    adminUserId: input.adminUserId,
    eventType: SUPPORT_EVENT_TYPES.handedOff,
    targetId: input.ticketId,
    correlationId: input.correlationId,
    reason: input.request.reason,
    details: { target: input.request.target, safetyReportId, disputeId },
  });

  const context = await projectContext(input.adminUserId, updated[0].context_type, updated[0].context_id, {
    viewerIsAdmin: true,
  });
  return toAdminSupportTicketDto(updated[0], context);
}
