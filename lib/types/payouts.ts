/**
 * Spec 024 §3.13 "Request and response types" — the payout and earnings surface's public contract.
 *
 * Two rules shape everything here, asserted by `lib/payouts/boundaries.test.ts`:
 *
 *   1. Nothing rail-facing crosses this boundary. No DTO carries a payout reference, a destination
 *      token, a setup token, an idempotency key or a rail name (§4.4 "never leaves the server").
 *   2. Every money figure is a persisted integer or a SUM of persisted integers, computed on the
 *      server. The client formats; it never computes (AC-3).
 */

export const PAYOUT_STATUSES = ['pending', 'eligible', 'processing', 'paid', 'failed'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export const EARNINGS_LINE_STATES = ['pending', 'eligible', 'paid'] as const;
export type EarningsLineState = (typeof EARNINGS_LINE_STATES)[number];

export const PAYOUT_METHOD_TYPES = ['bank', 'mobile_wallet'] as const;
export type PayoutMethodType = (typeof PAYOUT_METHOD_TYPES)[number];

export const PAYOUT_METHOD_VERIFICATION_STATES = ['pending', 'verified', 'rejected'] as const;
export type PayoutMethodVerificationState = (typeof PAYOUT_METHOD_VERIFICATION_STATES)[number];

export const EARNINGS_ADJUSTMENT_KINDS = ['credit', 'debit'] as const;
export type EarningsAdjustmentKind = (typeof EARNINGS_ADJUSTMENT_KINDS)[number];

export const PAYOUT_ITEM_KINDS = ['earnings_line', 'adjustment', 'refund_recovery'] as const;
export type PayoutItemKind = (typeof PAYOUT_ITEM_KINDS)[number];

/** The closed set adapters map rail responses onto (§3.2). Never a raw rail payload. */
export const PAYOUT_FAILURE_CODES = [
  'destination_invalid',
  'destination_unavailable',
  'rail_temporarily_unavailable',
  'transfer_rejected',
  'transfer_not_received',
  'unknown_failure',
] as const;
export type PayoutFailureCode = (typeof PAYOUT_FAILURE_CODES)[number];

export function isPayoutStatus(value: unknown): value is PayoutStatus {
  return typeof value === 'string' && (PAYOUT_STATUSES as readonly string[]).includes(value);
}

export function isEarningsLineState(value: unknown): value is EarningsLineState {
  return typeof value === 'string' && (EARNINGS_LINE_STATES as readonly string[]).includes(value);
}

export function isEarningsAdjustmentKind(value: unknown): value is EarningsAdjustmentKind {
  return typeof value === 'string' && (EARNINGS_ADJUSTMENT_KINDS as readonly string[]).includes(value);
}

/** Every figure is a persisted SUM in integer minor units. The client formats; it never computes. */
export interface EarningsSummaryDto {
  currencyCode: string;
  grossAmountMinorUnits: number;
  /** Net of reversals: Σ (line fee − line fee reversal). */
  feeAmountMinorUnits: number;
  refundsAmountMinorUnits: number;
  /** Signed. Negative when debits outweigh credits. */
  adjustmentsAmountMinorUnits: number;
  /** gross − fee + adjustments − refunds. */
  netAmountMinorUnits: number;
  pendingAmountMinorUnits: number;
  upcomingAmountMinorUnits: number;
  paidAmountMinorUnits: number;
  /** Equals `upcoming`; may be negative while a recovery is outstanding. */
  balanceAmountMinorUnits: number;
  /** True when no usable default payout method exists, so batches cannot close. */
  payoutMethodRequired: boolean;
  /** True when the PayoutHoldGate holds this provider. The reason is never exposed. */
  payoutOnHold: boolean;
  /** Currencies this provider has ledger rows in, so the UI can offer a switcher. */
  availableCurrencyCodes: string[];
}

export interface EarningsLineDto {
  id: string;
  bookingId: string;
  serviceId: string;
  state: EarningsLineState;
  currencyCode: string;
  grossAmountMinorUnits: number;
  platformFeeBps: number;
  /** The fee on gross, before reversals. Immutable. */
  feeAmountMinorUnits: number;
  refundedAmountMinorUnits: number;
  feeReversalAmountMinorUnits: number;
  netAmountMinorUnits: number;
  scheduledAt: string;
  eligibleAt: string | null;
  paidAt: string | null;
  payoutId: string | null;
  createdAt: string;
  version: number;
}

export interface PayoutDto {
  id: string;
  status: PayoutStatus;
  amountMinorUnits: number;
  currencyCode: string;
  itemCount: number;
  /** Masked method detail only — never a token or any id-bearing credential. */
  payoutMethodMaskedDetail: string | null;
  closedAt: string | null;
  paidAt: string | null;
  failureCode: PayoutFailureCode | null;
  createdAt: string;
  version: number;
}

export interface PayoutItemDto {
  id: string;
  kind: PayoutItemKind;
  /** Set for `earnings_line` and `refund_recovery`. */
  earningsLineId: string | null;
  /** Set for `adjustment` only. */
  adjustmentId: string | null;
  bookingId: string | null;
  /** Signed: negative for `refund_recovery` and for a `debit` adjustment. */
  itemAmountMinorUnits: number;
  currencyCode: string;
}

export interface PayoutDetailDto extends PayoutDto {
  items: PayoutItemDto[];
}

export interface PayoutMethodDto {
  id: string;
  type: PayoutMethodType;
  /** Rail-supplied. The ONLY account detail that ever leaves the server. */
  maskedDetail: string;
  institutionLabel: string;
  payoutCurrencyCode: string;
  verificationState: PayoutMethodVerificationState;
  isDefault: boolean;
  removedAt: string | null;
  createdAt: string;
  version: number;
}

export interface EarningsAdjustmentDto {
  id: string;
  kind: EarningsAdjustmentKind;
  /** Signed: positive credits, negative debits. */
  adjustmentAmountMinorUnits: number;
  currencyCode: string;
  reason: string;
  /** Present only on the admin surface. */
  adminActionId?: string;
  /** Present only on the admin surface. */
  providerProfileId?: string;
  /** Null until a second admin's approval has been executed. Providers only ever see applied rows. */
  appliedAt: string | null;
  payoutId: string | null;
  createdAt: string;
}

/** The ONLY field a client sends to create a payout method. */
export interface CreatePayoutMethodRequest {
  /** Single-use token from the payout rail's own hosted onboarding UI. */
  setupToken: string;
}

export interface UpdatePayoutMethodRequest {
  isDefault: true;
}

/** Initiate shape. */
export interface InitiateEarningsAdjustmentRequest {
  providerProfileId: string;
  kind: EarningsAdjustmentKind;
  /** Always POSITIVE here; `debit` is stored negated. Zero and non-integers are rejected. */
  amountMinorUnits: number;
  currencyCode: string;
  reason: string;
}

/** Execute shape. Deliberately carries NO amount — the approved row fixes it (§3.10). */
export interface ExecuteEarningsAdjustmentRequest {
  adminActionId: string;
}

/** `202` body for an adjustment awaiting a second admin. The row exists but is unapplied. */
export interface AdjustmentPendingDto {
  adminActionId: string;
  adjustmentId: string;
  status: 'pending_approval';
  providerProfileId: string;
  kind: EarningsAdjustmentKind;
  amountMinorUnits: number;
  currencyCode: string;
}

export interface InitiatePayoutRetryRequest {
  reason: string;
}

export interface ExecutePayoutRetryRequest {
  adminActionId: string;
}

/** `202` body for a retry awaiting a second admin. The payout is unchanged. */
export interface PayoutRetryPendingDto {
  adminActionId: string;
  payoutId: string;
  status: 'pending_approval';
}

export interface AdminPayoutDto extends PayoutDto {
  providerProfileId: string;
  attemptCount: number;
  payoutMethodId: string | null;
}

export interface AdminPayoutDetailDto extends AdminPayoutDto {
  items: PayoutItemDto[];
  /** Operator-facing detail. Never rendered to a provider. */
  failureReason: string | null;
  escalatedAt: string | null;
}
