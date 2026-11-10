/**
 * Spec 030 §3 "Temporary restrictions" (AC-5) — DECIDED-3.
 *
 * SPEC 030 OWNS NO ENFORCEMENT ACTION. Spec 038 already enumerates `'restriction'` in its
 * `ModerationActionDto.actionType` alongside `warning`, `suspension` and `ban`; its AC-1 drives the
 * spec 006/008 lifecycle states, its AC-2 applies spec 009's four-eyes approval, and its AC-5
 * supplies the appeal path master §68 requires. Master §68 lists the same catalogue. Building a
 * restriction here would create a second enforcement surface, a second approval tier and a second
 * appeal path for an action that is already specified elsewhere.
 *
 * So this module defines the PORT and nothing else. It performs no I/O, touches no table, and
 * cannot reach `users.lifecycle_status` — `lib/safety/boundary.test.ts` asserts at source level
 * that no module under `lib/safety/**` writes that column at all.
 *
 * THE DEFAULT THROWS. Every other port in this repository defaults to a harmless no-op
 * (`registerBusyIntervalLoader`, `registerProviderRatingSource`, `registerConversationBlockGate`),
 * and `checkConversationBlock` even swallows a throwing gate — because there, failing open
 * preserves a live booking's coordination channel. Here the polarity is inverted on purpose: an
 * admin who asked to restrict an account and was told nothing would reasonably believe the account
 * was restricted. Fabricating an enforcement outcome is far worse than refusing one, so the
 * unregistered default refuses loudly with `422 RESTRICTION_UNAVAILABLE`.
 */
import { restrictionUnavailableError } from './errors';

export interface RestrictionRequest {
  safetyReportId: string;
  targetUserId: string;
  requestedByAdminUserId: string;
  reason: string;
  correlationId: string | null;
}

export interface RestrictionResult {
  /** Spec 038's `moderation_actions.id`. Recorded on the report purely as a cross-reference. */
  moderationActionId: string;
}

export type SafetyRestrictionGate = (request: RestrictionRequest) => Promise<RestrictionResult>;

/** The pre-spec-038 default: the capability is not installed, and says so. */
const UNAVAILABLE: SafetyRestrictionGate = async () => {
  throw restrictionUnavailableError();
};

let currentGate: SafetyRestrictionGate = UNAVAILABLE;

/**
 * Called once by SPEC 038 at startup, from the same composition root. Spec 030 never calls this —
 * `registerSafetyIntegration()` deliberately leaves the gate unregistered.
 */
export function registerSafetyRestrictionGate(gate: SafetyRestrictionGate): void {
  currentGate = gate;
}

export function getSafetyRestrictionGate(): SafetyRestrictionGate {
  return currentGate;
}

/** Test-only: restores the refusing default so suites cannot leak into each other. */
export function resetSafetyRestrictionGate(): void {
  currentGate = UNAVAILABLE;
}

/**
 * Hands the request to spec 038. Deliberately NOT wrapped in a try/catch: a failure here must reach
 * the resolving admin and must fail the surrounding transaction, so the report does not close as
 * though a restriction had been applied.
 */
export function requestRestriction(request: RestrictionRequest): Promise<RestrictionResult> {
  return getSafetyRestrictionGate()(request);
}
