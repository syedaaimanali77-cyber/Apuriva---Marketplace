/**
 * Spec 021 §3 "Protection window" (AC-5, AC-5a, AC-5b, AC-5c) — the pure arithmetic and the port.
 *
 * The window's START INSTANT is the thing AC-5a is exact about: it is the `occurred_at` of the
 * booking's `in_progress -> completed` history row, never the moment the sweep happened to observe
 * it. Spec 020 signals nothing when a booking completes (reaching `completed` triggers nothing
 * there, by design), so spec 021 observes booking status from its own sweep — and by deriving the
 * start from the history row, the sweep's lag cannot move the deadline by a millisecond.
 */
import type { PaymentProtectionState } from '@/lib/types/payments';
import type { Executor } from '@/lib/offers/db';

/** §3 — the default, applied whenever no service or payment model configured another. */
export const DEFAULT_PROTECTION_WINDOW_HOURS = 48;

/** §4 I-6 — a configurable window, bounded. Mirrored by `payments_protection_window_hours_ck`. */
export const MIN_PROTECTION_WINDOW_HOURS = 1;
export const MAX_PROTECTION_WINDOW_HOURS = 720;

export function isValidProtectionWindowHours(hours: number): boolean {
  return Number.isInteger(hours) && hours >= MIN_PROTECTION_WINDOW_HOURS && hours <= MAX_PROTECTION_WINDOW_HOURS;
}

/**
 * The configured duration for a payment, or the 48-hour default.
 *
 * `null`/`undefined` means "nothing configured", which is the case for every payment this
 * repository creates today — the column exists so a later spec can configure it per service or
 * payment model without a schema change, exactly as §3 promises.
 */
export function resolveProtectionWindowHours(configured?: number | null): number {
  if (typeof configured === 'number' && isValidProtectionWindowHours(configured)) return configured;
  return DEFAULT_PROTECTION_WINDOW_HOURS;
}

/** The instant the window closes. `null` in, `null` out — the window has not opened yet. */
export function protectionWindowEndsAt(startedAt: Date | string | null, hours: number): Date | null {
  if (startedAt === null) return null;
  const start = startedAt instanceof Date ? startedAt : new Date(startedAt);
  if (Number.isNaN(start.getTime())) return null;
  return new Date(start.getTime() + hours * 60 * 60 * 1000);
}

export function hasProtectionWindowElapsed(
  startedAt: Date | string | null,
  hours: number,
  now: Date = new Date(),
): boolean {
  const endsAt = protectionWindowEndsAt(startedAt, hours);
  return endsAt !== null && now.getTime() >= endsAt.getTime();
}

/**
 * The protection state a payment should hold given whether a dispute is open.
 *
 * Pure, so AC-5b and AC-5c are unit-testable without a database: an open dispute holds the payment
 * `disputed` however much of the window has passed, and only an elapsed window with NO dispute
 * releases it.
 */
export function nextProtectionState(input: {
  current: PaymentProtectionState;
  disputeOpen: boolean;
  windowElapsed: boolean;
}): PaymentProtectionState {
  if (input.current !== 'held') return input.current;
  if (input.disputeOpen) return 'disputed';
  return input.windowElapsed ? 'released' : 'held';
}

/**
 * Spec 031's seam. Disputes do not exist in this repository — no table, no route, no concept — so
 * this spec ships the PORT it reads and nothing else, the same inert-default idiom spec 020 used
 * for `CompletionEvidenceGate` and spec 016 for `BusyIntervalLoader`.
 *
 * With the shipped default, no booking is ever disputed. That is CORRECT rather than a stub: no
 * spec has defined a dispute yet, so there is nothing that could be open. Spec 031 registers the
 * real gate when it ships; nothing else in this spec changes.
 */
export type DisputeGate = (tx: Executor, bookingId: string) => Promise<{ open: boolean }>;

const NO_DISPUTES: DisputeGate = async () => ({ open: false });

let currentDisputeGate: DisputeGate = NO_DISPUTES;

/** Called once by spec 031 at startup to make the gate real. */
export function registerDisputeGate(gate: DisputeGate): void {
  currentDisputeGate = gate;
}

export function getDisputeGate(): DisputeGate {
  return currentDisputeGate;
}

/** Test-only: restores the inert default so suites cannot leak into each other. */
export function resetDisputeGate(): void {
  currentDisputeGate = NO_DISPUTES;
}
