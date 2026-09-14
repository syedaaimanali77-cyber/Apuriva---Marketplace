/**
 * Spec 020 §3 "Completion-evidence gate (AC-5) — boundary with specs 027/028".
 *
 * Spec 028 owns the *requirement* (`services.completion_evidence_required`, its §4) and spec 027
 * owns evidence *storage*. Neither exists in this repository yet, and this spec must not pre-empt
 * either — so it ships the GATE, not the requirement, using the same port-with-inert-default idiom
 * spec 016 used for `BusyIntervalLoader` and spec 012 for `service-area-check`.
 *
 * With the shipped default, completion always succeeds without evidence. That is CORRECT rather
 * than a stub: no service can require evidence until spec 028 adds the column. Spec 028 registers
 * the real gate and extends the request body with `evidenceFileAssetIds`; this spec's body accepts
 * no evidence field, because accepting one it could not store would be a promise it cannot keep.
 *
 * The gate is consulted IDENTICALLY for the customer and the provider (AC-5, safeguard S5): a
 * customer can never bypass a requirement the provider would face, or vice versa.
 */
import type { Executor } from '@/lib/offers/db';

export interface CompletionEvidenceStatus {
  /** Whether this booking's service/policy requires completion evidence at all. */
  required: boolean;
  /** Whether the requirement is currently met. Meaningless when `required` is false. */
  satisfied: boolean;
}

export type CompletionEvidenceGate = (tx: Executor, bookingId: string) => Promise<CompletionEvidenceStatus>;

/** The pre-spec-028 default: nothing requires evidence, because no spec has defined a requirement. */
const NO_EVIDENCE_REQUIRED: CompletionEvidenceGate = async () => ({ required: false, satisfied: true });

let currentGate: CompletionEvidenceGate = NO_EVIDENCE_REQUIRED;

/** Called once by spec 028 at startup to make the gate real. */
export function registerCompletionEvidenceGate(gate: CompletionEvidenceGate): void {
  currentGate = gate;
}

export function getCompletionEvidenceGate(): CompletionEvidenceGate {
  return currentGate;
}

/** Restores the default. For tests that register a gate and must not leak it to other suites. */
export function resetCompletionEvidenceGate(): void {
  currentGate = NO_EVIDENCE_REQUIRED;
}
