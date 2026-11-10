/**
 * Spec 023 §3 "The financial boundary" / "Idempotency and concurrency" (AC-3, AC-7, AC-8).
 *
 * This module decides a cancellation's consequence and records it. It EXECUTES nothing financial:
 * spec 022 owns refund execution, spec 021 owns the payment provider, and spec 020 owns the booking
 * status column. What this file produces is an authoritative decision plus one booking transition
 * performed through spec 020's own primitive.
 *
 * Ordering is deliberate and fixed:
 *   1. one transaction — lock the booking, resolve the snapshot, read the DATABASE clock and the
 *      captured amount, compute the consequence, transition the booking, insert the decision;
 *   2. AFTER commit — hand the decision to spec 022, which makes its own provider call outside any
 *      transaction of ours, and emit notifications fire-and-forget.
 *
 * Nothing about the amount ever comes from the client. `CancelBookingRequest` has no amount, tier,
 * percentage or timestamp field, and the route rejects any such property outright (AC-3).
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import { applyBookingTransition, isTransitionCheckViolation } from '@/lib/bookings/state-machine';
import { requireBookingParticipant } from '@/lib/bookings/read';
import { queryRows, isUniqueViolation, type Executor } from '@/lib/offers/db';
import type { BookingStatus } from '@/lib/types/bookings';
import type {
  CancellationConsequenceDto,
  CancellationDto,
  CancelledByRole,
  CancelBookingRequest,
} from '@/lib/types/cancellation';
import {
  bookingAlreadyCancelledError,
  bookingNotCancellableError,
  bookingVersionConflictError,
  cancellationConsequenceUnavailableError,
  idempotencyKeyConflictError,
  invalidStatusTransitionError,
} from './errors';
import { emitCancellationNotification } from './notifications';
import { ensurePolicyAcceptance, type ResolvedPolicy } from './resolution';
import { computeCancellationConsequence, toHoursBeforeMilli } from './tiers';

/**
 * Spec 023 §3 "Cancellation eligibility by booking state".
 *
 * `pending` is absent on purpose: nothing is captured, so there is no consequence to compute and no
 * money to move — spec 021's authorization-window sweep closes an abandoned one (`pending → failed`)
 * and this spec neither duplicates nor pre-empts it. `in_progress` onward is absent because the
 * service has started: that is a completion, execution (028) or dispute (031) matter, not a
 * timing-tier fee.
 */
export const CANCELLABLE_BOOKING_STATUSES: readonly BookingStatus[] = ['confirmed', 'provider_en_route', 'arrived'];

export function isCancellableBookingStatus(status: BookingStatus): boolean {
  return CANCELLABLE_BOOKING_STATUSES.includes(status);
}

interface BookingCancellationContext {
  bookingId: string;
  serviceId: string;
  status: BookingStatus;
  version: number;
  scheduledAt: Date;
  createdAt: Date;
  customerUserId: string;
  providerUserId: string;
  providerProfileId: string;
  priceCurrencyCode: string;
  providerOptionKey: string | null;
  hoursBefore: number;
  capturedAmountMinorUnits: number | null;
  capturedCurrencyCode: string | null;
}

/**
 * Locks the booking and reads everything the decision needs, including the clock.
 *
 * `clock_timestamp()` is read in THIS statement — after `FOR UPDATE` — so the tier is computed from
 * the instant the row was actually held, never from a transaction-start snapshot (`now()`), a client
 * clock or a client-supplied timestamp. A cancellation racing a lifecycle transition therefore
 * cannot slip into a cheaper tier (AC-8).
 *
 * The captured amount comes from `payment_authorizations` — spec 021's authority, which already
 * reflects any price adjustment — and never from `bookings.price_amount_minor_units`.
 */
async function lockBookingForCancellation(tx: Executor, bookingId: string): Promise<BookingCancellationContext | null> {
  await tx.execute(sql`SELECT id FROM bookings WHERE id = ${bookingId} FOR UPDATE`);

  const [row] = await queryRows<{
    id: string;
    service_id: string;
    status: BookingStatus;
    version: number;
    scheduled_at: Date;
    created_at: Date;
    customer_user_id: string;
    provider_user_id: string;
    provider_profile_id: string;
    price_currency_code: string;
    provider_option_key: string | null;
    hours_before: string | number;
    captured_amount_minor_units: number | null;
    captured_currency_code: string | null;
  }>(
    tx,
    sql`SELECT b.id,
               b.service_id,
               b.status,
               b.version,
               b.scheduled_at,
               b.created_at,
               cp.user_id AS customer_user_id,
               pp.user_id AS provider_user_id,
               b.provider_profile_id,
               b.price_currency_code,
               ps.cancellation_policy_option AS provider_option_key,
               EXTRACT(EPOCH FROM (b.scheduled_at - clock_timestamp())) / 3600 AS hours_before,
               pa.captured_amount_minor_units,
               pa.captured_currency_code
          FROM bookings b
          JOIN customer_profiles cp ON cp.id = b.customer_profile_id
          JOIN provider_profiles pp ON pp.id = b.provider_profile_id
          LEFT JOIN provider_services ps
                 ON ps.provider_profile_id = b.provider_profile_id AND ps.service_id = b.service_id
          LEFT JOIN payments p ON p.booking_id = b.id
          LEFT JOIN payment_authorizations pa ON pa.payment_id = p.id
         WHERE b.id = ${bookingId}`,
  );
  if (!row) return null;

  return {
    bookingId: row.id,
    serviceId: row.service_id,
    status: row.status,
    version: row.version,
    scheduledAt: new Date(row.scheduled_at),
    createdAt: new Date(row.created_at),
    customerUserId: row.customer_user_id,
    providerUserId: row.provider_user_id,
    providerProfileId: row.provider_profile_id,
    priceCurrencyCode: row.price_currency_code,
    providerOptionKey: row.provider_option_key,
    hoursBefore: Number(row.hours_before),
    capturedAmountMinorUnits: row.captured_amount_minor_units,
    capturedCurrencyCode: row.captured_currency_code,
  };
}

interface DecidedConsequence {
  policy: ResolvedPolicy;
  tier: { minHoursBefore: number | null; maxHoursBefore: number | null; feePercent: number };
  hoursBefore: number;
  capturedAmountMinorUnits: number;
  capturedCurrencyCode: string;
  feeAmountMinorUnits: number;
  refundAmountMinorUnits: number;
}

/**
 * The one computation both the preview and the execution use.
 *
 * `forceFullRefund` exists for exactly one caller: a Trust & Safety resolution that confirmed the
 * PROVIDER did not attend. A customer must never pay a timing fee for a provider's absence, so the
 * fee is zeroed — but the tier that would otherwise have applied is still recorded, so the audit
 * trail shows both what the ladder said and that the resolution overrode it.
 */
async function decideConsequence(
  tx: Executor,
  context: BookingCancellationContext,
  options: { forceFullRefund?: boolean } = {},
): Promise<DecidedConsequence> {
  const policy = await ensurePolicyAcceptance(tx, {
    bookingId: context.bookingId,
    serviceId: context.serviceId,
    customerUserId: context.customerUserId,
    bookingCreatedAt: context.createdAt,
    providerOptionKey: context.providerOptionKey,
  });

  if (context.capturedAmountMinorUnits === null || context.capturedCurrencyCode === null) {
    throw cancellationConsequenceUnavailableError('no_captured_amount');
  }

  const computed = computeCancellationConsequence({
    tiers: policy.tiers,
    hoursBefore: context.hoursBefore,
    capturedAmountMinorUnits: context.capturedAmountMinorUnits,
  });
  if (!computed) throw cancellationConsequenceUnavailableError('no_matching_tier');

  const feeAmountMinorUnits = options.forceFullRefund ? 0 : computed.feeAmountMinorUnits;

  return {
    policy,
    tier: computed.tier,
    hoursBefore: context.hoursBefore,
    capturedAmountMinorUnits: context.capturedAmountMinorUnits,
    capturedCurrencyCode: context.capturedCurrencyCode,
    feeAmountMinorUnits,
    refundAmountMinorUnits: context.capturedAmountMinorUnits - feeAmountMinorUnits,
  };
}

function toConsequenceDto(decided: DecidedConsequence): CancellationConsequenceDto {
  return {
    cancellable: true,
    tier: decided.tier,
    hoursBefore: Math.round(decided.hoursBefore * 1000) / 1000,
    capturedAmountMinorUnits: decided.capturedAmountMinorUnits,
    feeAmountMinorUnits: decided.feeAmountMinorUnits,
    refundAmountMinorUnits: decided.refundAmountMinorUnits,
    currencyCode: decided.capturedCurrencyCode,
    policyVersionId: decided.policy.policyVersionId,
    policySource: decided.policy.source,
    providerOptionKey: decided.policy.providerOptionKey,
  };
}

/**
 * `GET /bookings/{id}/cancel-preview` — the read-only dry run master spec §38 requires, so the
 * consequence is shown BEFORE the destructive action rather than inferred by the client.
 *
 * It runs in a transaction because materialising the booking's policy snapshot is a write; it never
 * transitions the booking and never records a decision.
 */
export async function previewCancellation(userId: string, bookingId: string): Promise<CancellationConsequenceDto> {
  const { booking } = await requireBookingParticipant(userId, bookingId);

  if (!isCancellableBookingStatus(booking.status)) {
    return {
      cancellable: false,
      blockedReason: booking.status === 'cancelled' ? 'BOOKING_ALREADY_CANCELLED' : 'BOOKING_NOT_CANCELLABLE',
    };
  }

  return getDb().transaction(async (tx) => {
    const context = await lockBookingForCancellation(tx, bookingId);
    if (!context) {
      return { cancellable: false, blockedReason: 'BOOKING_NOT_CANCELLABLE' } satisfies CancellationConsequenceDto;
    }
    if (!isCancellableBookingStatus(context.status)) {
      return {
        cancellable: false,
        blockedReason: context.status === 'cancelled' ? 'BOOKING_ALREADY_CANCELLED' : 'BOOKING_NOT_CANCELLABLE',
      } satisfies CancellationConsequenceDto;
    }
    return toConsequenceDto(await decideConsequence(tx, context));
  });
}

interface RecordedCancellation {
  row: CancellationDto;
  customerUserId: string;
  providerUserId: string;
  /** Null when the tier consumed the whole captured amount — there is nothing for spec 022 to do. */
  refundAmountMinorUnits: number;
  replay: boolean;
}

function toCancellationDto(row: {
  id: string;
  booking_id: string;
  cancelled_by_role: CancelledByRole;
  reason_code: string | null;
  policy_version_id: string;
  tier_min_hours_before: number | null;
  tier_max_hours_before: number | null;
  tier_fee_percent: number;
  captured_amount_minor_units: number;
  captured_currency_code: string;
  fee_amount_minor_units: number;
  refund_amount_minor_units: number;
  created_at: Date;
  version: number;
}): CancellationDto {
  return {
    id: row.id,
    bookingId: row.booking_id,
    cancelledByRole: row.cancelled_by_role,
    reasonCode: row.reason_code,
    policyVersionId: row.policy_version_id,
    tier: {
      minHoursBefore: row.tier_min_hours_before,
      maxHoursBefore: row.tier_max_hours_before,
      feePercent: row.tier_fee_percent,
    },
    capturedAmountMinorUnits: row.captured_amount_minor_units,
    feeAmountMinorUnits: row.fee_amount_minor_units,
    refundAmountMinorUnits: row.refund_amount_minor_units,
    currencyCode: row.captured_currency_code,
    bookingStatus: 'cancelled',
    createdAt: new Date(row.created_at).toISOString(),
    version: row.version,
  };
}

const CANCELLATION_COLUMNS = sql`id, booking_id, cancelled_by_role, reason_code, policy_version_id,
  tier_min_hours_before, tier_max_hours_before, tier_fee_percent, captured_amount_minor_units,
  captured_currency_code, fee_amount_minor_units, refund_amount_minor_units, created_at, version`;

export async function readCancellation(tx: Executor, bookingId: string): Promise<CancellationDto | null> {
  const [row] = await queryRows<Parameters<typeof toCancellationDto>[0]>(
    tx,
    sql`SELECT ${CANCELLATION_COLUMNS} FROM booking_cancellations WHERE booking_id = ${bookingId}`,
  );
  return row ? toCancellationDto(row) : null;
}

export interface CancelBookingInput {
  bookingId: string;
  idempotencyKey: string;
  actorUserId: string;
  actorRole: CancelledByRole;
  body?: CancelBookingRequest;
  /** Set by a Trust & Safety resolution; links the cancellation to the report that caused it. */
  noShowReportId?: string;
  /** A confirmed PROVIDER no-show: the customer pays no timing fee (§3 "Admin resolution"). */
  forceFullRefund?: boolean;
}

/**
 * Phase 1 — decide and record, in one transaction under the booking row lock.
 *
 * Every way this can go wrong is decided here, before any money is discussed with spec 022: the
 * status must still be cancellable under the lock, the snapshot must resolve, and the captured
 * amount must exist. The `booking_cancellations` insert is what claims the cancellation; its
 * `(booking_id)` unique index means a concurrent second cancellation cannot also succeed even if it
 * somehow passed the status check.
 */
async function recordCancellation(input: CancelBookingInput): Promise<RecordedCancellation> {
  const fingerprint = idempotencyFingerprint({
    bookingId: input.bookingId,
    reasonCode: input.body?.reasonCode ?? null,
    note: input.body?.note ?? null,
    actorRole: input.actorRole,
  });

  return getDb().transaction(async (tx) => {
    const context = await lockBookingForCancellation(tx, input.bookingId);
    if (!context) throw bookingNotCancellableError('unknown');

    // An existing cancellation under this exact key is a replay, decided under the lock.
    const [existing] = await queryRows<
      Parameters<typeof toCancellationDto>[0] & { idempotency_fingerprint: string }
    >(
      tx,
      sql`SELECT ${CANCELLATION_COLUMNS}, idempotency_fingerprint
            FROM booking_cancellations
           WHERE booking_id = ${input.bookingId} AND idempotency_key = ${input.idempotencyKey}
           FOR UPDATE`,
    );
    if (existing) {
      if (existing.idempotency_fingerprint !== fingerprint) throw idempotencyKeyConflictError();
      return {
        row: toCancellationDto(existing),
        customerUserId: context.customerUserId,
        providerUserId: context.providerUserId,
        refundAmountMinorUnits: existing.refund_amount_minor_units,
        replay: true,
      };
    }

    if (context.status === 'cancelled') throw bookingAlreadyCancelledError();
    if (!isCancellableBookingStatus(context.status)) throw bookingNotCancellableError(context.status);

    const decided = await decideConsequence(tx, context, { forceFullRefund: input.forceFullRefund });

    // Spec 020's booking-history vocabulary is `customer | provider | system` — it has no `admin`
    // actor, and widening it would be a change to spec 020's schema, not this spec's to make. A
    // Trust & Safety cancellation is therefore attributed to `system` in the BOOKING history (with a
    // null actor, as that table's pairing check requires) while the acting admin is recorded in full
    // on `booking_cancellations.cancelled_by_user_id`/`cancelled_by_role` and in spec 009's audit
    // event. No attribution is lost; it simply lives in this spec's own tables.
    const bookingActorRole = input.actorRole === 'admin' ? 'system' : input.actorRole;
    const transition = await applyBookingTransition(tx, {
      bookingId: input.bookingId,
      from: context.status,
      to: 'cancelled',
      actorRole: bookingActorRole,
      actorUserId: bookingActorRole === 'system' ? null : input.actorUserId,
      expectedVersion: context.version,
    });
    if (!transition.applied) {
      if (transition.currentStatus === 'cancelled') throw bookingAlreadyCancelledError();
      if (transition.currentStatus !== context.status) throw invalidStatusTransitionError(transition.currentStatus);
      throw bookingVersionConflictError(transition.currentVersion);
    }

    const decisionRef = `cancellation:${input.bookingId}:${decided.policy.policyVersionId}`;

    let inserted;
    try {
      [inserted] = await queryRows<Parameters<typeof toCancellationDto>[0]>(
        tx,
        sql`INSERT INTO booking_cancellations
              (booking_id, policy_version_id, cancelled_by_user_id, cancelled_by_role, reason_code, note,
               tier_min_hours_before, tier_max_hours_before, tier_fee_percent, hours_before_milli,
               captured_amount_minor_units, captured_currency_code, fee_amount_minor_units,
               refund_amount_minor_units, decision_ref, no_show_report_id, idempotency_key,
               idempotency_fingerprint)
            VALUES (${input.bookingId}, ${decided.policy.policyVersionId}, ${input.actorUserId},
                    ${input.actorRole}, ${input.body?.reasonCode ?? null}, ${input.body?.note ?? null},
                    ${decided.tier.minHoursBefore}, ${decided.tier.maxHoursBefore}, ${decided.tier.feePercent},
                    ${toHoursBeforeMilli(decided.hoursBefore)}, ${decided.capturedAmountMinorUnits},
                    ${decided.capturedCurrencyCode}, ${decided.feeAmountMinorUnits},
                    ${decided.refundAmountMinorUnits}, ${decisionRef}, ${input.noShowReportId ?? null},
                    ${input.idempotencyKey}, ${fingerprint})
            RETURNING ${CANCELLATION_COLUMNS}`,
      );
    } catch (err) {
      // Someone else claimed this booking's cancellation between our lock and this insert. Only
      // reachable if the row lock was bypassed; report it as the same conflict the caller expects.
      if (isUniqueViolation(err, 'booking_cancellations_booking_uq')) throw bookingAlreadyCancelledError();
      throw err;
    }

    console.log(
      JSON.stringify({
        event: 'cancellation.executed',
        bookingId: input.bookingId,
        policyVersionId: decided.policy.policyVersionId,
        feePercent: decided.tier.feePercent,
        actorRole: input.actorRole,
      }),
    );

    return {
      row: toCancellationDto(inserted!),
      customerUserId: context.customerUserId,
      providerUserId: context.providerUserId,
      refundAmountMinorUnits: decided.refundAmountMinorUnits,
      replay: false,
    };
  });
}

/**
 * `POST /bookings/{id}/cancel` — the whole flow.
 *
 * Phase 2 (the refund) happens strictly AFTER the transaction commits, by calling spec 022's own
 * entry point, which re-locks the booking and payment itself, consults this spec's eligibility gate
 * under that lock, and makes its provider call outside any transaction. We deliberately do not
 * import a provider, an adapter or a refund table here.
 *
 * A refund failure does not undo the cancellation: the booking IS cancelled, the decision IS
 * recorded, and spec 022 owns recovering an in-flight or failed refund (its sweep and its override
 * path). Rolling back a completed cancellation because money was slow would be worse in every way.
 */
export async function cancelBooking(input: CancelBookingInput): Promise<CancellationDto> {
  const recorded = await recordCancellation(input);

  if (!recorded.replay && recorded.refundAmountMinorUnits > 0) {
    const { requestPolicyRefund } = await import('@/lib/refunds/execute');
    try {
      await requestPolicyRefund(recorded.customerUserId, input.bookingId, `cancellation-${recorded.row.id}`);
    } catch (err) {
      // Spec 022 owns refund recovery. Log loudly and leave the cancellation standing.
      console.error(
        JSON.stringify({
          event: 'cancellation.refund_handoff_failed',
          bookingId: input.bookingId,
          cancellationId: recorded.row.id,
          message: err instanceof Error ? err.message : 'unknown',
        }),
      );
    }
  }

  if (!recorded.replay) {
    for (const recipientUserId of [recorded.customerUserId, recorded.providerUserId]) {
      void emitCancellationNotification({
        kind: 'booking_cancelled',
        bookingId: input.bookingId,
        recipientUserId,
        feeAmountMinorUnits: recorded.row.feeAmountMinorUnits,
        refundAmountMinorUnits: recorded.row.refundAmountMinorUnits,
        currencyCode: recorded.row.currencyCode,
      });
    }
  }

  return recorded.row;
}

/** The participant-facing entry point: resolves the caller's role, then cancels. */
export async function cancelBookingAsParticipant(
  userId: string,
  bookingId: string,
  mode: 'customer' | 'provider',
  idempotencyKey: string,
  body?: CancelBookingRequest,
): Promise<CancellationDto> {
  const { role } = await requireBookingParticipant(userId, bookingId, mode);
  try {
    return await cancelBooking({ bookingId, idempotencyKey, actorUserId: userId, actorRole: role, body });
  } catch (err) {
    // AC-6 of spec 020: the database trigger is the independent second line of defence. Map its
    // 23514 onto the same `409 INVALID_STATUS_TRANSITION` the application check produces, never a 500.
    if (isTransitionCheckViolation(err)) throw invalidStatusTransitionError('unknown');
    throw err;
  }
}
