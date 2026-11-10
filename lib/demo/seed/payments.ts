/**
 * Spec 045 AC-4 / D-4 — demo payments go through spec 021's UNCHANGED port and adapter selection.
 *
 * Exactly the two phases spec 021 §3 "Transaction and lock ordering" requires:
 *   1. `callPaymentAdapter()` — every provider round trip, OUTSIDE any transaction, through
 *      `resolvePaymentProvider()` (so `PAYMENT_PROVIDER=sandbox` is honoured and the sandbox keeps
 *      refusing under `NODE_ENV=production` — DEP-1 is not worked around). Each outcome comes from the
 *      adapter's documented deterministic test amounts: an amount ending 1102 is declined, 1103 requires
 *      action, anything else authorizes and captures.
 *   2. `recordPayment()` / `recordRefund()` — inside the provisioning transaction, through spec 021's
 *      `record.ts` (the only module that may write `authorized`/`captured`, and only from a `ProviderResult`)
 *      and spec 022's refund state machine. Nothing here fabricates an outcome: every status comes from a
 *      result the adapter returned.
 *
 * There is no demo branch in any payment, payout, notification or AI module (`lib/demo/boundary.test.ts`).
 */
import { sql } from 'drizzle-orm';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import { queryRows, type Executor } from '@/lib/offers/db';
import { resolvePaymentProvider, type ProviderRefundResult, type ProviderResult } from '@/lib/payments/provider';
import { DEFAULT_PROTECTION_WINDOW_HOURS } from '@/lib/payments/protection-window';
import { recordAttempt, recordAuthorization, recordCapture, openProtectionWindow, setProtectionState } from '@/lib/payments/record';
import { applyPaymentTransition, recordPaymentCreated } from '@/lib/payments/state-machine';
import { applyRefundTransition, recordRefundCreated } from '@/lib/refunds/state-machine';

/** What the provisioner asks the adapter for, per booking. */
export interface PaymentPlan {
  key: string;
  amountMinorUnits: number;
  currencyCode: string;
  /** Planned refunds, each with its own pre-generated id (spec 022 sends the refund id as the provider key). */
  refunds: { refundId: string; amountMinorUnits: number }[];
}

export interface AdapterOutcome {
  providerName: string;
  authorize: ProviderResult;
  capture: ProviderResult | null;
  refunds: Map<string, ProviderRefundResult>;
}

/** Phase 1 — every adapter call, outside any transaction. Throws the adapter's own refusal (DEP-1). */
export async function callPaymentAdapter(plans: PaymentPlan[]): Promise<Map<string, AdapterOutcome>> {
  const provider = resolvePaymentProvider();
  const outcomes = new Map<string, AdapterOutcome>();

  for (const plan of plans) {
    const authorize = await provider.authorize({
      idempotencyKey: `demo-authorize:${plan.key}`,
      amountMinorUnits: plan.amountMinorUnits,
      currencyCode: plan.currencyCode,
      reference: plan.key,
    });

    let capture: ProviderResult | null = null;
    if (authorize.outcome === 'authorized') {
      // Spec 021's `at_booking_confirmation` timing captures inline, right after the authorization.
      capture = await provider.capture({
        idempotencyKey: `demo-authorize:${plan.key}:capture`,
        amountMinorUnits: plan.amountMinorUnits,
        currencyCode: plan.currencyCode,
        providerReference: authorize.providerReference,
      });
    }

    const refunds = new Map<string, ProviderRefundResult>();
    if (capture?.outcome === 'captured') {
      for (const refund of plan.refunds) {
        refunds.set(
          refund.refundId,
          await provider.refund({
            idempotencyKey: refund.refundId,
            providerReference: authorize.providerReference,
            amountMinorUnits: refund.amountMinorUnits,
            currencyCode: plan.currencyCode,
          }),
        );
      }
    }

    outcomes.set(plan.key, { providerName: provider.name, authorize, capture, refunds });
  }
  return outcomes;
}

export interface RecordedPayment {
  paymentId: string;
  status: 'requires_action' | 'created' | 'captured';
  version: number;
}

/**
 * Phase 2 — the booking's `payments` row and the adapter's outcome, recorded as spec 021's
 * `authorizePayment` records it: `created`, then `authorized → captured`, or a `requires_action`
 * transition, or (a decline) a failed attempt that leaves the payment `created`.
 */
export async function recordPayment(
  tx: Executor,
  input: { bookingId: string; customerUserId: string; plan: PaymentPlan; outcome: AdapterOutcome },
): Promise<RecordedPayment> {
  const { plan, outcome } = input;
  const idempotencyKey = `demo-authorize:${plan.key}`;
  const [row] = await queryRows<{ id: string; version: number }>(
    tx,
    sql`INSERT INTO payments (
          booking_id, status, charge_amount_minor_units, charge_currency_code,
          protection_window_hours, provider_name, idempotency_key, idempotency_fingerprint
        ) VALUES (
          ${input.bookingId}, 'created', ${plan.amountMinorUnits}, ${plan.currencyCode},
          ${DEFAULT_PROTECTION_WINDOW_HOURS}, ${outcome.providerName}, ${idempotencyKey},
          ${idempotencyFingerprint({ bookingId: input.bookingId, action: 'authorize' })}
        ) RETURNING id, version`,
  );
  const paymentId = row!.id;
  await recordPaymentCreated(tx, { paymentId, actorUserId: input.customerUserId });

  const result = outcome.authorize;
  if (result.outcome === 'failed') {
    await recordAttempt(tx, {
      paymentId,
      status: 'failed',
      providerReference: result.providerReference,
      failureCode: result.failureCode ?? 'declined',
      failureReason: result.failureMessage ?? null,
    });
    return { paymentId, status: 'created', version: row!.version };
  }

  if (result.outcome === 'requires_action') {
    await recordAttempt(tx, { paymentId, status: 'requires_action', providerReference: result.providerReference });
    const moved = await applyPaymentTransition(tx, {
      paymentId,
      from: 'created',
      to: 'requires_action',
      actorRole: 'customer',
      actorUserId: input.customerUserId,
      expectedVersion: row!.version,
      set: { providerReference: result.providerReference },
    });
    return { paymentId, status: 'requires_action', version: moved.currentVersion };
  }

  const authorized = await recordAuthorization(tx, {
    paymentId,
    from: 'created',
    expectedVersion: row!.version,
    actorUserId: input.customerUserId,
    actorRole: 'customer',
    amountMinorUnits: plan.amountMinorUnits,
    currencyCode: plan.currencyCode,
    result,
  });
  if (!outcome.capture || outcome.capture.outcome !== 'captured') {
    throw new Error(`demo seed: the payment adapter did not capture ${plan.key}`);
  }
  const captured = await recordCapture(tx, {
    paymentId,
    expectedVersion: authorized.currentVersion,
    actorUserId: input.customerUserId,
    actorRole: 'customer',
    amountMinorUnits: plan.amountMinorUnits,
    currencyCode: plan.currencyCode,
    result: outcome.capture,
  });
  return { paymentId, status: 'captured', version: captured.currentVersion };
}

/** Spec 021's payment sweep, for a declined payment whose authorization window has run out. */
export async function failAbandonedPayment(tx: Executor, payment: RecordedPayment): Promise<RecordedPayment> {
  const moved = await applyPaymentTransition(tx, {
    paymentId: payment.paymentId,
    from: 'created',
    to: 'failed',
    actorRole: 'system',
    actorUserId: null,
    expectedVersion: payment.version,
  });
  if (!moved.applied) throw new Error(`demo seed: payment ${payment.paymentId} could not be failed`);
  return { ...payment, version: moved.currentVersion };
}

/** AC-5a — opens the protection window at the booking's completion instant, as the sweep does. */
export async function openProtection(tx: Executor, payment: RecordedPayment, completedAt: Date): Promise<RecordedPayment> {
  if (!(await openProtectionWindow(tx, { paymentId: payment.paymentId, startedAt: completedAt, expectedVersion: payment.version }))) {
    throw new Error(`demo seed: payment ${payment.paymentId} protection window could not be opened`);
  }
  return { ...payment, version: payment.version + 1 };
}

export async function moveProtection(
  tx: Executor,
  payment: RecordedPayment,
  from: 'held',
  to: 'released' | 'disputed',
): Promise<RecordedPayment> {
  if (!(await setProtectionState(tx, { paymentId: payment.paymentId, from, to, expectedVersion: payment.version }))) {
    throw new Error(`demo seed: payment ${payment.paymentId} protection could not move to ${to}`);
  }
  return { ...payment, version: payment.version + 1 };
}

/**
 * Spec 022's policy refund, recorded as `reserveRefund` + `executeReservedRefund` + `recordRefundOutcome`
 * record it: `requested` (with its line), `processing`, then the adapter's outcome, and the payment moved to
 * `refunded` or `partially_refunded`. Returns whether the payment is now fully refunded — the caller then
 * walks the booking to `refunded`, as `advancePaymentAndBooking` does.
 */
export async function recordRefund(
  tx: Executor,
  input: {
    refundId: string;
    bookingId: string;
    payment: RecordedPayment;
    capturedAmountMinorUnits: number;
    amountMinorUnits: number;
    currencyCode: string;
    providerReference: string;
    decisionRef: string;
    reason: string;
    actorUserId: string;
    result: ProviderRefundResult;
  },
): Promise<{ payment: RecordedPayment; fullyRefunded: boolean }> {
  if (input.result.outcome !== 'refunded') {
    throw new Error(`demo seed: the payment adapter did not complete refund ${input.refundId}`);
  }

  const [row] = await queryRows<{ version: number }>(
    tx,
    sql`INSERT INTO refunds (
          id, payment_id, booking_id, status, total_amount_minor_units, total_currency_code, source,
          is_override, initiated_by_user_id, eligibility_decision_ref, provider_reference,
          idempotency_key, idempotency_fingerprint
        ) VALUES (
          ${input.refundId}, ${input.payment.paymentId}, ${input.bookingId}, 'requested', ${input.amountMinorUnits},
          ${input.currencyCode}, 'policy', false, ${input.actorUserId}, ${input.decisionRef}, ${input.providerReference},
          ${`demo-refund:${input.refundId}`}, ${idempotencyFingerprint({ bookingId: input.bookingId, source: 'policy' })}
        ) RETURNING version`,
  );
  await tx.execute(sql`
    INSERT INTO refund_lines (refund_id, line_amount_minor_units, line_currency_code, reason)
    VALUES (${input.refundId}, ${input.amountMinorUnits}, ${input.currencyCode}, ${input.reason})
  `);
  await recordRefundCreated(tx, { refundId: input.refundId, actorUserId: input.actorUserId, actorRole: 'customer', detail: input.reason });

  const processing = await applyRefundTransition(tx, {
    refundId: input.refundId,
    from: 'requested',
    to: 'processing',
    actorRole: 'customer',
    actorUserId: input.actorUserId,
    expectedVersion: row!.version,
    detail: 'provider call starting',
  });
  await applyRefundTransition(tx, {
    refundId: input.refundId,
    from: 'processing',
    to: 'completed',
    actorRole: 'customer',
    actorUserId: input.actorUserId,
    expectedVersion: processing.currentVersion,
    set: { refundReference: input.result.refundReference, completedAt: 'now' },
  });

  const fullyRefunded = input.amountMinorUnits >= input.capturedAmountMinorUnits;
  const moved = await applyPaymentTransition(tx, {
    paymentId: input.payment.paymentId,
    from: 'captured',
    to: fullyRefunded ? 'refunded' : 'partially_refunded',
    actorRole: 'customer',
    actorUserId: input.actorUserId,
    expectedVersion: input.payment.version,
  });
  if (!moved.applied) throw new Error(`demo seed: payment ${input.payment.paymentId} could not record its refund`);
  return { payment: { ...input.payment, version: moved.currentVersion }, fullyRefunded };
}
