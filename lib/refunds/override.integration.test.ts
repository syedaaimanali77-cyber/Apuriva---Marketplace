import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import type { ApiRouteError } from '@/lib/api/errors';
import { decideAction } from '@/lib/admin-rbac/actions';
import { getSandboxPaymentProvider } from '@/lib/payments/provider';
import { grantRole, registerAdmin, type TestAdmin } from '@/app/api/v1/admin/admin-rbac-test-support';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { executeRefundOverride, initiateRefundOverride } from './override';
import {
  bookingStatusOf,
  completeBookingFor,
  freshKey,
  isDatabaseReachable,
  paymentStatusOf,
  resetRefundIntegration,
  seedCapturedBooking,
  storedRefunds,
  useRefundIntegration,
} from './refunds-test-support';

const dbReachable = await isDatabaseReachable();
const SUITE_TIMEOUT_MS = 60_000;

afterAll(async () => {
  await getPool().end();
});

async function expectError(fn: () => Promise<unknown>, code: string): Promise<ApiRouteError> {
  try {
    await fn();
  } catch (err) {
    expect((err as ApiRouteError).code).toBe(code);
    return err as ApiRouteError;
  }
  throw new Error(`expected ${code} to be thrown`);
}

/**
 * A Finance Admin. The `refunds/*` permissions come from migration 0018's own seed.
 *
 * Resets the rate-limit state first: each test here registers several accounts (a booking scenario
 * plus up to three admins), and the shared `auth` budget is small enough that a full-suite run
 * otherwise exhausts it and registration starts failing — the same reason `seedStranger` resets
 * between its own registrations.
 */
async function financeAdmin(): Promise<TestAdmin> {
  resetRateLimitState();
  const admin = await registerAdmin();
  await grantRole(admin, 'finance_admin');
  resetRateLimitState();
  return admin;
}

/**
 * Spec 022 §3 "Admin override" (AC-3).
 *
 * The threshold question is resolved by making the ACTION high-risk rather than inventing an
 * amount: `refunds/override` is seeded `high`, so EVERY manual refund needs a second, distinct
 * admin. These tests prove the gate cannot be walked around.
 */
describe.skipIf(!dbReachable)('refund admin override (spec 022 AC-3)', { timeout: SUITE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    useRefundIntegration();
    registerBookingBusyIntervals();
  });

  afterEach(() => {
    resetRefundIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
    vi.restoreAllMocks();
  });

  /** AC-3 — initiating creates a Pending AdminAction and NO refund; no provider call is made. */
  it('an override creates a Pending AdminAction and no refund', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    const admin = await financeAdmin();

    const refundSpy = vi.spyOn(getSandboxPaymentProvider(), 'refund');
    const result = await initiateRefundOverride({
      adminUserId: admin.userId,
      bookingId,
      amountMinorUnits: 50_000,
      currencyCode: 'PKR',
      reason: 'Goodwill after a service issue',
      idempotencyKey: freshKey(),
    });

    expect(result.outcome).toBe('pending_approval');
    expect(result.override.adminActionId).toBeTruthy();
    expect(result.override.amountMinorUnits).toBe(50_000);

    // Nothing has moved: no refund row, no provider call, payment untouched.
    expect(await storedRefunds(bookingId)).toEqual([]);
    expect(refundSpy).not.toHaveBeenCalled();
    expect(await paymentStatusOf(bookingId)).toBe('captured');
  });

  /** AC-3 — executing while the action is still `Pending` is refused with spec 009's own 422. */
  it('execution while Pending is 422 APPROVAL_REQUIRED', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    const admin = await financeAdmin();

    const { override } = await initiateRefundOverride({
      adminUserId: admin.userId,
      bookingId,
      amountMinorUnits: 50_000,
      currencyCode: 'PKR',
      reason: 'Goodwill',
      idempotencyKey: freshKey(),
    });

    const refundSpy = vi.spyOn(getSandboxPaymentProvider(), 'refund');
    const error = await expectError(
      () =>
        executeRefundOverride({
          adminUserId: admin.userId,
          adminActionId: override.adminActionId,
          amountMinorUnits: 50_000,
          currencyCode: 'PKR',
          idempotencyKey: freshKey(),
        }),
      'APPROVAL_REQUIRED',
    );
    expect(error.status).toBe(422);
    expect(refundSpy).not.toHaveBeenCalled();
    expect(await storedRefunds(bookingId)).toEqual([]);
  });

  /** AC-3 — a SECOND, DISTINCT admin approves, and only then does the refund execute. */
  it('a second distinct admin must approve before execution', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    const initiator = await financeAdmin();
    const approver = await financeAdmin();

    const { override } = await initiateRefundOverride({
      adminUserId: initiator.userId,
      bookingId,
      amountMinorUnits: 50_000,
      currencyCode: 'PKR',
      reason: 'Goodwill after a service issue',
      idempotencyKey: freshKey(),
    });

    await decideAction({ approverUserId: approver.userId, adminActionId: override.adminActionId, decision: 'approved' });

    const refund = await executeRefundOverride({
      adminUserId: initiator.userId,
      adminActionId: override.adminActionId,
      amountMinorUnits: 50_000,
      currencyCode: 'PKR',
      idempotencyKey: freshKey(),
    });

    expect(refund.status).toBe('completed');
    expect(refund.isOverride).toBe(true);
    expect(refund.source).toBe('admin_override');
    // C-5 — an override is always traceable to its approval chain.
    expect(refund.adminActionId ?? (await storedRefunds(bookingId))[0]!.admin_action_id).toBe(override.adminActionId);
    // The reason recorded on the line is the admin's stated reason (master spec §68).
    expect(refund.lines[0]!.reason).toBe('Goodwill after a service issue');
  });

  /** AC-3 — self-approval is impossible. Spec 009 enforces it; this proves the path inherits it. */
  it('self-approval is 409 SELF_APPROVAL_NOT_ALLOWED', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    const admin = await financeAdmin();

    const { override } = await initiateRefundOverride({
      adminUserId: admin.userId,
      bookingId,
      amountMinorUnits: 50_000,
      currencyCode: 'PKR',
      reason: 'Goodwill',
      idempotencyKey: freshKey(),
    });

    const error = await expectError(
      () => decideAction({ approverUserId: admin.userId, adminActionId: override.adminActionId, decision: 'approved' }),
      'SELF_APPROVAL_NOT_ALLOWED',
    );
    expect(error.status).toBe(409);
    expect(await storedRefunds(bookingId)).toEqual([]);
  });

  /** AC-3 — a rejected override never executes, however it is retried. */
  it('a rejected override never executes', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    const initiator = await financeAdmin();
    const approver = await financeAdmin();

    const { override } = await initiateRefundOverride({
      adminUserId: initiator.userId,
      bookingId,
      amountMinorUnits: 50_000,
      currencyCode: 'PKR',
      reason: 'Goodwill',
      idempotencyKey: freshKey(),
    });
    await decideAction({ approverUserId: approver.userId, adminActionId: override.adminActionId, decision: 'rejected' });

    const refundSpy = vi.spyOn(getSandboxPaymentProvider(), 'refund');
    await expectError(
      () =>
        executeRefundOverride({
          adminUserId: initiator.userId,
          adminActionId: override.adminActionId,
          amountMinorUnits: 50_000,
          currencyCode: 'PKR',
          idempotencyKey: freshKey(),
        }),
      'APPROVAL_NOT_ELIGIBLE',
    );
    expect(refundSpy).not.toHaveBeenCalled();
    expect(await storedRefunds(bookingId)).toEqual([]);
  });

  /** AC-3 — a duplicate approval is refused; spec 009's conditional update admits exactly one. */
  it('a duplicate approval is 409 APPROVAL_NOT_ELIGIBLE', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    const initiator = await financeAdmin();
    const approver = await financeAdmin();
    const other = await financeAdmin();

    const { override } = await initiateRefundOverride({
      adminUserId: initiator.userId,
      bookingId,
      amountMinorUnits: 50_000,
      currencyCode: 'PKR',
      reason: 'Goodwill',
      idempotencyKey: freshKey(),
    });
    await decideAction({ approverUserId: approver.userId, adminActionId: override.adminActionId, decision: 'approved' });

    await expectError(
      () => decideAction({ approverUserId: other.userId, adminActionId: override.adminActionId, decision: 'approved' }),
      'APPROVAL_NOT_ELIGIBLE',
    );
  });

  /** AC-3 — an executed override cannot be executed a second time. */
  it('an approved override executes only once', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    const initiator = await financeAdmin();
    const approver = await financeAdmin();

    const { override } = await initiateRefundOverride({
      adminUserId: initiator.userId,
      bookingId,
      amountMinorUnits: 50_000,
      currencyCode: 'PKR',
      reason: 'Goodwill',
      idempotencyKey: freshKey(),
    });
    await decideAction({ approverUserId: approver.userId, adminActionId: override.adminActionId, decision: 'approved' });

    await executeRefundOverride({
      adminUserId: initiator.userId,
      adminActionId: override.adminActionId,
      amountMinorUnits: 50_000,
      currencyCode: 'PKR',
      idempotencyKey: freshKey(),
    });

    await expectError(
      () =>
        executeRefundOverride({
          adminUserId: initiator.userId,
          adminActionId: override.adminActionId,
          amountMinorUnits: 50_000,
          currencyCode: 'PKR',
          idempotencyKey: freshKey(),
        }),
      'APPROVAL_NOT_ELIGIBLE',
    );
    expect(await storedRefunds(bookingId)).toHaveLength(1);
  });

  /** An admin without the `refunds/override` permission cannot initiate at all. */
  it('an admin without the refunds permission is 403 FORBIDDEN', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    const admin = await registerAdmin();
    await grantRole(admin, 'support_admin');

    const error = await expectError(
      () =>
        initiateRefundOverride({
          adminUserId: admin.userId,
          bookingId,
          amountMinorUnits: 50_000,
          currencyCode: 'PKR',
          reason: 'Goodwill',
          idempotencyKey: freshKey(),
        }),
      'FORBIDDEN',
    );
    expect(error.status).toBe(403);
    expect(await storedRefunds(bookingId)).toEqual([]);
  });

  /** Master spec §68 — an admin action always carries a reason. */
  it('requires a reason before anything is initiated', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    const admin = await financeAdmin();

    await expectError(
      () =>
        initiateRefundOverride({
          adminUserId: admin.userId,
          bookingId,
          amountMinorUnits: 50_000,
          currencyCode: 'PKR',
          reason: '   ',
          idempotencyKey: freshKey(),
        }),
      'REFUND_AMOUNT_INVALID',
    );
  });

  /** An override is still bound by the cap — approval does not license exceeding what was captured. */
  it('an approved override still cannot exceed the captured amount', async () => {
    const { scenario, bookingId, capturedAmountMinorUnits } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    const initiator = await financeAdmin();
    const approver = await financeAdmin();

    const { override } = await initiateRefundOverride({
      adminUserId: initiator.userId,
      bookingId,
      amountMinorUnits: capturedAmountMinorUnits + 1,
      currencyCode: 'PKR',
      reason: 'Too much',
      idempotencyKey: freshKey(),
    });
    await decideAction({ approverUserId: approver.userId, adminActionId: override.adminActionId, decision: 'approved' });

    await expectError(
      () =>
        executeRefundOverride({
          adminUserId: initiator.userId,
          adminActionId: override.adminActionId,
          amountMinorUnits: capturedAmountMinorUnits + 1,
          currencyCode: 'PKR',
          idempotencyKey: freshKey(),
        }),
      'REFUND_EXCEEDS_CAPTURED_AMOUNT',
    );
    expect(await storedRefunds(bookingId)).toEqual([]);
  });

  /**
   * §113 "Idempotency" — the conflicting-fingerprint path, exercised where the client DOES supply
   * an amount: the same key with a different amount is a genuinely different request.
   */
  it('idempotency: the same key with a different amount is 409 IDEMPOTENCY_KEY_CONFLICT', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    const initiator = await financeAdmin();
    const approver = await financeAdmin();

    const approveAndExecute = async (amountMinorUnits: number, key: string) => {
      const { override } = await initiateRefundOverride({
        adminUserId: initiator.userId,
        bookingId,
        amountMinorUnits,
        currencyCode: 'PKR',
        reason: 'Goodwill',
        idempotencyKey: key,
      });
      await decideAction({ approverUserId: approver.userId, adminActionId: override.adminActionId, decision: 'approved' });
      return executeRefundOverride({
        adminUserId: initiator.userId,
        adminActionId: override.adminActionId,
        amountMinorUnits,
        currencyCode: 'PKR',
        idempotencyKey: key,
      });
    };

    const key = freshKey();
    await approveAndExecute(40_000, key);

    await expectError(() => approveAndExecute(55_000, key), 'IDEMPOTENCY_KEY_CONFLICT');
    expect(await storedRefunds(bookingId)).toHaveLength(1);
    expect(await bookingStatusOf(bookingId)).not.toBe('refunded');
  });
});
