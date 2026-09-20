/**
 * Spec 030 — the spec's bounded constants. PURE: no I/O, no database, no configuration reads.
 *
 * THE PRIORITY DEFAULT IS THE LOAD-BEARING ONE HERE (DECIDED-1). Master §64 requires "Priority
 * classification" but defines no levels, and §62/§63 define none either; the repository's only
 * severity scale is spec 009's `risk_tier`. So this spec performs NO automated classification at
 * all: every report is created at one constant, and only a human moves it.
 */
import type { FileContextType } from '@/lib/types/files';
import type { SafetyPriority } from '@/lib/types/safety';

/**
 * The single priority every report is created at.
 *
 * MID-SCALE ON PURPOSE. Since no rule may read a report's content, no default CAN encode severity
 * — so the default's only job is to leave a triaging admin room to move a report in either
 * direction. It is explicitly not a judgement that a report is moderately serious. The real
 * protection for a report nobody classified is the queue's `priority DESC, created_at ASC`
 * ordering, which is FIFO among equals so nothing waits indefinitely.
 */
export const DEFAULT_SAFETY_PRIORITY: SafetyPriority = 'medium';

/**
 * Description bounds. Reuses spec 025's `MESSAGE_BODY_MAX_LENGTH` value rather than inventing a
 * second platform prose bound, exactly as spec 029 did for review text.
 */
export const MIN_DESCRIPTION_LENGTH = 10;
export const MAX_DESCRIPTION_LENGTH = 2000;

/** Admin reason bounds (master §68 requires a reason on every recorded decision). */
export const MIN_SAFETY_REASON_LENGTH = 10;
export const MAX_SAFETY_REASON_LENGTH = 2000;

/** §3 "Evidence" — wider than spec 029's 5, because safety evidence is whatever the reporter has. */
export const MAX_SAFETY_EVIDENCE = 10;

/** The spec 027 context this spec registers. */
export const SAFETY_EVIDENCE_CONTEXT: FileContextType = 'safety_evidence';
