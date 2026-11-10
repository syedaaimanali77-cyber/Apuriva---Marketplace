/**
 * Spec 032 §3 "Privacy and data exposure" (AC-3, DECIDED-11) — row → DTO mapping, and the column
 * allowlists that make the two audiences structurally different rather than differing by a runtime
 * `if`.
 *
 * THE REQUESTER AND THE ADMIN GET DIFFERENT SHAPES BY CONSTRUCTION. `toSupportTicketDto` cannot
 * leak the assigned admin, the AI summary, the SLA clock, the legal hold or either escalation
 * pointer, because it NEVER RECEIVES THEM — the participant query selects a narrower column set
 * (`PARTICIPANT_COLUMNS`) and `SupportTicketDto` has no field to put them in.
 *
 * `support_notes` HAS NO MAPPER ON THE PARTICIPANT SIDE AT ALL. There is no function here that
 * turns a note row into anything a requester could receive, which is the structural half of AC-3;
 * `lib/support/privacy.test.ts` asserts the other half over serialized JSON, because a type
 * assertion cannot catch a stray `SELECT *`.
 */
import type {
  AdminSupportTicketDto,
  AdminSupportTicketSummaryDto,
  SupportCategory,
  SupportContextDto,
  SupportHandoffTarget,
  SupportMessageDto,
  SupportNoteDto,
  SupportPriority,
  SupportResolutionKind,
  SupportTicketDto,
  SupportTicketStatus,
  SupportTicketSummaryDto,
} from '@/lib/types/support';
import { reopenWindowEndsAt } from './reopen-window';
import { isSlaBreached } from './sla';

/**
 * The columns a REQUESTER may see. Deliberately missing everything operations-internal.
 *
 * `description` is included because they wrote it. `resolution_reason` is included because a user
 * is entitled to the reason for a decision about them (master §2.3).
 */
export const PARTICIPANT_COLUMNS = `id, subject, category, priority, status, context_type, context_id,
  resolution_kind, resolution_reason, handoff_target, escalated_safety_report_id, escalated_dispute_id,
  reopen_count, resolved_at, created_at, updated_at`;

/** The columns an ADMIN may see, behind `support/read`. */
export const ADMIN_COLUMNS = `id, requester_user_id, requester_mode, subject, description, category, priority,
  status, context_type, context_id, assigned_admin_user_id, sla_deadline_at, sla_paused_seconds,
  awaiting_user_since, ai_summary, resolution_kind, resolution_reason, handoff_target,
  escalated_safety_report_id, escalated_dispute_id, legal_hold, reopen_count, resolved_at, closed_at,
  created_at, updated_at, version`;

export interface ParticipantTicketRow {
  id: string;
  subject: string;
  category: SupportCategory;
  priority: SupportPriority;
  status: SupportTicketStatus;
  context_type: string | null;
  context_id: string | null;
  resolution_kind: SupportResolutionKind | null;
  resolution_reason: string | null;
  handoff_target: SupportHandoffTarget | null;
  escalated_safety_report_id: string | null;
  escalated_dispute_id: string | null;
  reopen_count: number;
  resolved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface AdminTicketRow extends ParticipantTicketRow {
  requester_user_id: string;
  requester_mode: 'customer' | 'provider';
  description: string;
  assigned_admin_user_id: string | null;
  sla_deadline_at: Date;
  sla_paused_seconds: number;
  awaiting_user_since: Date | null;
  ai_summary: string | null;
  legal_hold: boolean;
  closed_at: Date | null;
  version: number;
}

export interface SupportMessageRow {
  id: string;
  sender_user_id: string;
  body: string;
  is_admin: boolean;
  created_at: Date;
}

export interface SupportNoteRow {
  id: string;
  author_user_id: string;
  body: string;
  created_at: Date;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isoRequired(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * The REQUESTER's ticket.
 *
 * `handedOff` is a BOOLEAN, never the pointer id: the user learns their matter was passed on, which
 * is true and useful, without learning the identifier of a safety report or dispute record they may
 * have no standing to see.
 */
export function toSupportTicketDto(
  row: ParticipantTicketRow,
  context: SupportContextDto | null,
  messageCount: number,
): SupportTicketDto {
  return {
    id: row.id,
    subject: row.subject,
    category: row.category,
    priority: row.priority,
    status: row.status,
    context,
    handedOff: row.escalated_safety_report_id !== null || row.escalated_dispute_id !== null || row.handoff_target !== null,
    resolutionKind: row.resolution_kind,
    resolutionReason: row.resolution_reason,
    resolvedAt: iso(row.resolved_at),
    // Only meaningful while the ticket is reopenable; `null` once it is closed.
    reopenBy: row.status === 'resolved' ? iso(reopenWindowEndsAt(row.resolved_at)) : null,
    reopenCount: row.reopen_count,
    messageCount,
    createdAt: isoRequired(row.created_at),
    updatedAt: isoRequired(row.updated_at),
  };
}

export function toSupportTicketSummaryDto(row: ParticipantTicketRow): SupportTicketSummaryDto {
  return {
    id: row.id,
    subject: row.subject,
    category: row.category,
    status: row.status,
    createdAt: isoRequired(row.created_at),
    updatedAt: isoRequired(row.updated_at),
  };
}

/** The ADMIN's ticket (AC-5) — everything master §63 lists, and pointers for the rest. */
export function toAdminSupportTicketDto(
  row: AdminTicketRow,
  context: SupportContextDto | null,
  now: Date = new Date(),
): AdminSupportTicketDto {
  return {
    id: row.id,
    subject: row.subject,
    description: row.description,
    category: row.category,
    priority: row.priority,
    status: row.status,
    requesterUserId: row.requester_user_id,
    requesterMode: row.requester_mode,
    context,
    assignedAdminUserId: row.assigned_admin_user_id,
    slaDeadlineAt: isoRequired(row.sla_deadline_at),
    slaBreached: isSlaBreached(row.status, new Date(row.sla_deadline_at), now),
    slaPausedSeconds: row.sla_paused_seconds,
    awaitingUserSince: iso(row.awaiting_user_since),
    aiSummary: row.ai_summary,
    resolutionKind: row.resolution_kind,
    resolutionReason: row.resolution_reason,
    handoffTarget: row.handoff_target,
    escalatedSafetyReportId: row.escalated_safety_report_id,
    escalatedDisputeId: row.escalated_dispute_id,
    legalHold: row.legal_hold,
    reopenCount: row.reopen_count,
    resolvedAt: iso(row.resolved_at),
    closedAt: iso(row.closed_at),
    createdAt: isoRequired(row.created_at),
    updatedAt: isoRequired(row.updated_at),
    version: row.version,
  };
}

export function toAdminSupportTicketSummaryDto(row: AdminTicketRow, now: Date = new Date()): AdminSupportTicketSummaryDto {
  return {
    id: row.id,
    subject: row.subject,
    category: row.category,
    priority: row.priority,
    status: row.status,
    assignedAdminUserId: row.assigned_admin_user_id,
    slaDeadlineAt: isoRequired(row.sla_deadline_at),
    slaBreached: isSlaBreached(row.status, new Date(row.sla_deadline_at), now),
    createdAt: isoRequired(row.created_at),
  };
}

/**
 * A thread message, projected to a RELATIVE author.
 *
 * This is the single place that decision is made. A requester never receives an admin's user id or
 * name — they are talking to the platform, not to a named individual, and an admin who replies is
 * not thereby exposed to someone who may be angry with them.
 */
export function toSupportMessageDto(row: SupportMessageRow, viewerUserId: string): SupportMessageDto {
  return {
    id: row.id,
    author: row.is_admin ? 'support' : row.sender_user_id === viewerUserId ? 'you' : 'support',
    body: row.body,
    createdAt: isoRequired(row.created_at),
  };
}

/**
 * An internal note. ADMIN-ONLY BY CONSTRUCTION: this is the only mapper for a note row, and it is
 * reachable only from `lib/support/admin-read.ts`, which every caller reaches through
 * `requireSupportReadPermission()`.
 */
export function toSupportNoteDto(row: SupportNoteRow): SupportNoteDto {
  return {
    id: row.id,
    authorUserId: row.author_user_id,
    body: row.body,
    createdAt: isoRequired(row.created_at),
  };
}
