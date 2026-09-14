/**
 * Spec 020 §3 "Why `pending` then `confirmed` in one transaction" / spec 021 §3 "Booking boundary".
 *
 * Spec 020 exported `confirmBooking()` as a separate step "precisely so spec 021 can gate it
 * without changing this spec's transition graph, its routes, or its DTO". This file is that gate,
 * and it is a PORT rather than a call into the payment domain for one concrete reason:
 * `confirmBooking()` runs inside `createBooking`'s transaction, which holds `FOR UPDATE` locks on
 * the request and offer rows and a reserved availability slot. An external payment-provider call
 * must never happen there. So spec 021 registers a gate that answers "no, do not confirm yet", the
 * booking commits `pending`, and the provider round trip happens afterwards outside every lock.
 *
 * Because the dependency is inverted, `lib/bookings/**` still imports no payment module and reads
 * no payment state — `lib/bookings/payment-boundary.test.ts` keeps asserting exactly that,
 * unmodified. This is the same port-with-inert-default idiom spec 020 used for
 * `CompletionEvidenceGate` and spec 016 for `BusyIntervalLoader`.
 *
 * The shipped default confirms immediately, which is byte-for-byte spec 020's standalone
 * behaviour: with no gate registered, `POST /bookings` returns a `confirmed` booking exactly as it
 * did before this file existed.
 */
import type { Executor } from '@/lib/offers/db';

export interface BookingConfirmationDecision {
  /**
   * `true` confirms inside the creation transaction (spec 020 standalone). `false` leaves the
   * booking `pending` for the gating spec to confirm — or fail — on its own terms.
   */
  confirmNow: boolean;
}

export type BookingConfirmationGate = (tx: Executor, bookingId: string) => Promise<BookingConfirmationDecision>;

/** The pre-spec-021 default: nothing gates confirmation, because no spec has defined a gate. */
const CONFIRM_IMMEDIATELY: BookingConfirmationGate = async () => ({ confirmNow: true });

let currentGate: BookingConfirmationGate = CONFIRM_IMMEDIATELY;

/** Called once by spec 021 at startup (its barrel, and the app's `instrumentation.ts`). */
export function registerBookingConfirmationGate(gate: BookingConfirmationGate): void {
  currentGate = gate;
}

export function getBookingConfirmationGate(): BookingConfirmationGate {
  return currentGate;
}

/** Test-only: restores the inert default so suites cannot leak into each other. */
export function resetBookingConfirmationGate(): void {
  currentGate = CONFIRM_IMMEDIATELY;
}
