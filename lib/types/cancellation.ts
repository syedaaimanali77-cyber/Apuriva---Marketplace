/**
 * Spec 023 §3 "Request and response types" — cancellation policy and consequence DTOs.
 *
 * This repository has no `packages/types`; every DTO lives under `lib/types/*`, the same as spec
 * 012's `location.ts`, spec 015's `requests.ts` and spec 022's `refunds.ts`.
 */

export const POLICY_SOURCES = ['platform_default', 'category_override', 'service_override'] as const;
export type PolicySource = (typeof POLICY_SOURCES)[number];

export const POLICY_SCOPES = ['platform', 'category', 'service'] as const;
export type PolicyScope = (typeof POLICY_SCOPES)[number];

export const CANCELLED_BY_ROLES = ['customer', 'provider', 'admin'] as const;
export type CancelledByRole = (typeof CANCELLED_BY_ROLES)[number];

/**
 * One rung of the fee ladder, in hours before the booking's scheduled time.
 *
 * Bounds are `[minHoursBefore, maxHoursBefore)` — INCLUSIVE at the lower (further-from-now) bound,
 * exclusive at the upper — so exactly 24h lands in the 0% tier and exactly 12h in the 25% tier:
 * each boundary instant falls in the cheaper tier (spec 023 §3 "Boundary semantics", AC-2/AC-3).
 * `null` means unbounded on that side.
 */
export interface CancellationTier {
  minHoursBefore: number | null;
  maxHoursBefore: number | null;
  /** Integer 0–100. */
  feePercent: number;
}

/** A named alternative ladder a provider may select, if the effective version publishes any. */
export interface CancellationPolicyOption {
  key: string;
  tiers: CancellationTier[];
}

/** The shape stored in `policy_versions.config`, validated at write time. */
export interface CancellationPolicyConfig {
  tiers: CancellationTier[];
  allowedOptions: CancellationPolicyOption[];
}

export interface CancellationPolicyDto {
  policyVersionId: string;
  source: PolicySource;
  providerOptionKey: string | null;
  tiers: CancellationTier[];
  /** Booking-scoped read only: the instant resolution used (the booking's own creation instant). */
  snapshotAsOf?: string;
}

/**
 * The server-authoritative consequence. The SAME pure computation produces the preview and the
 * executed outcome, so the number a customer confirms is the number applied (master spec §38).
 */
export interface CancellationConsequenceDto {
  cancellable: boolean;
  tier?: CancellationTier;
  /** Server-computed, 3 decimals. Display only — never an input. */
  hoursBefore?: number;
  capturedAmountMinorUnits?: number;
  feeAmountMinorUnits?: number;
  refundAmountMinorUnits?: number;
  currencyCode?: string;
  policyVersionId?: string;
  policySource?: PolicySource;
  providerOptionKey?: string | null;
  /** Why it is not cancellable — an error code, never free text. */
  blockedReason?: string;
}

export interface CancellationDto {
  id: string;
  bookingId: string;
  cancelledByRole: CancelledByRole;
  reasonCode: string | null;
  policyVersionId: string;
  tier: CancellationTier;
  capturedAmountMinorUnits: number;
  feeAmountMinorUnits: number;
  refundAmountMinorUnits: number;
  currencyCode: string;
  bookingStatus: 'cancelled';
  createdAt: string;
  version: number;
}

/**
 * `POST /bookings/{id}/cancel` — deliberately carries NO amount, tier, percentage or timestamp.
 *
 * Every one of those is computed server-side from the booking's snapshotted policy version; a
 * client-supplied figure would be a client deciding its own fee (AC-3).
 */
export interface CancelBookingRequest {
  /** From a closed list; free text is never the recorded reason. */
  reasonCode?: string;
  /** The canceller's own words, recorded but never used in the computation. */
  note?: string;
}

/** The admin configuration surface (spec 023 owns the data and API; spec 041 renders it later). */
export interface AdminCancellationPolicyVersionDto {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  config: CancellationPolicyConfig;
  note: string | null;
  createdAt: string;
}

export interface AdminCancellationPolicyDto {
  id: string;
  type: 'cancellation';
  scope: PolicyScope;
  scopeId: string | null;
  isActive: boolean;
  versions: AdminCancellationPolicyVersionDto[];
}

export interface PublishCancellationPolicyRequest {
  scope: PolicyScope;
  scopeId?: string | null;
  config: CancellationPolicyConfig;
  note?: string;
}
