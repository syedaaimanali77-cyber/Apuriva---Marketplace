/**
 * Spec 038 §3.3 / §3.9 — the action catalogue as data: which spec 009 permission each action type
 * needs, which types must go through four-eyes, what each does to standing, and what can be
 * appealed or reversed. Pure; no I/O.
 */
import type { ModerationActionType } from '@/lib/types/moderation';
import type { Standing } from './standing';

export const MODERATION_RESOURCE = 'moderation';
export const FRAUD_SIGNALS_RESOURCE = 'fraud_signals';

export const MODERATION_READ_ACTION = 'read';
export const MODERATION_REVERSE_ACTION = 'reverse';
export const MODERATION_REVIEW_APPEAL_ACTION = 'review_appeal';
export const FRAUD_SIGNALS_READ_ACTION = 'read';
export const FRAUD_SIGNALS_TRIAGE_ACTION = 'triage';

/** §3.9 — the spec 009 `(moderation, action)` each action type is initiated, approved and executed under. */
export const PERMISSION_ACTION_FOR: Record<ModerationActionType, string> = {
  warning: 'warn',
  restriction: 'restrict',
  suspension: 'suspend',
  ban: 'ban',
  booking_intervention: 'intervene_booking',
  payout_freeze: 'freeze_payout',
};

/**
 * AC-2: types seeded high/critical. For these, `authorizeAndInitiate()` resolving to anything but
 * `pending_approval` FAILS CLOSED (`422 APPROVAL_REQUIRED`), so a mis-seeded tier can never quietly
 * remove the second admin — the guard `lib/payouts/admin.ts` established.
 */
export const REQUIRES_APPROVAL: ReadonlySet<ModerationActionType> = new Set(['suspension', 'ban', 'booking_intervention', 'payout_freeze']);

/** Types that set a lifecycle standing (§3.4). */
export const LIFECYCLE_STANDING_FOR: Partial<Record<ModerationActionType, Exclude<Standing, 'good'>>> = {
  restriction: 'restricted',
  suspension: 'suspended',
  ban: 'banned',
};

export const APPEALABLE: ReadonlySet<ModerationActionType> = new Set(['warning', 'restriction', 'suspension', 'ban', 'payout_freeze']);

/** `booking_intervention` is one-shot: a cancellation cannot be un-cancelled (§3.3). */
export const REVERSIBLE: ReadonlySet<ModerationActionType> = new Set(['warning', 'restriction', 'suspension', 'ban', 'payout_freeze']);

export function isLifecycleType(type: ModerationActionType): boolean {
  return LIFECYCLE_STANDING_FOR[type] !== undefined;
}

export function severityOf(type: ModerationActionType): number {
  const standing = LIFECYCLE_STANDING_FOR[type];
  if (standing === 'banned') return 3;
  if (standing === 'suspended') return 2;
  if (standing === 'restricted') return 1;
  return 0;
}

export const MAX_REASON_LENGTH = 500;
export const MAX_USER_MESSAGE_LENGTH = 500;
export const MAX_APPEAL_STATEMENT_LENGTH = 2000;
/** §3.8 — the limit spec 030 ships as `MAX_SAFETY_EVIDENCE` for the same kind of material. */
export const MAX_MODERATION_EVIDENCE = 10;
export const MODERATION_EVIDENCE_CONTEXT = 'moderation_evidence' as const;
