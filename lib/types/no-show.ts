/**
 * Spec 023 §3 "Request and response types" — the no-show DTOs.
 *
 * Two views exist on purpose. `NoShowReportDto` is what a PARTICIPANT sees: the neutral status,
 * their own submission, and nothing of the other party's words or the evidence bundle.
 * `AdminNoShowReportDto` is the Trust & Safety view and is never served from a participant route
 * (AC-10).
 */

export const NO_SHOW_STATUSES = ['reported', 'awaiting_response', 'under_review', 'resolved', 'withdrawn'] as const;
export type NoShowStatus = (typeof NO_SHOW_STATUSES)[number];

/** The CLOSED set an admin may choose from. An admin never chooses an amount (spec 023 §3). */
export const NO_SHOW_OUTCOMES = [
  'no_show_confirmed_customer',
  'no_show_confirmed_provider',
  'no_fault',
  'inconclusive',
  'escalated_to_dispute',
] as const;
export type NoShowOutcome = (typeof NO_SHOW_OUTCOMES)[number];

/** The two outcomes that produce a verified-no-show fact (AC-6). Nothing else counts. */
export const FAULT_OUTCOMES = ['no_show_confirmed_customer', 'no_show_confirmed_provider'] as const;
export type FaultOutcome = (typeof FAULT_OUTCOMES)[number];

/**
 * The ONLY location datum this system holds — coarse, derived and optional.
 *
 * It comes from spec 012's existing service-area check over an address the customer already saved
 * and a service area the provider already declared. No device location is ever requested, stored or
 * returned, and `'unavailable'` is a first-class value: resolution works fine without any signal,
 * and no resolution path branches on this value (AC-5).
 */
export const NO_SHOW_LOCATION_SIGNALS = [
  'address_within_service_area',
  'address_outside_service_area',
  'unavailable',
] as const;
export type NoShowLocationSignal = (typeof NO_SHOW_LOCATION_SIGNALS)[number];

export const NO_SHOW_RESPONSE_STATUSES = ['pending', 'filed', 'no_response'] as const;
export type NoShowResponseStatus = (typeof NO_SHOW_RESPONSE_STATUSES)[number];

export type NoShowReporterRole = 'customer' | 'provider';

/** Derived facts only. No message bodies, no coordinates, no free text from either party. */
export interface NoShowEvidence {
  scheduledAt: string;
  minutesAfterScheduled: number;
  reachedProviderEnRouteAt: string | null;
  reachedArrivedAt: string | null;
  reachedInProgressAt: string | null;
  statusHistory: Array<{ toStatus: string; actorRole: 'customer' | 'provider' | 'system'; occurredAt: string }>;
  /** Spec 025 owns messaging; until it ships this is `{ available: false }`, never a stand-in. */
  communications: { available: boolean; messageCount?: number; lastMessageAt?: string };
}

/** The participant view. Carries NO other party's statement and NO admin field. */
export interface NoShowReportDto {
  id: string;
  bookingId: string;
  reporterRole: NoShowReporterRole;
  /** True when the caller filed this report. */
  isOwnReport: boolean;
  status: NoShowStatus;
  respondByAt: string | null;
  responseFiled: boolean;
  responseFiledAt: string | null;
  outcome: NoShowOutcome | null;
  resolvedAt: string | null;
  createdAt: string;
  version: number;
}

/** The Trust & Safety view. Never served from a participant route. */
export interface AdminNoShowReportDto extends Omit<NoShowReportDto, 'isOwnReport'> {
  reporterStatement: string | null;
  responseStatement: string | null;
  responseStatus: NoShowResponseStatus;
  locationSignal: NoShowLocationSignal;
  evidence: NoShowEvidence | null;
  resolutionReason: string | null;
  resolvedByAdminId: string | null;
  counterpartReportId: string | null;
  escalated: boolean;
}

export interface ReportNoShowRequest {
  /** The reporter's own words. Optional, and never used to decide anything. */
  statement?: string;
}

export interface RespondToNoShowRequest {
  statement?: string;
}

export interface ResolveNoShowRequest {
  outcome: NoShowOutcome;
  /** Required — master spec §68. Carried into the spec 009 audit record. */
  reason: string;
}

export function isFaultOutcome(outcome: NoShowOutcome | null): outcome is FaultOutcome {
  return outcome === 'no_show_confirmed_customer' || outcome === 'no_show_confirmed_provider';
}
