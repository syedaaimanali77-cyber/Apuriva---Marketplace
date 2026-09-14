/**
 * Spec 021 §9 "Cron" — the protection/expiry sweep (AC-5a, AC-5b, AC-5c, AC-9).
 *
 * Master spec §47 requires "automatic progression prevents abandoned bookings from staying stuck",
 * and spec 020 §3 forbids booking code calling into payment code — so this spec OBSERVES booking
 * status rather than being told about it, which keeps the dependency strictly one-directional.
 *
 * Three independent passes per invocation, using the repository's existing Vercel Cron mechanism
 * (`app/api/v1/cron/*`, bearer `CRON_SECRET`) — no new scheduling framework:
 *
 *   A. OPEN   `completed` bookings with a captured, unprotected payment → protection `held`.
 *   B. RESOLVE `held` payments → `disputed` if the dispute port says one is open, else `released`
 *              once the window has elapsed, settling the booking.
 *   C. EXPIRE  `pending` bookings past the authorization window → `failed` (AC-9).
 *
 * Idempotent and retry-safe: the next minute's run is the retry. Every pass selects
 * `FOR UPDATE SKIP LOCKED` and re-checks its predicate under the lock, so two overlapping
 * invocations cannot release the same protection or fail the same booking twice.
 *
 * WHAT THIS SWEEP DOES NOT DO: it executes no payout (spec 024 owns that entirely and this file
 * writes no `payouts` row), and it resolves no dispute (spec 031). "Payout-eligible" here means
 * exactly `protection_state = 'released'` and `bookings.status = 'settled'` — a fact spec 024 reads.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows, type Executor } from '@/lib/offers/db';
import { applyBookingTransition } from '@/lib/bookings';
import type { PaymentStatus } from '@/lib/types/payments';
import { getDisputeGate, hasProtectionWindowElapsed, nextProtectionState } from './protection-window';
import { openProtectionWindow, setProtectionState } from './record';
import { applyPaymentTransition } from './state-machine';

/**
 * AC-9 — how long a booking may sit `pending` awaiting payment before the sweep fails it.
 *
 * An environment variable with a documented default, exactly as spec 008's
 * `DELETION_GRACE_PERIOD_DAYS` is handled. Not a feature-flag system (spec 041 owns that).
 */
export const DEFAULT_PAYMENT_AUTHORIZATION_WINDOW_MINUTES = 30;

export function paymentAuthorizationWindowMinutes(): number {
  const raw = Number(process.env.PAYMENT_AUTHORIZATION_WINDOW_MINUTES);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_PAYMENT_AUTHORIZATION_WINDOW_MINUTES;
}

export interface PaymentSweepResult {
  protectionOpened: number;
  protectionReleased: number;
  protectionDisputed: number;
  bookingsFailed: number;
}

export async function runPaymentSweep(): Promise<PaymentSweepResult> {
  const result: PaymentSweepResult = {
    protectionOpened: 0,
    protectionReleased: 0,
    protectionDisputed: 0,
    bookingsFailed: 0,
  };

  result.protectionOpened = await openProtectionWindows();
  const resolved = await resolveProtectionWindows();
  result.protectionReleased = resolved.released;
  result.protectionDisputed = resolved.disputed;
  result.bookingsFailed = await expirePendingAuthorizations();

  return result;
}

/**
 * Pass A (AC-5a) — opens the window on every completed booking whose payment was captured.
 *
 * The window's start instant is the `in_progress -> completed` history row's `occurred_at`, NOT
 * this sweep's clock. That is the whole of AC-5a's exactness: however late the sweep runs, the
 * deadline is the one the completion set, and it does not matter which party completed the booking
 * (the query does not look at `actor_role`).
 */
async function openProtectionWindows(): Promise<number> {
  let opened = 0;

  const candidates = await queryRows<{ payment_id: string; booking_id: string }>(
    getDb(),
    sql`SELECT p.id AS payment_id, b.id AS booking_id
          FROM payments p JOIN bookings b ON b.id = p.booking_id
         WHERE b.status = 'completed' AND p.status = 'captured' AND p.protection_state IS NULL
         LIMIT 200`,
  );

  for (const candidate of candidates) {
    await getDb().transaction(async (tx) => {
      const locked = await lockPair(tx, candidate.booking_id);
      if (!locked || locked.booking_status !== 'completed' || locked.payment_status !== 'captured') return;
      if (locked.protection_state !== null || locked.payment_id === null) return;

      const completedAt = await completionInstant(tx, candidate.booking_id);
      if (!completedAt) return; // no completion row: nothing to anchor the window to.

      if (!(await openProtectionWindow(tx, {
        paymentId: locked.payment_id,
        startedAt: completedAt,
        expectedVersion: locked.payment_version,
      }))) {
        return;
      }

      const transitioned = await applyBookingTransition(tx, {
        bookingId: candidate.booking_id,
        from: 'completed',
        to: 'protected',
        actorRole: 'system',
        actorUserId: null,
        expectedVersion: locked.booking_version,
      });
      if (!transitioned.applied && transitioned.currentStatus !== 'protected') {
        throw new Error(`booking ${candidate.booking_id} could not enter protection (${transitioned.currentStatus})`);
      }

      opened += 1;
      console.log(
        JSON.stringify({
          event: 'payment.protection_opened',
          paymentId: locked.payment_id,
          bookingId: candidate.booking_id,
          protectionWindowStartedAt: completedAt.toISOString(),
        }),
      );
    });
  }

  return opened;
}

/** Pass B (AC-5b, AC-5c) — release an undisputed elapsed window, or hold a disputed one. */
async function resolveProtectionWindows(): Promise<{ released: number; disputed: number }> {
  let released = 0;
  let disputed = 0;

  const candidates = await queryRows<{ booking_id: string }>(
    getDb(),
    sql`SELECT p.booking_id
          FROM payments p JOIN bookings b ON b.id = p.booking_id
         WHERE p.protection_state = 'held' AND b.status = 'protected'
         LIMIT 200`,
  );

  for (const candidate of candidates) {
    await getDb().transaction(async (tx) => {
      const locked = await lockPair(tx, candidate.booking_id);
      if (!locked || locked.protection_state !== 'held' || locked.booking_status !== 'protected') return;
      if (locked.payment_id === null) return;

      // Spec 031's port. The shipped default reports no dispute, because no spec has defined one.
      const dispute = await getDisputeGate()(tx, candidate.booking_id);

      // The DATABASE clock, read under the lock — never `now()` and never the app server's clock.
      const [clock] = await queryRows<{ at: Date }>(tx, sql`SELECT clock_timestamp() AS at`);
      const elapsed = hasProtectionWindowElapsed(
        locked.protection_window_started_at,
        locked.protection_window_hours,
        new Date(clock!.at),
      );

      const next = nextProtectionState({ current: 'held', disputeOpen: dispute.open, windowElapsed: elapsed });
      if (next === 'held') return;

      if (!(await setProtectionState(tx, {
        paymentId: locked.payment_id,
        from: 'held',
        to: next,
        expectedVersion: locked.payment_version,
      }))) {
        return;
      }

      if (next === 'disputed') {
        // AC-5c: the booking stays `protected`. This spec never transitions a booking to
        // `disputed` — spec 031 owns that transition and seeds it.
        disputed += 1;
        return;
      }

      const transitioned = await applyBookingTransition(tx, {
        bookingId: candidate.booking_id,
        from: 'protected',
        to: 'settled',
        actorRole: 'system',
        actorUserId: null,
        expectedVersion: locked.booking_version,
      });
      if (!transitioned.applied && transitioned.currentStatus !== 'settled') {
        throw new Error(`booking ${candidate.booking_id} could not settle (${transitioned.currentStatus})`);
      }
      released += 1;
    });
  }

  return { released, disputed };
}

/**
 * Pass C (AC-9) — a booking left `pending` because its payment was never completed.
 *
 * Resolves spec 020 §8 open question 7, which named this spec as the owner of both the gate and
 * `pending -> failed`. `failed` is in spec 020's `SLOT_RELEASING_BOOKING_STATUSES`, so the
 * provider's time is handed back by the existing machinery — this file adds no slot logic of its
 * own. Any non-terminal payment row is closed out as `failed` in the same transaction.
 */
async function expirePendingAuthorizations(): Promise<number> {
  let failed = 0;
  const windowMinutes = paymentAuthorizationWindowMinutes();

  const candidates = await queryRows<{ id: string }>(
    getDb(),
    sql`SELECT b.id
          FROM bookings b
         WHERE b.status = 'pending'
           AND b.created_at < clock_timestamp() - make_interval(mins => ${windowMinutes})
         LIMIT 200`,
  );

  for (const candidate of candidates) {
    await getDb().transaction(async (tx) => {
      const locked = await lockPair(tx, candidate.id);
      if (!locked || locked.booking_status !== 'pending') return;

      const [stillExpired] = await queryRows<{ expired: boolean }>(
        tx,
        sql`SELECT (created_at < clock_timestamp() - make_interval(mins => ${windowMinutes})) AS expired
              FROM bookings WHERE id = ${candidate.id}`,
      );
      if (!stillExpired?.expired) return;

      if (locked.payment_id && locked.payment_status && locked.payment_status !== 'failed' && locked.payment_status !== 'captured') {
        await applyPaymentTransition(tx, {
          paymentId: locked.payment_id,
          from: locked.payment_status,
          to: 'failed',
          actorRole: 'system',
          actorUserId: null,
          expectedVersion: locked.payment_version,
        });
      }

      const transitioned = await applyBookingTransition(tx, {
        bookingId: candidate.id,
        from: 'pending',
        to: 'failed',
        actorRole: 'system',
        actorUserId: null,
        expectedVersion: locked.booking_version,
      });
      if (!transitioned.applied) return;

      failed += 1;
      console.log(JSON.stringify({ event: 'payment.authorization_expired', bookingId: candidate.id }));
    });
  }

  return failed;
}

interface LockedPair {
  booking_status: string;
  booking_version: number;
  payment_id: string | null;
  payment_status: PaymentStatus | null;
  payment_version: number;
  protection_state: 'held' | 'released' | 'disputed' | null;
  protection_window_started_at: Date | null;
  protection_window_hours: number;
}

/**
 * Locks the booking and then its payment, in that fixed order (§3 "Transaction and lock ordering":
 * `bookings` → `payments` → `price_adjustments`), skipping rows another sweep already holds.
 */
async function lockPair(tx: Executor, bookingId: string): Promise<LockedPair | null> {
  const [booking] = await queryRows<{ status: string; version: number }>(
    tx,
    sql`SELECT status, version FROM bookings WHERE id = ${bookingId} FOR UPDATE SKIP LOCKED`,
  );
  if (!booking) return null;

  const [payment] = await queryRows<{
    id: string;
    status: PaymentStatus;
    version: number;
    protection_state: 'held' | 'released' | 'disputed' | null;
    protection_window_started_at: Date | null;
    protection_window_hours: number;
  }>(
    tx,
    sql`SELECT id, status, version, protection_state, protection_window_started_at, protection_window_hours
          FROM payments WHERE booking_id = ${bookingId} FOR UPDATE SKIP LOCKED`,
  );

  return {
    booking_status: booking.status,
    booking_version: booking.version,
    payment_id: payment?.id ?? null,
    payment_status: payment?.status ?? null,
    payment_version: payment?.version ?? 0,
    protection_state: payment?.protection_state ?? null,
    protection_window_started_at: payment?.protection_window_started_at ?? null,
    protection_window_hours: payment?.protection_window_hours ?? 0,
  };
}

/** AC-5a — the completion instant the window is anchored to, whoever recorded it. */
async function completionInstant(tx: Executor, bookingId: string): Promise<Date | null> {
  const [row] = await queryRows<{ occurred_at: Date }>(
    tx,
    sql`SELECT occurred_at FROM bookings_status_history
         WHERE booking_id = ${bookingId} AND to_status = 'completed'
         ORDER BY occurred_at ASC LIMIT 1`,
  );
  return row ? new Date(row.occurred_at) : null;
}
