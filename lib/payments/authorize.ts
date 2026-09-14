/**
 * Spec 021 §3 — authorization and capture (AC-1, AC-2, AC-6, AC-7, AC-10).
 *
 * THE SHAPE OF EVERY MONEY-MOVING OPERATION (§3 "Transaction and lock ordering") is three phases,
 * and a provider call is NEVER made inside a database transaction:
 *
 *   1. reserve (tx)  lock the booking `FOR UPDATE`, then the payment row; check status and
 *                    idempotency; insert or advance the payment to a non-terminal state; commit.
 *   2. call (no tx)  one adapter call, carrying the idempotency key.
 *   3. record (tx)   re-lock in the same order; apply the outcome CONDITIONALLY on the version read
 *                    in phase 1; write the attempt, authorization and history rows; transition the
 *                    booking where the outcome demands it; commit.
 *
 * A crash between phases 2 and 3 leaves a non-terminal payment, which the sweep reconciles through
 * `getStatus(providerReference)` rather than re-charging. The provider stays authoritative for
 * money at all times.
 *
 * WHY A DECLINE DOES NOT MARK THE PAYMENT `failed`: AC-6 requires the customer to be able to retry
 * or change payment method. `payments_booking_id_uq` allows exactly one payment row per booking
 * (I-1, the structural anti-double-charge guarantee), and `failed` is terminal — so marking the row
 * `failed` on the first decline would make the booking permanently unpayable. Instead a decline
 * writes an append-only `payment_attempts` row, leaves the payment `created`/`requires_action`, and
 * leaves the booking `pending`. The payment only reaches `failed` when AC-9's window expires, which
 * is the one moment retrying is genuinely over.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import { queryRows, isUniqueViolation, type Executor } from '@/lib/offers/db';
import { confirmBooking, requireBookingParticipant } from '@/lib/bookings';
import type { BookingStatus } from '@/lib/types/bookings';
import type { PaymentDto, PaymentStatus } from '@/lib/types/payments';
import {
  bookingNotAwaitingPaymentError,
  idempotencyKeyConflictError,
  paymentAlreadyCapturedError,
  paymentFailedError,
  paymentNotAuthorizedError,
  paymentRequiresActionError,
  paymentVersionConflictError,
} from './errors';
import { DEFAULT_PROTECTION_WINDOW_HOURS } from './protection-window';
import { resolvePaymentProvider, type PaymentProvider, type ProviderResult } from './provider';
import { findPaymentByBookingId } from './read';
import { recordAttempt, recordAuthorization, recordCapture } from './record';
import { applyPaymentTransition, recordPaymentCreated } from './state-machine';
import { initialChargeAmountMinorUnits, resolvePaymentTiming, type PricingModel } from './timing';

interface ReservedPayment {
  paymentId: string;
  version: number;
  status: PaymentStatus;
  amountMinorUnits: number;
  currencyCode: string;
  providerReference: string | null;
  /** Set when phase 1 concluded the request is a pure replay and no provider call is needed. */
  replay: PaymentDto | null;
}

interface BookingPaymentContext {
  bookingId: string;
  bookingStatus: BookingStatus;
  bookingVersion: number;
  priceAmountMinorUnits: number;
  priceCurrencyCode: string;
  pricingModel: PricingModel;
}

async function lockBookingContext(tx: Executor, bookingId: string): Promise<BookingPaymentContext> {
  await tx.execute(sql`SELECT id FROM bookings WHERE id = ${bookingId} FOR UPDATE`);
  const [row] = await queryRows<{
    status: BookingStatus;
    version: number;
    price_amount_minor_units: number;
    price_currency_code: string;
    pricing_model: PricingModel;
  }>(
    tx,
    sql`SELECT b.status, b.version, b.price_amount_minor_units, b.price_currency_code, s.pricing_model
          FROM bookings b JOIN services s ON s.id = b.service_id
         WHERE b.id = ${bookingId}`,
  );
  if (!row) throw bookingNotAwaitingPaymentError('missing');
  return {
    bookingId,
    bookingStatus: row.status,
    bookingVersion: row.version,
    priceAmountMinorUnits: row.price_amount_minor_units,
    priceCurrencyCode: row.price_currency_code,
    pricingModel: row.pricing_model,
  };
}

interface LockedPaymentRow {
  id: string;
  status: PaymentStatus;
  version: number;
  charge_amount_minor_units: number;
  charge_currency_code: string;
  provider_reference: string | null;
  idempotency_key: string;
  idempotency_fingerprint: string;
}

async function lockPaymentRow(tx: Executor, bookingId: string): Promise<LockedPaymentRow | undefined> {
  const [row] = await queryRows<LockedPaymentRow>(
    tx,
    sql`SELECT id, status, version, charge_amount_minor_units, charge_currency_code,
               provider_reference, idempotency_key, idempotency_fingerprint
          FROM payments WHERE booking_id = ${bookingId} FOR UPDATE`,
  );
  return row;
}

/**
 * AC-1/AC-2/AC-6/AC-7 — `POST /api/v1/bookings/{id}/payment/authorize`.
 *
 * Authorization happens HERE and nowhere earlier: no offer route, no request route and no booking
 * route reaches this module (AC-2). For `at_booking_confirmation` timing — the only timing
 * reachable in this repository — capture follows immediately, so the booking is confirmed only
 * once the provider has confirmed captured funds.
 */
export async function authorizePayment(
  userId: string,
  bookingId: string,
  idempotencyKey: string,
): Promise<PaymentDto> {
  const { booking } = await requireBookingParticipant(userId, bookingId, 'customer');

  // AC-10: resolved BEFORE any row is written, so an unusable adapter never leaves a half-built
  // payment behind and never lets a sandbox run in production.
  const provider = resolvePaymentProvider();

  const fingerprint = idempotencyFingerprint({ bookingId, action: 'authorize' });

  const reserved = await reserveForAuthorization({
    userId,
    bookingId,
    idempotencyKey,
    fingerprint,
    provider,
  });
  if (reserved.replay) return reserved.replay;

  // Phase 2 — the one adapter call, outside every transaction and every lock.
  const result = await provider.authorize({
    idempotencyKey,
    amountMinorUnits: reserved.amountMinorUnits,
    currencyCode: reserved.currencyCode,
    reference: reserved.paymentId,
  });

  return recordAuthorizationOutcome({ userId, bookingId, reserved, result, provider, idempotencyKey });
}

/** Phase 1 — reserve. Commits a `created` payment (or recognises a replay) and nothing more. */
async function reserveForAuthorization(input: {
  userId: string;
  bookingId: string;
  idempotencyKey: string;
  fingerprint: string;
  provider: PaymentProvider;
}): Promise<ReservedPayment> {
  const { userId, bookingId, idempotencyKey, fingerprint, provider } = input;

  let reserved: ReservedPayment | null = null;

  const run = async () => {
    await getDb().transaction(async (tx) => {
      const context = await lockBookingContext(tx, bookingId);
      const existing = await lockPaymentRow(tx, bookingId);

      if (existing) {
        // AC-7 — same key, same fingerprint replays whatever is stored and makes NO adapter call.
        if (existing.idempotency_key === idempotencyKey) {
          if (existing.idempotency_fingerprint !== fingerprint) throw idempotencyKeyConflictError();
          if (existing.status === 'captured' || existing.status === 'authorized') {
            reserved = {
              paymentId: existing.id,
              version: existing.version,
              status: existing.status,
              amountMinorUnits: existing.charge_amount_minor_units,
              currencyCode: existing.charge_currency_code,
              providerReference: existing.provider_reference,
              replay: (await findPaymentByBookingId(bookingId, tx))!,
            };
            return;
          }
          if (existing.status === 'failed') throw paymentFailedError('previous_attempt_failed');
          // `created`/`requires_action` under the same key: the provider's own idempotency makes
          // re-calling it safe and is what turns an interrupted first attempt into a replay.
        } else if (context.bookingStatus !== 'pending') {
          // A different key on a booking that is no longer awaiting payment is not a retry.
          throw bookingNotAwaitingPaymentError(context.bookingStatus);
        }

        reserved = {
          paymentId: existing.id,
          version: existing.version,
          status: existing.status,
          amountMinorUnits: existing.charge_amount_minor_units,
          currencyCode: existing.charge_currency_code,
          providerReference: existing.provider_reference,
          replay: null,
        };
        return;
      }

      if (context.bookingStatus !== 'pending') throw bookingNotAwaitingPaymentError(context.bookingStatus);

      const timing = resolvePaymentTiming({ pricingModel: context.pricingModel });
      const amountMinorUnits = initialChargeAmountMinorUnits(timing, context.priceAmountMinorUnits);

      const inserted = await queryRows<{ id: string; version: number }>(
        tx,
        sql`INSERT INTO payments (
              booking_id, status, charge_amount_minor_units, charge_currency_code,
              protection_window_hours, provider_name, idempotency_key, idempotency_fingerprint
            ) VALUES (
              ${bookingId}, 'created', ${amountMinorUnits}, ${context.priceCurrencyCode},
              ${DEFAULT_PROTECTION_WINDOW_HOURS}, ${provider.name}, ${idempotencyKey}, ${fingerprint}
            ) RETURNING id, version`,
      );
      const row = inserted[0]!;
      await recordPaymentCreated(tx, { paymentId: row.id, actorUserId: userId });

      reserved = {
        paymentId: row.id,
        version: row.version,
        status: 'created',
        amountMinorUnits,
        currencyCode: context.priceCurrencyCode,
        providerReference: null,
        replay: null,
      };
    });
  };

  try {
    await run();
  } catch (err) {
    // I-1 backstop: a concurrent first-time authorization won the insert. Re-run, which now takes
    // the replay/retry path against the winner's row rather than creating a second payment (AC-7).
    if (isUniqueViolation(err, 'payments_booking_id_uq')) {
      await run();
    } else {
      throw err;
    }
  }

  if (!reserved) throw new Error(`payment reservation for booking ${bookingId} produced no result`);
  return reserved;
}

/** Phase 3 — record. Applies the provider's outcome, and only the provider's outcome. */
async function recordAuthorizationOutcome(input: {
  userId: string;
  bookingId: string;
  reserved: ReservedPayment;
  result: ProviderResult;
  provider: PaymentProvider;
  idempotencyKey: string;
}): Promise<PaymentDto> {
  const { userId, bookingId, reserved, result, provider, idempotencyKey } = input;

  let pendingCapture: { paymentId: string; version: number; amountMinorUnits: number; currencyCode: string } | null = null;
  let failure: { code?: string; kind: 'failed' | 'requires_action'; actionKind?: string } | null = null;

  await getDb().transaction(async (tx) => {
    const context = await lockBookingContext(tx, bookingId);
    const locked = await lockPaymentRow(tx, bookingId);
    if (!locked) throw new Error(`payment for booking ${bookingId} disappeared mid-flight`);

    if (result.outcome === 'failed') {
      // AC-6 — evidence, no status change, booking untouched and still `pending`.
      await recordAttempt(tx, {
        paymentId: locked.id,
        status: 'failed',
        providerReference: result.providerReference,
        failureCode: result.failureCode ?? 'declined',
        failureReason: result.failureMessage ?? null,
      });
      console.log(
        JSON.stringify({ event: 'payment.failed', paymentId: locked.id, bookingId, failureCode: result.failureCode ?? 'declined' }),
      );
      failure = { kind: 'failed', code: result.failureCode };
      return;
    }

    if (result.outcome === 'requires_action') {
      await recordAttempt(tx, {
        paymentId: locked.id,
        status: 'requires_action',
        providerReference: result.providerReference,
      });
      if (locked.status === 'created') {
        await applyPaymentTransition(tx, {
          paymentId: locked.id,
          from: 'created',
          to: 'requires_action',
          actorRole: 'customer',
          actorUserId: userId,
          expectedVersion: locked.version,
          set: { providerReference: result.providerReference },
        });
      }
      failure = { kind: 'requires_action', actionKind: result.actionKind };
      return;
    }

    if (locked.status === 'captured') return; // concurrent winner already finished the job.

    const applied = await recordAuthorization(tx, {
      paymentId: locked.id,
      from: locked.status,
      expectedVersion: locked.version,
      actorUserId: userId,
      actorRole: 'customer',
      amountMinorUnits: locked.charge_amount_minor_units,
      currencyCode: locked.charge_currency_code,
      result,
    });
    if (!applied.applied) {
      if (applied.currentStatus === 'captured') return;
      throw paymentVersionConflictError(applied.currentVersion);
    }

    if (applied.currentStatus === 'captured') {
      await confirmBookingAfterCapture(tx, context, userId);
      return;
    }

    // The adapter separates authorization from capture: capture in a second round trip below.
    pendingCapture = {
      paymentId: locked.id,
      version: applied.currentVersion,
      amountMinorUnits: locked.charge_amount_minor_units,
      currencyCode: locked.charge_currency_code,
    };
  });

  if (failure) {
    const detail = failure as { code?: string; kind: 'failed' | 'requires_action'; actionKind?: string };
    if (detail.kind === 'failed') throw paymentFailedError(detail.code);
    throw paymentRequiresActionError(detail.actionKind);
  }

  if (pendingCapture) {
    const capture = pendingCapture as { paymentId: string; version: number; amountMinorUnits: number; currencyCode: string };
    // Phase 2b — outside every transaction again, for the same reason phase 2 was.
    const captureResult = await provider.capture({
      idempotencyKey: `${idempotencyKey}:capture`,
      amountMinorUnits: capture.amountMinorUnits,
      currencyCode: capture.currencyCode,
      providerReference: result.providerReference,
    });
    await applyCapture({ userId, bookingId, paymentId: capture.paymentId, result: captureResult });
  }

  const payment = await findPaymentByBookingId(bookingId);
  if (!payment) throw new Error(`payment for booking ${bookingId} disappeared after recording`);
  console.log(JSON.stringify({ event: 'payment.authorize', paymentId: payment.id, bookingId, status: payment.status }));
  return payment;
}

/** Phase 3 for a capture round trip — used by both the inline capture and the capture route. */
async function applyCapture(input: {
  userId: string;
  bookingId: string;
  paymentId: string;
  result: ProviderResult;
}): Promise<void> {
  const { userId, bookingId, paymentId, result } = input;

  let failureCode: string | null = null;

  await getDb().transaction(async (tx) => {
    const context = await lockBookingContext(tx, bookingId);
    const locked = await lockPaymentRow(tx, bookingId);
    if (!locked) throw new Error(`payment ${paymentId} disappeared mid-capture`);
    if (locked.status === 'captured') {
      // A concurrent winner captured first; make sure the booking followed.
      await confirmBookingAfterCapture(tx, context, userId);
      return;
    }

    if (result.outcome !== 'captured') {
      await recordAttempt(tx, {
        paymentId: locked.id,
        status: 'failed',
        providerReference: result.providerReference,
        failureCode: result.failureCode ?? 'capture_failed',
        failureReason: result.failureMessage ?? null,
      });
      failureCode = result.failureCode ?? 'capture_failed';
      return;
    }

    const applied = await recordCapture(tx, {
      paymentId: locked.id,
      expectedVersion: locked.version,
      actorUserId: userId,
      actorRole: 'customer',
      amountMinorUnits: locked.charge_amount_minor_units,
      currencyCode: locked.charge_currency_code,
      result,
    });
    if (!applied.applied) {
      if (applied.currentStatus !== 'captured') throw paymentVersionConflictError(applied.currentVersion);
    }
    await confirmBookingAfterCapture(tx, context, userId);
  });

  if (failureCode) throw paymentFailedError(failureCode);
}

/**
 * AC-1/AC-6 — the ONE place `pending -> confirmed` happens once payment exists.
 *
 * Uses spec 020's `confirmBooking()` primitive with the customer as actor; this spec never writes
 * `bookings.status` with its own SQL. An already-confirmed booking is a no-op, so a replayed or
 * concurrent capture cannot write a second history row.
 */
async function confirmBookingAfterCapture(
  tx: Executor,
  context: BookingPaymentContext,
  userId: string,
): Promise<void> {
  if (context.bookingStatus !== 'pending') return;
  const confirmed = await confirmBooking(tx, {
    bookingId: context.bookingId,
    actorUserId: userId,
    expectedVersion: context.bookingVersion,
  });
  if (!confirmed.applied && confirmed.currentStatus !== 'confirmed') {
    throw paymentVersionConflictError(confirmed.currentVersion);
  }
}

/**
 * `POST /api/v1/bookings/{id}/payment/capture`.
 *
 * For `at_booking_confirmation` timing the authorize path already captured, so this is normally a
 * no-op replay — which is exactly what §3 says it should be. It exists as a real endpoint because
 * an adapter that separates authorization from capture needs one, and because a crash between the
 * two round trips must be recoverable without re-authorizing.
 */
export async function capturePayment(userId: string, bookingId: string, idempotencyKey: string): Promise<PaymentDto> {
  await requireBookingParticipant(userId, bookingId, 'customer');
  const provider = resolvePaymentProvider();

  const existing = await findPaymentByBookingId(bookingId);
  if (!existing) throw paymentNotAuthorizedError('none');

  const [row] = await queryRows<{ status: PaymentStatus; provider_reference: string | null; idempotency_key: string }>(
    getDb(),
    sql`SELECT status, provider_reference, idempotency_key FROM payments WHERE booking_id = ${bookingId}`,
  );
  if (!row) throw paymentNotAuthorizedError('none');

  if (row.status === 'captured') {
    // Same key ⇒ idempotent replay. A DIFFERENT key on an already-captured payment is a genuine
    // duplicate capture attempt, and says so rather than silently succeeding.
    if (row.idempotency_key === idempotencyKey) return existing;
    throw paymentAlreadyCapturedError();
  }
  if (row.status !== 'authorized' || !row.provider_reference) throw paymentNotAuthorizedError(row.status);

  const result = await provider.capture({
    idempotencyKey,
    amountMinorUnits: existing.chargeAmountMinorUnits,
    currencyCode: existing.chargeCurrencyCode,
    providerReference: row.provider_reference,
  });
  await applyCapture({ userId, bookingId, paymentId: existing.id, result });

  const payment = await findPaymentByBookingId(bookingId);
  if (!payment) throw new Error(`payment for booking ${bookingId} disappeared after capture`);
  console.log(JSON.stringify({ event: 'payment.capture', paymentId: payment.id, bookingId, status: payment.status }));
  return payment;
}
