/**
 * Spec 032 §3 "Request and response types" — the support domain's public vocabulary and DTOs.
 *
 * TWO AUDIENCES, TWO SHAPES, BY CONSTRUCTION. `SupportTicketDto` (the requester) and
 * `AdminSupportTicketDto` (an admin holding `support/read`) are separate interfaces fed by separate
 * column allowlists in `lib/support/rows.ts`. The participant shape has NO field for an admin
 * identity, the AI summary, the SLA clock, the legal hold or either escalation pointer — so no
 * runtime `if` can leak one, and `lib/support/privacy.test.ts` asserts it over serialized JSON.
 *
 * No server-only import belongs in this file: the support UI imports these constants.
 */

/**
 * §3 "Categories and priority" (DECIDED-4) — the closed category vocabulary, mirrored by
 * `support_tickets_category_ck`. The user picks one; nothing infers it, least of all the AI.
 */
export const SUPPORT_CATEGORIES = [
  'booking',
  'payment',
  'account',
  'provider_quality',
  'technical',
  'safety',
  'other',
] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

/**
 * The SAME four values spec 030 uses (`SAFETY_PRIORITIES`), deliberately. The draft's
 * `'low' | 'medium' | 'high' | 'urgent'` was corrected to the repository's existing vocabulary so
 * the two admin queues rank identically and one shared `Badge` mapping serves both.
 */
export const SUPPORT_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export type SupportPriority = (typeof SUPPORT_PRIORITIES)[number];

/** §3 "Ticket lifecycle" (DECIDED-3). `closed` is terminal. */
export const SUPPORT_TICKET_STATUSES = ['open', 'assigned', 'awaiting_user', 'resolved', 'closed'] as const;
export type SupportTicketStatus = (typeof SUPPORT_TICKET_STATUSES)[number];

/** §3 "Context attachment" (DECIDED-6). Closed: not a request, not an offer, not a review, not a user. */
export const SUPPORT_CONTEXT_TYPES = ['booking', 'payment', 'dispute'] as const;
export type SupportContextType = (typeof SUPPORT_CONTEXT_TYPES)[number];

/** §3 "Support ownership" (DECIDED-1). A `safety` ticket may never be `answered`. */
export const SUPPORT_RESOLUTION_KINDS = ['answered', 'handed_off', 'not_actionable'] as const;
export type SupportResolutionKind = (typeof SUPPORT_RESOLUTION_KINDS)[number];

/** Where a handed-off matter goes. Each target is another spec's workflow, never this one's. */
export const SUPPORT_HANDOFF_TARGETS = ['safety', 'dispute', 'refunds'] as const;
export type SupportHandoffTarget = (typeof SUPPORT_HANDOFF_TARGETS)[number];

export function isSupportCategory(value: unknown): value is SupportCategory {
  return typeof value === 'string' && (SUPPORT_CATEGORIES as readonly string[]).includes(value);
}

export function isSupportPriority(value: unknown): value is SupportPriority {
  return typeof value === 'string' && (SUPPORT_PRIORITIES as readonly string[]).includes(value);
}

export function isSupportTicketStatus(value: unknown): value is SupportTicketStatus {
  return typeof value === 'string' && (SUPPORT_TICKET_STATUSES as readonly string[]).includes(value);
}

export function isSupportContextType(value: unknown): value is SupportContextType {
  return typeof value === 'string' && (SUPPORT_CONTEXT_TYPES as readonly string[]).includes(value);
}

export function isSupportResolutionKind(value: unknown): value is SupportResolutionKind {
  return typeof value === 'string' && (SUPPORT_RESOLUTION_KINDS as readonly string[]).includes(value);
}

export function isSupportHandoffTarget(value: unknown): value is SupportHandoffTarget {
  return typeof value === 'string' && (SUPPORT_HANDOFF_TARGETS as readonly string[]).includes(value);
}

/**
 * The live, re-resolved pointer (DECIDED-6).
 *
 * Carries a NEUTRAL STATUS AND NOTHING ELSE — never an amount, a currency, the counterparty's
 * identity, a dispute reason or a resolution. This is true of the ADMIN projection too: the admin
 * workspace renders a link into the owning spec's own permissioned surface, so this spec widens no
 * existing exposure.
 */
export interface SupportContextDto {
  type: SupportContextType;
  id: string;
  /** `bookings.status` / `payments.status` / `disputes.status`. `null` when unavailable. */
  status: string | null;
  /** False when the object is gone or the caller can no longer reach it. The ticket still reads. */
  available: boolean;
}

/**
 * The REQUESTER's projection (AC-3).
 *
 * Note what is ABSENT and has no field to occupy: `assignedAdminUserId`, `aiSummary`, note content,
 * `legalHold`, `escalatedSafetyReportId`, `escalatedDisputeId`, every idempotency column,
 * `slaDeadlineAt`, `slaBreached` and `requesterUserId`.
 */
export interface SupportTicketDto {
  id: string;
  subject: string;
  category: SupportCategory;
  priority: SupportPriority;
  status: SupportTicketStatus;
  context: SupportContextDto | null;
  /** True once a handoff pointer exists — the FACT, never the target record's id. */
  handedOff: boolean;
  resolutionKind: SupportResolutionKind | null;
  /** The admin's stated reason, which the user is entitled to (master §2.3's reasoning rule). */
  resolutionReason: string | null;
  resolvedAt: string | null;
  /** Present only while `resolved`; an absolute ISO instant, rendered in the viewer's locale. */
  reopenBy: string | null;
  reopenCount: number;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SupportTicketSummaryDto {
  id: string;
  subject: string;
  category: SupportCategory;
  status: SupportTicketStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SupportMessageDto {
  id: string;
  /** Never an admin's identity (AC-3): the user is talking to the platform, not to an individual. */
  author: 'you' | 'support';
  body: string;
  createdAt: string;
}

/** The ADMIN projection (AC-5) — everything master §63 lists, and pointers for the rest. */
export interface AdminSupportTicketDto {
  id: string;
  subject: string;
  description: string;
  category: SupportCategory;
  priority: SupportPriority;
  status: SupportTicketStatus;
  requesterUserId: string;
  requesterMode: 'customer' | 'provider';
  context: SupportContextDto | null;
  assignedAdminUserId: string | null;
  slaDeadlineAt: string;
  slaBreached: boolean;
  slaPausedSeconds: number;
  awaitingUserSince: string | null;
  /**
   * Spec 033 advisory output (DECIDED-2). NO decision path reads this, and it never reaches a
   * participant DTO. `null` whenever AI was unavailable — which changes nothing.
   */
  aiSummary: string | null;
  resolutionKind: SupportResolutionKind | null;
  resolutionReason: string | null;
  handoffTarget: SupportHandoffTarget | null;
  escalatedSafetyReportId: string | null;
  escalatedDisputeId: string | null;
  legalHold: boolean;
  reopenCount: number;
  resolvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface AdminSupportTicketSummaryDto {
  id: string;
  subject: string;
  category: SupportCategory;
  priority: SupportPriority;
  status: SupportTicketStatus;
  assignedAdminUserId: string | null;
  slaDeadlineAt: string;
  slaBreached: boolean;
  createdAt: string;
}

export interface SupportNoteDto {
  id: string;
  authorUserId: string;
  body: string;
  createdAt: string;
}

/**
 * AC-1. `escalationAvailable` is literally typed `true`, so no code path can construct a response
 * that withholds the human escalation — not even by mistake.
 */
export interface SupportAssistantAnswerDto {
  answer: string | null;
  available: boolean;
  escalationAvailable: true;
}
