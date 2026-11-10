/**
 * Spec 031 §3 "Request and response types" — the DTOs, and the privacy boundary they enforce
 * BY CONSTRUCTION rather than by a runtime `if` (DECIDED-10).
 *
 * THE TWO AUDIENCES HAVE STRUCTURALLY DIFFERENT SHAPES. `DisputeDto` cannot leak a user id, an
 * admin id, the AI summary, the approval chain, the safety cross-reference or the legal-hold flag,
 * because it has no field for any of them — the participant query selects a narrower column set and
 * `toDisputeDto` never receives the rest. `AdminDisputeDto` is the only shape that carries them.
 *
 * Every actor a participant can see is projected to a RELATIVE role (`'me'`/`'counterparty'`/
 * `'admin'`), the precedent spec 024's `lib/payouts/privacy.ts` and spec 029's review DTOs set.
 */
import type { DISPUTE_APPEAL_OUTCOMES, DISPUTE_DECISIONS, DISPUTE_STATUSES } from '@/lib/db/schema';

export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];
export type DisputeDecision = (typeof DISPUTE_DECISIONS)[number];
export type DisputeAppealOutcome = (typeof DISPUTE_APPEAL_OUTCOMES)[number];

/** How a participant sees any other person in the dispute. Never an id. */
export type DisputeActorRole = 'me' | 'counterparty' | 'admin';

/**
 * Where a resolution's proposed refund has got to, derived by reading spec 022 — never stored.
 *
 *  - `none`      the decision proposed no refund;
 *  - `proposed`  an amount is recorded but no Finance Admin has initiated it;
 *  - `initiated` an `admin_actions` row exists (awaiting or holding second-admin approval);
 *  - `completed` / `failed` — spec 022's own terminal refund states.
 */
export type DisputeRefundState = 'none' | 'proposed' | 'initiated' | 'completed' | 'failed';

export function isDisputeStatus(value: unknown): value is DisputeStatus {
  return typeof value === 'string' && (['open', 'under_review', 'resolved', 'appealed', 'closed'] as string[]).includes(value);
}

export function isDisputeDecision(value: unknown): value is DisputeDecision {
  return (
    typeof value === 'string' &&
    (['no_action', 'refund_customer', 'partial_refund_customer', 'favour_provider', 'mutual_resolution'] as string[]).includes(value)
  );
}

export function isDisputeAppealOutcome(value: unknown): value is DisputeAppealOutcome {
  return typeof value === 'string' && (['upheld', 'overturned', 'partially_upheld'] as string[]).includes(value);
}

/** Shown to BOTH participants and to admins. Master §2.3: the reasoning, not just the outcome. */
export interface DisputeResolutionDto {
  disputeId: string;
  decision: DisputeDecision;
  reasoning: string;
  resolvedAt: string;
  /** The PROPOSED refund. Null when the decision proposes none. Never a refund id. */
  proposedRefundAmountMinorUnits: number | null;
  proposedRefundCurrencyCode: string | null;
  refundState: DisputeRefundState;
}

export interface DisputeAppealDto {
  disputeId: string;
  filedBy: 'me' | 'counterparty';
  reason: string;
  filedAt: string;
  outcome: DisputeAppealOutcome | null;
  reasoning: string | null;
  decidedAt: string | null;
}

export interface DisputeEvidenceDto {
  id: string;
  fileAssetId: string;
  submittedBy: DisputeActorRole;
  createdAt: string;
}

export interface DisputeMessageDto {
  id: string;
  body: string;
  authorRole: DisputeActorRole;
  isAdmin: boolean;
  createdAt: string;
}

/** The PARTICIPANT view. Deliberately carries no admin identity and no AI summary. */
export interface DisputeDto {
  id: string;
  bookingId: string;
  status: DisputeStatus;
  /** Never the other party's user id (§3 "Privacy and data exposure"). */
  openedBy: 'me' | 'counterparty';
  reason: string;
  createdAt: string;
  evidenceCount: number;
  messageCount: number;
  resolution: DisputeResolutionDto | null;
  appeal: DisputeAppealDto | null;
  /** Null unless `resolved`; the instant after which an appeal is refused. */
  appealWindowEndsAt: string | null;
  canAppeal: boolean;
  canPostMessage: boolean;
  canSubmitEvidence: boolean;
}

export interface DisputeSummaryDto {
  id: string;
  bookingId: string;
  status: DisputeStatus;
  createdAt: string;
}

/** ADMIN-ONLY. The only shape that carries real identities, the AI summary and the approval chain. */
export interface AdminDisputeDto {
  id: string;
  bookingId: string;
  status: DisputeStatus;
  reason: string;
  createdAt: string;
  evidenceCount: number;
  messageCount: number;
  resolution: DisputeResolutionDto | null;
  appeal: DisputeAppealDto | null;
  appealWindowEndsAt: string | null;
  openedByUserId: string;
  customerUserId: string;
  providerUserId: string;
  claimedByAdminUserId: string | null;
  resolvedByAdminUserId: string | null;
  /** Advisory only. Never returned to a participant, never read by a decision. */
  aiSummary: string | null;
  refundAdminActionId: string | null;
  escalatedSafetyReportId: string | null;
  legalHold: boolean;
  version: number;
}

export interface AdminDisputeSummaryDto {
  id: string;
  bookingId: string;
  status: DisputeStatus;
  createdAt: string;
  claimedByAdminUserId: string | null;
  hasProposedRefund: boolean;
  legalHold: boolean;
}
