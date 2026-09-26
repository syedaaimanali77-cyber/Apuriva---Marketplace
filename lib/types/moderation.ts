/**
 * Spec 038 §3.14 — moderation request/response types.
 *
 * The vocabularies are re-exported from `lib/db/schema.ts`, where the CHECK constraints live, so the
 * wire types and the database can never drift apart.
 */
import type {
  ACCOUNT_STANDINGS,
  FRAUD_SIGNAL_SOURCES,
  FRAUD_SIGNAL_STATUSES,
  MODERATION_ACTION_STATUSES,
  MODERATION_ACTION_TYPES,
  MODERATION_APPEAL_STATUSES,
  MODERATION_SCOPES,
} from '@/lib/db/schema';
import type { RiskTier } from '@/lib/types/admin-rbac';

export type ModerationActionType = (typeof MODERATION_ACTION_TYPES)[number];
export type ModerationScope = (typeof MODERATION_SCOPES)[number];
export type ModerationActionStatus = (typeof MODERATION_ACTION_STATUSES)[number];
export type AccountStanding = (typeof ACCOUNT_STANDINGS)[number];
export type FraudSignalSource = (typeof FRAUD_SIGNAL_SOURCES)[number];
export type FraudSignalStatus = (typeof FRAUD_SIGNAL_STATUSES)[number];
export type ModerationAppealStatus = (typeof MODERATION_APPEAL_STATUSES)[number];
export type RefundTreatment = 'policy' | 'full';

export interface CreateModerationActionRequest {
  actionType: ModerationActionType;
  /** `booking` iff `booking_intervention`; `provider_profile` required for `payout_freeze`. */
  scope: ModerationScope;
  /** Always the affected user (`users.id`). */
  targetUserId: string;
  /** Required for scope `provider_profile`; must belong to `targetUserId`. */
  providerProfileId?: string;
  /** Required for `booking_intervention`; `targetUserId` must be a participant. */
  bookingId?: string;
  /** `booking_intervention` only → spec 023 `forceFullRefund` false|true. */
  refundTreatment?: RefundTreatment;
  /** Required, trimmed, 1..500. Internal only — never shown to the target. */
  reason: string;
  /** Optional, ≤500; shown to the target after the standard text for the action type. */
  userMessage?: string;
  /** Marks that signal `actioned`. */
  originFraudSignalId?: string;
}

export interface ModerationActionDto {
  id: string;
  actionType: ModerationActionType;
  scope: ModerationScope;
  targetUserId: string;
  providerProfileId: string | null;
  bookingId: string | null;
  refundTreatment: RefundTreatment | null;
  riskTier: RiskTier;
  status: ModerationActionStatus;
  reason: string;
  userMessage: string | null;
  adminActionId: string | null;
  reversalAdminActionId: string | null;
  previousUserStanding: AccountStanding | null;
  previousProviderLifecycleStatus: string | null;
  originSafetyReportId: string | null;
  originFraudSignalId: string | null;
  initiatedByAdminUserId: string;
  createdAt: string;
  activatedAt: string | null;
  reversedAt: string | null;
}

export interface ModerationApprovalEntryDto {
  decision: 'approved' | 'rejected';
  decidedByAdminUserId: string;
  decidedAt: string;
}

export interface ModerationActionDetailDto extends ModerationActionDto {
  /** Readable only through spec 027's file routes, under the `moderation_evidence` policy. */
  evidenceFileAssetIds: string[];
  approvalChain: ModerationApprovalEntryDto[];
  appeal: ModerationAppealDto | null;
}

/** The moderated user's view: no internal reason, evidence, admin identity or origin. */
export interface MyModerationActionDto {
  id: string;
  actionType: ModerationActionType;
  scope: ModerationScope;
  status: 'active' | 'executed' | 'superseded' | 'reversed';
  userMessage: string | null;
  activatedAt: string;
  appealable: boolean;
  appeal: { status: ModerationAppealStatus; decidedAt: string | null } | null;
}

export interface ReverseModerationActionRequest {
  reason: string;
}

export interface FraudSignalDto {
  id: string;
  targetUserId: string;
  source: FraudSignalSource;
  ruleKey: string;
  observedCount: number;
  threshold: number;
  windowDays: number;
  status: FraudSignalStatus;
  createdAt: string;
  triagedByAdminUserId: string | null;
  triageReason: string | null;
  moderationActionId: string | null;
}

export interface TriageFraudSignalRequest {
  expectedStatus: FraudSignalStatus;
  reason: string;
}

export interface FileModerationAppealRequest {
  statement: string;
}

export interface DecideModerationAppealRequest {
  decision: 'upheld' | 'denied';
  reason: string;
}

export interface ModerationAppealDto {
  id: string;
  moderationActionId: string;
  status: ModerationAppealStatus;
  statement: string;
  /** Admin views only; `null` in the appellant's view. */
  decisionReason: string | null;
  /** Admin views only; `null` in the appellant's view. */
  decidedByAdminUserId: string | null;
  createdAt: string;
  decidedAt: string | null;
}
