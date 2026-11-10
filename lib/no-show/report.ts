/**
 * Spec 023 §3 "No-show workflow" (AC-5) — reporting, responding, withdrawing, and reading.
 *
 * The invariant this module exists to protect: **a report produces no consequence.** Creating one
 * moves no money, transitions no booking and blames nobody. It records that a party says the other
 * did not attend, gathers the evidence the platform already holds, and asks the other party to
 * respond. Only `resolution.ts`, called by a Trust & Safety admin, ever sets an outcome.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import { requireBookingParticipant } from '@/lib/bookings/read';
import { emitCancellationNotification } from '@/lib/cancellation/notifications';
import { isUniqueViolation, queryRows, type Executor } from '@/lib/offers/db';
import type { BookingStatus } from '@/lib/types/bookings';
import type {
  AdminNoShowReportDto,
  NoShowEvidence,
  NoShowLocationSignal,
  NoShowOutcome,
  NoShowReportDto,
  NoShowReporterRole,
  NoShowResponseStatus,
  NoShowStatus,
} from '@/lib/types/no-show';
import { deriveLocationSignal, gatherEvidence } from './evidence';
import {
  noShowReportAlreadyExistsError,
  noShowReportAlreadyResolvedError,
  noShowReportNotFoundError,
  noShowReportWindowClosedError,
  noShowResponseAlreadyFiledError,
  noShowSelfActionNotAllowedError,
} from './errors';
import { recordNoShowTransition } from './state-machine';

/**
 * Spec 023 §9 — the reporting and response windows, environment-configurable.
 *
 * `OPENS` exists so a report cannot be filed the instant an appointment starts, before anyone could
 * reasonably be called absent; `CLOSES` bounds how long afterwards a report is meaningful.
 */
export const NO_SHOW_REPORT_OPENS_MINUTES = Number(process.env.NO_SHOW_REPORT_OPENS_MINUTES ?? 15);
export const NO_SHOW_REPORT_CLOSES_HOURS = Number(process.env.NO_SHOW_REPORT_CLOSES_HOURS ?? 72);
export const NO_SHOW_RESPONSE_WINDOW_HOURS = Number(process.env.NO_SHOW_RESPONSE_WINDOW_HOURS ?? 48);

/** The statuses from which a no-show is a coherent claim at all. */
const REPORTABLE_BOOKING_STATUSES: readonly BookingStatus[] = [
  'confirmed',
  'provider_en_route',
  'arrived',
  'in_progress',
];

interface ReportRow {
  id: string;
  booking_id: string;
  reporter_user_id: string;
  reporter_role: NoShowReporterRole;
  status: NoShowStatus;
  reporter_statement: string | null;
  evidence: NoShowEvidence | null;
  location_signal: NoShowLocationSignal;
  respond_by_at: Date;
  response_status: NoShowResponseStatus;
  response_statement: string | null;
  response_filed_at: Date | null;
  outcome: NoShowOutcome | null;
  resolution_reason: string | null;
  resolved_by_admin_id: string | null;
  resolved_at: Date | null;
  counterpart_report_id: string | null;
  escalated: boolean;
  created_at: Date;
  version: number;
}

export const REPORT_COLUMNS = sql`id, booking_id, reporter_user_id, reporter_role, status, reporter_statement,
  evidence, location_signal, respond_by_at, response_status, response_statement, response_filed_at,
  outcome, resolution_reason, resolved_by_admin_id, resolved_at, counterpart_report_id, escalated,
  created_at, version`;

/**
 * The PARTICIPANT view. Carries neither party's statement, no evidence bundle, no location signal
 * and no admin field — a party sees the neutral status and, for their own report, that it exists
 * (AC-10).
 */
export function toParticipantDto(row: ReportRow, callerUserId: string): NoShowReportDto {
  return {
    id: row.id,
    bookingId: row.booking_id,
    reporterRole: row.reporter_role,
    isOwnReport: row.reporter_user_id === callerUserId,
    status: row.status,
    respondByAt: new Date(row.respond_by_at).toISOString(),
    responseFiled: row.response_status === 'filed',
    responseFiledAt: row.response_filed_at ? new Date(row.response_filed_at).toISOString() : null,
    outcome: row.outcome,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    version: row.version,
  };
}

/** The Trust & Safety view. Only ever produced behind a `no_show_reports/read` permission check. */
export function toAdminDto(row: ReportRow): AdminNoShowReportDto {
  return {
    id: row.id,
    bookingId: row.booking_id,
    reporterRole: row.reporter_role,
    status: row.status,
    respondByAt: new Date(row.respond_by_at).toISOString(),
    responseFiled: row.response_status === 'filed',
    responseFiledAt: row.response_filed_at ? new Date(row.response_filed_at).toISOString() : null,
    outcome: row.outcome,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    version: row.version,
    reporterStatement: row.reporter_statement,
    responseStatement: row.response_statement,
    responseStatus: row.response_status,
    locationSignal: row.location_signal,
    evidence: row.evidence,
    resolutionReason: row.resolution_reason,
    resolvedByAdminId: row.resolved_by_admin_id,
    counterpartReportId: row.counterpart_report_id,
    escalated: row.escalated,
  };
}

export async function loadReportRow(tx: Executor, reportId: string, forUpdate = false): Promise<ReportRow | null> {
  const [row] = await queryRows<ReportRow>(
    tx,
    forUpdate
      ? sql`SELECT ${REPORT_COLUMNS} FROM no_show_reports WHERE id = ${reportId} FOR UPDATE`
      : sql`SELECT ${REPORT_COLUMNS} FROM no_show_reports WHERE id = ${reportId}`,
  );
  return row ?? null;
}

export interface ReportNoShowInput {
  userId: string;
  bookingId: string;
  mode: 'customer' | 'provider';
  idempotencyKey: string;
  statement?: string;
}

/**
 * `POST /bookings/{id}/report-no-show`.
 *
 * The row is created `reported` and moved to `awaiting_response` in the SAME transaction, so a
 * report is never left in a state nobody is acting on, and both steps appear in the history — the
 * report's own record of "it was filed, and the other party was asked".
 *
 * Duplicate protection is the database's: `no_show_reports_booking_reporter_uq` admits one report
 * per party per booking, so two simultaneous taps produce one report, not two.
 */
export async function reportNoShow(input: ReportNoShowInput): Promise<NoShowReportDto> {
  const { booking, role } = await requireBookingParticipant(input.userId, input.bookingId, input.mode);

  const fingerprint = idempotencyFingerprint({
    bookingId: input.bookingId,
    reporterRole: role,
    statement: input.statement ?? null,
  });

  const row = await getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM bookings WHERE id = ${input.bookingId} FOR UPDATE`);

    const [existing] = await queryRows<ReportRow & { idempotency_key: string }>(
      tx,
      sql`SELECT ${REPORT_COLUMNS}, idempotency_key FROM no_show_reports
           WHERE booking_id = ${input.bookingId} AND reporter_role = ${role} FOR UPDATE`,
    );
    if (existing) {
      // An identical retry replays; a genuinely second report by the same party is a conflict.
      if (existing.idempotency_key === input.idempotencyKey) return existing;
      throw noShowReportAlreadyExistsError(existing.id);
    }

    const [window] = await queryRows<{ status: BookingStatus; too_early: boolean; too_late: boolean }>(
      tx,
      sql`SELECT status,
                 clock_timestamp() < scheduled_at + make_interval(mins => ${NO_SHOW_REPORT_OPENS_MINUTES}) AS too_early,
                 clock_timestamp() > scheduled_at + make_interval(hours => ${NO_SHOW_REPORT_CLOSES_HOURS}) AS too_late
            FROM bookings WHERE id = ${input.bookingId}`,
    );
    if (!window) throw noShowReportWindowClosedError('unknown_booking');
    if (!REPORTABLE_BOOKING_STATUSES.includes(window.status)) {
      throw noShowReportWindowClosedError(`booking_status_${window.status}`);
    }
    if (window.too_early) throw noShowReportWindowClosedError('before_report_window_opens');
    if (window.too_late) throw noShowReportWindowClosedError('after_report_window_closes');

    const evidence = await gatherEvidence(tx, input.bookingId);
    const locationSignal = await deriveLocationSignal(tx, input.bookingId);

    let inserted: ReportRow;
    try {
      [inserted] = await queryRows<ReportRow>(
        tx,
        sql`INSERT INTO no_show_reports
              (booking_id, reporter_user_id, reporter_role, status, reporter_statement, evidence,
               location_signal, respond_by_at, idempotency_key, idempotency_fingerprint)
            VALUES (${input.bookingId}, ${input.userId}, ${role}, 'reported', ${input.statement ?? null},
                    ${JSON.stringify(evidence)}::jsonb, ${locationSignal},
                    clock_timestamp() + make_interval(hours => ${NO_SHOW_RESPONSE_WINDOW_HOURS}),
                    ${input.idempotencyKey}, ${fingerprint})
            RETURNING ${REPORT_COLUMNS}`,
      ) as [ReportRow];
    } catch (err) {
      if (isUniqueViolation(err, 'no_show_reports_booking_reporter_uq')) {
        const [winner] = await queryRows<ReportRow>(
          tx,
          sql`SELECT ${REPORT_COLUMNS} FROM no_show_reports
               WHERE booking_id = ${input.bookingId} AND reporter_role = ${role}`,
        );
        if (winner) throw noShowReportAlreadyExistsError(winner.id);
      }
      throw err;
    }

    await recordNoShowTransition(tx, {
      reportId: inserted.id,
      from: null,
      to: 'reported',
      actorRole: role,
      actorUserId: input.userId,
    });

    // Both parties may report each other (§3). Link the pair so an admin reviews them together.
    const [counterpart] = await queryRows<{ id: string }>(
      tx,
      sql`SELECT id FROM no_show_reports
           WHERE booking_id = ${input.bookingId} AND id <> ${inserted.id} LIMIT 1`,
    );
    if (counterpart) {
      await tx.execute(
        sql`UPDATE no_show_reports SET counterpart_report_id = ${counterpart.id}, updated_at = clock_timestamp()
             WHERE id = ${inserted.id}`,
      );
      await tx.execute(
        sql`UPDATE no_show_reports SET counterpart_report_id = ${inserted.id}, updated_at = clock_timestamp()
             WHERE id = ${counterpart.id}`,
      );
    }

    const moved = await advanceStatus(tx, inserted.id, 'reported', 'awaiting_response', {
      actorRole: role,
      actorUserId: input.userId,
    });
    return moved ?? inserted;
  });

  const otherPartyUserId = await counterpartyUserId(input.bookingId, role);
  void emitCancellationNotification({
    kind: 'no_show_reported',
    reportId: row.id,
    bookingId: input.bookingId,
    recipientUserId: otherPartyUserId,
  });
  void emitCancellationNotification({
    kind: 'no_show_response_requested',
    reportId: row.id,
    recipientUserId: otherPartyUserId,
    respondByAt: new Date(row.respond_by_at).toISOString(),
  });

  console.log(
    JSON.stringify({ event: 'no_show.reported', reportId: row.id, bookingId: input.bookingId, reporterRole: role }),
  );
  void booking;
  return toParticipantDto(row, input.userId);
}

/** The user id of whichever party did NOT file the report. */
async function counterpartyUserId(bookingId: string, reporterRole: NoShowReporterRole): Promise<string> {
  const [row] = await queryRows<{ customer_user_id: string; provider_user_id: string }>(
    getDb(),
    sql`SELECT cp.user_id AS customer_user_id, pp.user_id AS provider_user_id
          FROM bookings b
          JOIN customer_profiles cp ON cp.id = b.customer_profile_id
          JOIN provider_profiles pp ON pp.id = b.provider_profile_id
         WHERE b.id = ${bookingId}`,
  );
  if (!row) throw noShowReportNotFoundError();
  return reporterRole === 'customer' ? row.provider_user_id : row.customer_user_id;
}

/** One status move plus its history row, conditional on the expected status. */
export async function advanceStatus(
  tx: Executor,
  reportId: string,
  from: NoShowStatus,
  to: NoShowStatus,
  actor: { actorRole: 'customer' | 'provider' | 'admin' | 'system'; actorUserId: string | null },
  extra?: { detail?: string },
): Promise<ReportRow | null> {
  const [updated] = await queryRows<ReportRow>(
    tx,
    sql`UPDATE no_show_reports SET status = ${to}, updated_at = clock_timestamp(), version = version + 1
         WHERE id = ${reportId} AND status = ${from}
         RETURNING ${REPORT_COLUMNS}`,
  );
  if (!updated) return null;

  await recordNoShowTransition(tx, {
    reportId,
    from,
    to,
    actorRole: actor.actorRole,
    actorUserId: actor.actorUserId,
    detail: extra?.detail,
  });
  return updated;
}

export interface RespondInput {
  userId: string;
  reportId: string;
  statement?: string;
}

/**
 * `POST /no-show-reports/{id}/respond` — the other party's answer.
 *
 * The reporter is refused `403 NO_SHOW_SELF_ACTION_NOT_ALLOWED`, not `404`: they can legitimately
 * see this report (it is theirs), so hiding it would be misleading rather than protective. A caller
 * who is neither party gets `404`, because for them the report genuinely does not exist.
 */
export async function respondToNoShow(input: RespondInput): Promise<NoShowReportDto> {
  const row = await getDb().transaction(async (tx) => {
    const report = await loadReportRow(tx, input.reportId, true);
    if (!report) throw noShowReportNotFoundError();

    const { role } = await requireBookingParticipant(input.userId, report.booking_id, undefined, tx);
    if (report.reporter_user_id === input.userId) throw noShowSelfActionNotAllowedError();
    void role;

    if (report.status === 'resolved' || report.status === 'withdrawn') throw noShowReportAlreadyResolvedError();
    if (report.response_status === 'filed') throw noShowResponseAlreadyFiledError();
    if (report.status !== 'awaiting_response') throw noShowResponseAlreadyFiledError();

    await tx.execute(
      sql`UPDATE no_show_reports
             SET response_status = 'filed',
                 response_statement = ${input.statement ?? null},
                 response_filed_at = clock_timestamp(),
                 updated_at = clock_timestamp()
           WHERE id = ${input.reportId}`,
    );

    const moved = await advanceStatus(tx, input.reportId, 'awaiting_response', 'under_review', {
      actorRole: report.reporter_role === 'customer' ? 'provider' : 'customer',
      actorUserId: input.userId,
    });
    if (!moved) throw noShowResponseAlreadyFiledError();
    return moved;
  });

  console.log(JSON.stringify({ event: 'no_show.responded', reportId: row.id, bookingId: row.booking_id }));
  return toParticipantDto(row, input.userId);
}

/**
 * `POST /no-show-reports/{id}/withdraw` — the reporter retracting, while the other party has not
 * yet been put to the trouble of responding. Only the reporter, and only from `awaiting_response`.
 */
export async function withdrawNoShow(userId: string, reportId: string): Promise<NoShowReportDto> {
  const row = await getDb().transaction(async (tx) => {
    const report = await loadReportRow(tx, reportId, true);
    if (!report) throw noShowReportNotFoundError();
    await requireBookingParticipant(userId, report.booking_id, undefined, tx);
    if (report.reporter_user_id !== userId) throw noShowSelfActionNotAllowedError();
    if (report.status !== 'awaiting_response') throw noShowReportAlreadyResolvedError();

    const moved = await advanceStatus(tx, reportId, 'awaiting_response', 'withdrawn', {
      actorRole: report.reporter_role,
      actorUserId: userId,
    });
    if (!moved) throw noShowReportAlreadyResolvedError();
    return moved;
  });

  return toParticipantDto(row, userId);
}

/** `GET /bookings/{id}/no-show-reports` — each party's own view of every report on the booking. */
export async function listReportsForBooking(userId: string, bookingId: string): Promise<NoShowReportDto[]> {
  await requireBookingParticipant(userId, bookingId);
  const rows = await queryRows<ReportRow>(
    getDb(),
    sql`SELECT ${REPORT_COLUMNS} FROM no_show_reports WHERE booking_id = ${bookingId} ORDER BY created_at DESC`,
  );
  return rows.map((row) => toParticipantDto(row, userId));
}
