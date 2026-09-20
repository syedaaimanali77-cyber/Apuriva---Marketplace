/**
 * Spec 030 §3 "Request and response types" — blocking, reporting & safety incidents.
 *
 * This repository has no `packages/types`; every DTO lives under `lib/types/*`.
 *
 * NOTE WHAT IS ABSENT. There is no restriction DTO, no sanction DTO and no account-state field
 * anywhere in this file: spec 030 owns no enforcement action (DECIDED-3). The only thing it can
 * say about a restriction is that a named admin *asked* for one.
 */
import type { FileAssetDto } from './files';

export const SAFETY_REPORT_STATUSES = ['submitted', 'under_review', 'escalated', 'resolved'] as const;
export type SafetyReportStatus = (typeof SAFETY_REPORT_STATUSES)[number];

/** Mirrors spec 009's `risk_tier` vocabulary rather than inventing a second severity scale. */
export const SAFETY_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export type SafetyPriority = (typeof SAFETY_PRIORITIES)[number];

/**
 * Categories are a REPORTING vocabulary, not a severity taxonomy: nothing anywhere derives a
 * priority from them (DECIDED-1). Adding a member is additive and needs only a migration to widen
 * the CHECK.
 */
export const SAFETY_CATEGORIES = [
  'harassment',
  'threat',
  'unsafe_behaviour',
  'impersonation',
  'property_damage',
  'other',
] as const;
export type SafetyCategory = (typeof SAFETY_CATEGORIES)[number];

export function isSafetyCategory(value: unknown): value is SafetyCategory {
  return typeof value === 'string' && (SAFETY_CATEGORIES as readonly string[]).includes(value);
}

export function isSafetyReportStatus(value: unknown): value is SafetyReportStatus {
  return typeof value === 'string' && (SAFETY_REPORT_STATUSES as readonly string[]).includes(value);
}

export function isSafetyPriority(value: unknown): value is SafetyPriority {
  return typeof value === 'string' && (SAFETY_PRIORITIES as readonly string[]).includes(value);
}

export interface BlockDto {
  id: string;
  blockedUserId: string;
  createdAt: string;
}

export interface CreateBlockRequest {
  targetUserId: string;
}

export interface CreateSafetyReportRequest {
  targetUserId: string;
  category: SafetyCategory;
  /** Required, 10..2000 chars — normalized exactly as spec 029 normalizes review text. */
  description: string;
  /** Optional. The booking this concerns, when there is one. */
  bookingId?: string | null;
}

/** What the REPORTER sees. Carries no priority, no admin identity and no internal state. */
export interface SafetyReportDto {
  id: string;
  status: SafetyReportStatus;
  category: SafetyCategory;
  createdAt: string;
  /** The reporter's own attachments only. */
  evidence: FileAssetDto[];
}

/** S6–S10 only. Never returned to a reporter or to the reported user. */
export interface AdminSafetyReportDto extends SafetyReportDto {
  reporterUserId: string;
  targetUserId: string;
  bookingId: string | null;
  description: string;
  priority: SafetyPriority;
  /** AC-4: advisory only. Never a decision, and null whenever spec 033 is unavailable. */
  aiSummary: string | null;
  claimedByAdminId: string | null;
  escalatedAt: string | null;
  resolvedAt: string | null;
  resolutionReason: string | null;
  /** AC-5: that a named admin ASKED for a restriction. Never that one was applied. */
  restrictionRequestedAt: string | null;
  version: number;
}

export interface SafetyTransitionRequest {
  /** Required for escalate and resolve, 10..2000 chars. Optional for claim. */
  reason?: string;
  /** Optimistic concurrency: the status the admin was looking at. */
  expectedStatus: SafetyReportStatus;
  /**
   * S10 only. Asks spec 038 to restrict the reported account (DECIDED-3). This spec applies
   * nothing itself: it records the request and calls the `SafetyRestrictionGate`, which is
   * unregistered until spec 038 ships and then throws `422 RESTRICTION_UNAVAILABLE`.
   */
  requestRestriction?: boolean;
}

/** S10 only — the priority an admin sets by hand. Never derived from content (DECIDED-1). */
export interface SetSafetyPriorityRequest {
  priority: SafetyPriority;
  expectedStatus: SafetyReportStatus;
}
