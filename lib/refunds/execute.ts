/**
 * Spec 022 §3 — refund execution (AC-1, AC-2, AC-5, AC-6, AC-7, AC-8).
 *
 * THREE PHASES, and a provider call is NEVER made inside a database transaction — the shape spec
 * 021 established and this spec extends:
 *
 *   1. reserve (tx)  lock booking → payment `FOR UPDATE`; consult eligibility or verify the
 *                    approval; evaluate I-2 under the lock; insert the `refunds` row `requested`
 *                    with its lines; commit. THE LOCK IS WHAT MAKES AC-8 STRUCTURAL.
 *   2. call (no tx)  move `requested → processing` in its own short transaction, then one
 *                    `provider.refund()` carrying the idempotency key. Moving to `processing`
 *                    BEFORE the call is deliberate: a crash mid-call then looks exactly like an
 *                    ambiguous outcome and is handled by the same recovery path, rather than
 *                    leaving a row that nothing will ever reconcile.
 *   3. record (tx)   re-lock in the same order; apply the outcome conditionally on `version`.
 *                    `refunded` → completed; definitive `failed` → failed; `unknown` → LEAVE
 *                    PROCESSING (AC-7).
 *
 * Lock ordering is `bookings → payments → refunds`, extending spec 021's fixed order, so no cycle
 * and no deadlock is possible between the two specs.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import { isUniqueViolation, queryRows, type Executor } from '@/lib/offers/db';
import { applyBookingTransition, requireBookingParticipant } from '@/lib/bookings';
import { applyPaymentTransition } from '@/lib/payments/state-machine';
import { resolvePaymentProvider, type PaymentProvider, type ProviderRefundResult } from '@/lib/payments/provider';
import type { BookingStatus } from '@/lib/types/bookings';
import type { PaymentStatus } from '@/lib/types/payments';
import type { RefundActorRole, RefundDto, RefundSource } from '@/lib/types/refunds';
import {
  fitsWithinRemaining,
  isFullyRefunded,
  isValidCurrencyCode,
  isValidRefundAmount,
  linesShareCurrency,
  linesSumTo,
  readRefundablePosition,
  type RefundLineInput,
} from './amounts';
import { getRefundEligibilityGate, invalidEligibilityField } from './eligibility';
import {
  alreadyFullyRefundedError,
  bookingNotRefundableError,
  idempotencyKeyConflictError,
  paymentNotCapturedError,
  refundAlreadyProcessingError,
  refundAmountInvalidError,
  refundCurrencyMismatchError,
  refundEligibilityInvalidError,
  refundExceedsCapturedAmountError,
  refundNotEligibleError,
  refundNotFoundError,
  refundVersionConflictError,
} from './errors';
import { emitRefundNotification } from './notifications';
import { emitRefundReconciliation } from './reconciliation';
import { loadRefundDto } from './read';
import { applyRefundTransition, recordRefundCreated } from './state-machine';

/**
 * §3 — the booking statuses from which a refund is possible at all.
 *
 * `refunded` is included deliberately, even though nothing more can be refunded from it: that
 * booking WAS refundable, so the accurate answer to a further request is the specific
 * `ALREADY_FULLY_REFUNDED` the cap check raises, not the misleading "this booking cannot be
 * refunded". `pending` and `failed` are the genuinely unrefundable ones — no money was ever taken.
 */
const REFUNDABLE_BOOKING_STATUSES: readonly BookingStatus[] = [
  'completed',
  'protected',
  'settled',
  'cancelled',
  'in_progress',
  'confirmed',
  'arrived',
  'provider_en_route',
  'disputed',
  'refunded',
] as const;

interface BookingRefundContext {
  bookingId: string;
  bookingStatus: BookingStatus;
  bookingVersion: number;
  currencyCode: string;
  customerUserId: string;
  providerProfileId: string;
  paymentId: string;
  paymentStatus: PaymentStatus;
  paymentVersion: number;
  paymentProviderReference: string | null;
}

/** Locks the booking, then its payment, in the fixed order. `null` when there is no booking. */
async function lockBookingAndPayment(tx: Executor, bookingId: string): Promise<BookingRefundContext | null> {
  await tx.execute(sql`SELECT id FROM bookings WHERE id = ${bookingId} FOR UPDATE`);

  const [booking] = await queryRows<{
    status: BookingStatus;
    version: number;
    price_currency_code: string;
    customer_user_id: string;
    provider_profile_id: string;
  }>(
    tx,
    sql`SELECT b.status, b.version, b.price_currency_code,
               cp.user_id AS customer_user_id, b.provider_profile_id
          FROM bookings b JOIN customer_profiles cp ON cp.id = b.customer_profile_id
         WHERE b.id = ${bookingId}`,
  );
  if (!booking) return null;

  const [payment] = await queryRows<{
    id: string;
    status: PaymentStatus;
    version: number;
    provider_reference: string | null;
  }>(
    tx,
    sql`SELECT id, status, version, provider_reference FROM payments WHERE booking_id = ${bookingId} FOR UPDATE`,
  );
  // The booking exists but was never paid for at all. That is precisely "nothing was captured", and
  // reporting it as a missing BOOKING would be both inaccurate and unhelpful to the caller — the
  // `404` is reserved for a booking the caller may not see.
  if (!payment) throw paymentNotCapturedError();

  return {
    bookingId,
    bookingStatus: booking.status,
    bookingVersion: booking.version,
    currencyCode: booking.price_currency_code,
    customerUserId: booking.customer_user_id,
    providerProfileId: booking.provider_profile_id,
    paymentId: payment.id,
    paymentStatus: payment.status,
    paymentVersion: payment.version,
    paymentProviderReference: payment.provider_reference,
  };
}

export interface ReserveRefundInput {
  bookingId: string;
  idempotencyKey: string;
  source: RefundSource;
  actorUserId: string | null;
  actorRole: RefundActorRole;
  /** Supplied on the override path; the eligibility gate supplies it on the policy path. */
  amountMinorUnits?: number;
  currencyCode?: string;
  reason?: string;
  adminActionId?: string;
}

interface ReservedRefund {
  refundId: string;
  version: number;
  amountMinorUnits: number;
  currencyCode: string;
  paymentId: string;
  providerReference: string;
  /** Set when phase 1 concluded this is a pure replay and no provider call is needed. */
  replay: RefundDto | null;
}

/**
 * Phase 1 — reserve.
 *
 * Everything that decides whether money may move happens here, under the payment row lock, in one
 * transaction: eligibility, the amount/currency checks, I-2's cap, and the insert that claims the
 * reservation. Nothing downstream can widen what this admitted.
 */
async function reserveRefund(input: ReserveRefundInput): Promise<ReservedRefund> {
  const fingerprint = idempotencyFingerprint({
    bookingId: input.bookingId,
    amountMinorUnits: input.amountMinorUnits ?? null,
    currencyCode: input.currencyCode ?? null,
    reason: input.reason ?? null,
    source: input.source,
  });

  let reserved: ReservedRefund | null = null;

  const run = async () => {
    await getDb().transaction(async (tx) => {
      const context = await lockBookingAndPayment(tx, input.bookingId);
      if (!context) throw refundNotFoundError();

      // An existing refund under this exact key is a replay, decided under the lock.
      const [existing] = await queryRows<{ id: string; idempotency_fingerprint: string; status: string }>(
        tx,
        sql`SELECT id, idempotency_fingerprint, status FROM refunds
             WHERE payment_id = ${context.paymentId} AND idempotency_key = ${input.idempotencyKey} FOR UPDATE`,
      );
      if (existing) {
        if (existing.idempotency_fingerprint !== fingerprint) throw idempotencyKeyConflictError();
        reserved = {
          refundId: existing.id,
          version: 0,
          amountMinorUnits: 0,
          currencyCode: context.currencyCode,
          paymentId: context.paymentId,
          providerReference: '',
          replay: await loadRefundDto(existing.id, { tx }),
        };
        return;
      }

      // `refunded` is admitted here deliberately: that payment WAS captured, so the accurate error
      // is the specific `ALREADY_FULLY_REFUNDED` the cap check below raises, not "never captured".
      if (
        context.paymentStatus !== 'captured' &&
        context.paymentStatus !== 'partially_refunded' &&
        context.paymentStatus !== 'refunded'
      ) {
        throw paymentNotCapturedError();
      }
      if (!REFUNDABLE_BOOKING_STATUSES.includes(context.bookingStatus)) {
        throw bookingNotRefundableError(context.bookingStatus);
      }
      if (!context.paymentProviderReference) throw paymentNotCapturedError();

      // AC-7's protection: while any refund on this payment has an unresolved provider outcome,
      // admitting another one risks acting on a position we cannot yet trust.
      const [inFlight] = await queryRows<{ id: string }>(
        tx,
        sql`SELECT id FROM refunds
             WHERE payment_id = ${context.paymentId} AND status = 'processing' LIMIT 1`,
      );
      if (inFlight) throw refundAlreadyProcessingError(inFlight.id);

      // Resolve the amount, currency and reason for this refund.
      let amountMinorUnits: number;
      let currencyCode: string;
      let reason: string;
      let decisionRef: string | null = null;

      if (input.source === 'policy') {
        // AC-1 — spec 023's decision, consulted INSIDE the transaction under the lock, so it can
        // never be stale by the time it is acted on.
        let decision;
        try {
          decision = await getRefundEligibilityGate()(tx, input.bookingId);
        } catch {
          throw refundNotEligibleError('eligibility_unavailable');
        }
        if (!decision.eligible) throw refundNotEligibleError('not_eligible');

        const invalidField = invalidEligibilityField(decision, context.currencyCode);
        if (invalidField === 'currencyCode' && decision.currencyCode && isValidCurrencyCode(decision.currencyCode)) {
          throw refundCurrencyMismatchError(context.currencyCode, decision.currencyCode);
        }
        if (invalidField) throw refundEligibilityInvalidError(invalidField);

        amountMinorUnits = decision.amountMinorUnits!;
        currencyCode = decision.currencyCode!;
        reason = decision.reason!.trim();
        decisionRef = decision.decisionRef ?? null;
      } else {
        if (!isValidRefundAmount(input.amountMinorUnits)) {
          throw refundAmountInvalidError('must be a positive integer number of minor units');
        }
        if (!isValidCurrencyCode(input.currencyCode)) {
          throw refundAmountInvalidError('currencyCode must be a three-letter ISO-4217 code');
        }
        if (input.currencyCode !== context.currencyCode) {
          throw refundCurrencyMismatchError(context.currencyCode, input.currencyCode!);
        }
        if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
          throw refundAmountInvalidError('reason is required');
        }
        amountMinorUnits = input.amountMinorUnits!;
        currencyCode = input.currencyCode!;
        reason = input.reason.trim();
      }

      // I-1 / I-2 / AC-5 / AC-8 — the cap, evaluated under the lock.
      const position = await readRefundablePosition(tx, context.paymentId);
      if (position.capturedAmountMinorUnits <= 0) throw paymentNotCapturedError();
      if (isFullyRefunded(position)) throw alreadyFullyRefundedError();
      if (!fitsWithinRemaining(amountMinorUnits, position)) {
        throw refundExceedsCapturedAmountError(position.remainingRefundableMinorUnits);
      }

      // I-5 / I-6 — one line per refund on both paths today; the sum and currency rules are still
      // checked here so a future multi-line caller cannot bypass them.
      const lines: RefundLineInput[] = [{ lineAmountMinorUnits: amountMinorUnits, lineCurrencyCode: currencyCode, reason }];
      if (!linesSumTo(lines, amountMinorUnits)) throw refundAmountInvalidError('lines must sum to the refund total');
      if (!linesShareCurrency(lines, currencyCode)) throw refundCurrencyMismatchError(currencyCode, lines[0]!.lineCurrencyCode);

      const inserted = await queryRows<{ id: string; version: number }>(
        tx,
        sql`INSERT INTO refunds (
              payment_id, booking_id, status, total_amount_minor_units, total_currency_code, source,
              is_override, initiated_by_user_id, admin_action_id, eligibility_decision_ref,
              provider_reference, idempotency_key, idempotency_fingerprint
            ) VALUES (
              ${context.paymentId}, ${input.bookingId}, 'requested', ${amountMinorUnits}, ${currencyCode},
              ${input.source}, ${input.source === 'admin_override'}, ${input.actorUserId},
              ${input.adminActionId ?? null}, ${decisionRef}, ${context.paymentProviderReference},
              ${input.idempotencyKey}, ${fingerprint}
            ) RETURNING id, version`,
      );
      const row = inserted[0]!;

      for (const line of lines) {
        await tx.execute(sql`
          INSERT INTO refund_lines (refund_id, line_amount_minor_units, line_currency_code, reason)
          VALUES (${row.id}, ${line.lineAmountMinorUnits}, ${line.lineCurrencyCode}, ${line.reason})
        `);
      }

      await recordRefundCreated(tx, {
        refundId: row.id,
        actorUserId: input.actorUserId,
        actorRole: input.actorRole,
        detail: reason,
      });

      console.log(
        JSON.stringify({ event: 'refund.requested', refundId: row.id, bookingId: input.bookingId, status: 'requested' }),
      );

      reserved = {
        refundId: row.id,
        version: row.version,
        amountMinorUnits,
        currencyCode,
        paymentId: context.paymentId,
        providerReference: context.paymentProviderReference,
        replay: null,
      };
    });
  };

  try {
    await run();
  } catch (err) {
    // C-1 backstop: a concurrent request under the same key won the insert. Re-run, which now takes
    // the replay path against the winner's row rather than creating a second refund.
    if (isUniqueViolation(err, 'refunds_payment_idempotency_key_uq')) {
      await run();
    } else {
      throw err;
    }
  }

  if (!reserved) throw new Error(`refund reservation for booking ${input.bookingId} produced no result`);
  return reserved;
}

/**
 * Phases 2 and 3 — call the provider, then record whatever it actually said.
 *
 * Exported so both the customer path and the admin override path share exactly one execution
 * routine: there is no second place in this codebase where a provider refund can be issued.
 */
export async function executeReservedRefund(
  reserved: ReservedRefund,
  actor: { userId: string | null; role: RefundActorRole },
  provider: PaymentProvider,
): Promise<RefundDto> {
  // Phase 2a — move to `processing` BEFORE the call, so a crash mid-call is indistinguishable from
  // an ambiguous outcome and is picked up by the same recovery path.
  await getDb().transaction(async (tx) => {
    const applied = await applyRefundTransition(tx, {
      refundId: reserved.refundId,
      from: 'requested',
      to: 'processing',
      actorRole: actor.role,
      actorUserId: actor.userId,
      expectedVersion: reserved.version,
      detail: 'provider call starting',
    });
    if (!applied.applied && applied.currentStatus !== 'processing') {
      throw refundVersionConflictError(applied.currentVersion);
    }
  });

  // Phase 2b — the one adapter call, outside every transaction and every lock.
  let result: ProviderRefundResult;
  try {
    result = await provider.refund({
      idempotencyKey: reserved.refundId,
      providerReference: reserved.providerReference,
      amountMinorUnits: reserved.amountMinorUnits,
      currencyCode: reserved.currencyCode,
    });
  } catch (err) {
    // AC-7 — a transport failure tells us NOTHING about whether the provider executed the refund.
    // Leave it `processing` for the sweep; never mark it failed.
    console.log(
      JSON.stringify({
        event: 'refund.outcome_unknown',
        refundId: reserved.refundId,
        status: 'processing',
        cause: 'transport_error',
        error: String(err),
      }),
    );
    return loadRefundDto(reserved.refundId);
  }

  return recordRefundOutcome(reserved.refundId, result, actor);
}

/**
 * Phase 3 — record the provider's outcome, and only the provider's outcome.
 *
 * Shared by the execution path and the reconcile sweep, so "what an outcome means" is defined once.
 */
export async function recordRefundOutcome(
  refundId: string,
  result: ProviderRefundResult,
  actor: { userId: string | null; role: RefundActorRole },
): Promise<RefundDto> {
  interface CompletionFacts {
    bookingId: string;
    paymentId: string;
    providerProfileId: string;
    customerUserId: string;
    amountMinorUnits: number;
    currencyCode: string;
  }
  interface FailureFacts {
    bookingId: string;
    customerUserId: string;
  }

  // Collected inside the transaction, acted on only after it commits.
  const outcome: { completion: CompletionFacts | null; failure: FailureFacts | null } = {
    completion: null,
    failure: null,
  };

  await getDb().transaction(async (tx) => {
    const [refund] = await queryRows<{
      id: string;
      booking_id: string;
      payment_id: string;
      status: string;
      version: number;
      total_amount_minor_units: number;
      total_currency_code: string;
    }>(
      tx,
      sql`SELECT id, booking_id, payment_id, status, version, total_amount_minor_units, total_currency_code
            FROM refunds WHERE id = ${refundId} FOR UPDATE`,
    );
    if (!refund) throw refundNotFoundError();

    // Terminal already (a concurrent sweep won): nothing to do, and nothing to double-apply.
    if (refund.status !== 'processing') return;

    // AC-7 — an unknown outcome changes NOTHING. The reservation stays held and the sweep retries
    // the status READ. This is the single most important branch in the file.
    if (result.outcome === 'unknown') {
      console.log(
        JSON.stringify({ event: 'refund.outcome_unknown', refundId, status: 'processing', cause: 'provider_unknown' }),
      );
      if (result.refundReference) {
        await tx.execute(sql`
          UPDATE refunds SET refund_reference = ${result.refundReference}, updated_at = clock_timestamp()
           WHERE id = ${refundId} AND refund_reference IS NULL
        `);
      }
      return;
    }

    const context = await lockBookingAndPayment(tx, refund.booking_id);
    if (!context) throw refundNotFoundError();

    if (result.outcome === 'failed') {
      // AC-6 — a DEFINITIVE failure. The reservation is released by reaching `failed` (I-7).
      const applied = await applyRefundTransition(tx, {
        refundId,
        from: 'processing',
        to: 'failed',
        actorRole: actor.role,
        actorUserId: actor.userId,
        expectedVersion: refund.version,
        detail: result.failureCode ?? 'refund_failed',
        set: {
          refundReference: result.refundReference,
          failureCode: result.failureCode ?? 'refund_failed',
          failureReason: result.failureMessage ?? null,
        },
      });
      if (!applied.applied && applied.currentStatus !== 'failed') {
        throw refundVersionConflictError(applied.currentVersion);
      }
      outcome.failure = { bookingId: refund.booking_id, customerUserId: context.customerUserId };
      return;
    }

    // `refunded` — the provider confirmed it.
    const applied = await applyRefundTransition(tx, {
      refundId,
      from: 'processing',
      to: 'completed',
      actorRole: actor.role,
      actorUserId: actor.userId,
      expectedVersion: refund.version,
      set: { refundReference: result.refundReference, completedAt: 'now' },
    });
    if (!applied.applied) {
      if (applied.currentStatus !== 'completed') throw refundVersionConflictError(applied.currentVersion);
      return;
    }

    await advancePaymentAndBooking(tx, context, actor);

    outcome.completion = {
      bookingId: refund.booking_id,
      paymentId: refund.payment_id,
      providerProfileId: context.providerProfileId,
      customerUserId: context.customerUserId,
      amountMinorUnits: refund.total_amount_minor_units,
      currencyCode: refund.total_currency_code,
    };
  });

  // Fire-and-forget, AFTER commit. Neither sink may roll back money that is already returned.
  const done = outcome.completion;
  if (done) {
    const dto = await loadRefundDto(refundId);
    await emitRefundReconciliation({
      refundId,
      bookingId: done.bookingId,
      paymentId: done.paymentId,
      providerProfileId: done.providerProfileId,
      amountMinorUnits: done.amountMinorUnits,
      currencyCode: done.currencyCode,
      completedAt: dto.completedAt ?? new Date().toISOString(),
    });
    await emitRefundNotification({
      kind: 'refund_completed',
      refundId,
      bookingId: done.bookingId,
      recipientUserId: done.customerUserId,
    });
  }

  const failed = outcome.failure;
  if (failed) {
    await emitRefundNotification({
      kind: 'refund_failed',
      refundId,
      bookingId: failed.bookingId,
      recipientUserId: failed.customerUserId,
    });
  }

  return loadRefundDto(refundId);
}

/**
 * Moves the payment — and, only when the money is FULLY back, the booking.
 *
 * `bookings.status = 'refunded'` means fully refunded. A partial refund moves the payment to
 * `partially_refunded` and leaves the booking untouched, because a partially refunded booking is
 * not a cancelled one. The booking write always goes through spec 020's `applyBookingTransition`
 * with `actorRole: 'system'`; this spec never writes `bookings.status` with its own SQL.
 */
async function advancePaymentAndBooking(
  tx: Executor,
  context: BookingRefundContext,
  actor: { userId: string | null; role: RefundActorRole },
): Promise<void> {
  const position = await readRefundablePosition(tx, context.paymentId);
  const fully = isFullyRefunded(position);

  const paymentActorRole = actor.role === 'system' ? 'system' : actor.role === 'admin' ? 'admin' : 'customer';
  const paymentActorUserId = paymentActorRole === 'system' ? null : actor.userId;

  const targetPaymentStatus: PaymentStatus = fully ? 'refunded' : 'partially_refunded';
  if (context.paymentStatus !== targetPaymentStatus) {
    const applied = await applyPaymentTransition(tx, {
      paymentId: context.paymentId,
      from: context.paymentStatus,
      to: targetPaymentStatus,
      actorRole: paymentActorRole,
      actorUserId: paymentActorUserId,
      expectedVersion: context.paymentVersion,
    });
    if (!applied.applied && applied.currentStatus !== targetPaymentStatus) {
      throw refundVersionConflictError(applied.currentVersion);
    }
  }

  if (!fully) return;

  const transitioned = await applyBookingTransition(tx, {
    bookingId: context.bookingId,
    from: context.bookingStatus,
    to: 'refunded',
    actorRole: 'system',
    actorUserId: null,
    expectedVersion: context.bookingVersion,
  });
  if (!transitioned.applied && transitioned.currentStatus !== 'refunded') {
    throw new Error(`booking ${context.bookingId} could not be marked refunded (${transitioned.currentStatus})`);
  }
}

/**
 * AC-1 — `POST /api/v1/bookings/{id}/refunds`: the customer-initiated, policy-driven path.
 *
 * Takes NO amount. The amount comes from spec 023's eligibility decision, server-side, always — a
 * client-supplied figure would be a client deciding how much money to send itself.
 */
export async function requestPolicyRefund(
  userId: string,
  bookingId: string,
  idempotencyKey: string,
): Promise<{ refund: RefundDto; created: boolean }> {
  await requireBookingParticipant(userId, bookingId, 'customer');
  const provider = resolvePaymentProvider();

  const reserved = await reserveRefund({
    bookingId,
    idempotencyKey,
    source: 'policy',
    actorUserId: userId,
    actorRole: 'customer',
  });
  if (reserved.replay) return { refund: reserved.replay, created: false };

  const refund = await executeReservedRefund(reserved, { userId, role: 'customer' }, provider);
  return { refund, created: true };
}

/** Shared by the admin override path once its approval has been granted. */
export async function executeApprovedRefund(input: {
  adminUserId: string;
  bookingId: string;
  amountMinorUnits: number;
  currencyCode: string;
  reason: string;
  adminActionId: string;
  idempotencyKey: string;
}): Promise<{ refund: RefundDto; created: boolean }> {
  const provider = resolvePaymentProvider();

  const reserved = await reserveRefund({
    bookingId: input.bookingId,
    idempotencyKey: input.idempotencyKey,
    source: 'admin_override',
    actorUserId: input.adminUserId,
    actorRole: 'admin',
    amountMinorUnits: input.amountMinorUnits,
    currencyCode: input.currencyCode,
    reason: input.reason,
    adminActionId: input.adminActionId,
  });
  if (reserved.replay) return { refund: reserved.replay, created: false };

  const refund = await executeReservedRefund(reserved, { userId: input.adminUserId, role: 'admin' }, provider);
  return { refund, created: true };
}
