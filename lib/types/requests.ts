/** Spec 015 §3 Request and response types. */

export type RequestStatus =
  | 'draft'
  | 'submitted'
  | 'matching'
  | 'offers_open'
  | 'provider_selected'
  | 'booking_created'
  | 'cancelled'
  | 'expired'
  | 'completed';

export type RequestUrgency = 'normal' | 'urgent';

/**
 * Master spec §27's three budget shapes. Omitted/`null` = "I'm not sure". `amountMinorUnits` is an
 * integer in minor units and `currencyCode` an ISO-4217-shaped 3-letter uppercase code, matching
 * `moneyColumns()`/`moneyPairChecks()` (lib/db/schema.ts) — never a float.
 */
export type RequestBudget =
  | { amountMinorUnits: number; currencyCode: string }
  | { minAmountMinorUnits: number; maxAmountMinorUnits: number; currencyCode: string };

export interface CreateRequestRequest {
  serviceId: string;
  description: string;
  /** Keyed by `ServiceField.key` (not id) — the exact shape `validateFieldSubmission`
   * (lib/service-page/fields.ts) already validates, so spec 011's validator is reused verbatim. */
  fieldValues: Record<string, string | number | boolean>;
  budget?: RequestBudget | null;
  /** ISO-8601 instant, paired with `preferredTimezone` (IANA id) per spec 003's
   * `scheduledTimeColumns()` convention, so local wall-clock time stays reconstructible. */
  preferredAt?: string;
  preferredTimezone?: string;
  addressId: string;
  urgency: RequestUrgency;
  /** Accepted but only meaningful once spec 027 ships; every id must already exist in
   * `file_assets` and be owned by the caller (spec 015 §3/§8 #1). */
  attachmentIds?: string[];
}

export interface RequestDto {
  id: string;
  status: RequestStatus;
  serviceId: string;
  serviceName: string;
  description: string;
  fieldValues: Record<string, string | number | boolean>;
  budget: RequestBudget | null;
  preferredAt: string | null;
  preferredTimezone: string | null;
  addressId: string;
  urgency: RequestUrgency;
  /** Always `0` in this spec — no offer can exist until spec 018. Never omitted, so the status
   * view has a stable shape. */
  offerCount: number;
  /** AC-5: the master spec §37 step, derived server-side from `status`. */
  customerFacingStep: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface RequestSummaryDto {
  id: string;
  status: RequestStatus;
  customerFacingStep: string;
  serviceId: string;
  serviceName: string;
  offerCount: number;
  createdAt: string;
}

export interface CancelPreviewDto {
  cancellable: boolean;
  /** Human-readable consequence, or `null` when there is none — always `null` in this spec's
   * cancellable states, since no payment can exist before provider selection (spec 015 §3). */
  consequence: string | null;
  feeAmountMinorUnits: number | null;
  currencyCode: string | null;
}

export interface CancelRequestRequest {
  expectedVersion: number;
}

/** `GET /api/v1/requests?filter=` — active is everything still in flight, history everything terminal. */
export type RequestListFilter = 'active' | 'history';

/**
 * AC-5: the ONLY place an internal status becomes a customer-facing step. Master spec §37's
 * progression is "Request sent → Providers notified → Offers received → Provider selected →
 * Payment → Booking confirmed"; Payment is spec 021's own step inside `booking_created`, so it is
 * not a separate request status. Internal matching mechanics (pool size, ranking, excluded
 * providers) are never expressed here or anywhere else customer-facing.
 */
export const CUSTOMER_FACING_STEP: Record<RequestStatus, string> = {
  // Never customer-visible: `draft` exists only inside the creation transaction (spec 015 §4).
  draft: 'Draft',
  submitted: 'Request sent',
  matching: 'Providers notified',
  offers_open: 'Offers received',
  provider_selected: 'Provider selected',
  booking_created: 'Booking confirmed',
  cancelled: 'Cancelled',
  expired: 'Expired',
  completed: 'Completed',
};

/** The states master spec §38 allows a customer to cancel from — strictly before provider
 * selection. Cancellation at/after `provider_selected` is spec 023's booking cancellation. */
export const CANCELLABLE_REQUEST_STATUSES: RequestStatus[] = ['submitted', 'matching', 'offers_open'];

/** Everything still in flight for the customer — the `filter=active` list (spec 015 §3). */
export const ACTIVE_REQUEST_STATUSES: RequestStatus[] = [
  'submitted',
  'matching',
  'offers_open',
  'provider_selected',
  'booking_created',
];

export function customerFacingStep(status: RequestStatus): string {
  return CUSTOMER_FACING_STEP[status];
}

export function isCancellable(status: RequestStatus): boolean {
  return CANCELLABLE_REQUEST_STATUSES.includes(status);
}
