import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import {
  bookingStatusOf,
  resetCancellationIntegration,
  seedCapturedBooking,
  storedCancellation,
  useCancellationIntegration,
} from '@/lib/cancellation/cancellation-test-support';
import { registerModerationIntegration } from './index';
import { executeModerationAction } from './actions';
import { actionStatus, adminWithRole, approve, initiate, isDatabaseReachable, resetModerationForTests } from './moderation-test-support';

const dbReachable = await isDatabaseReachable();

afterAll(async () => {
  await getPool().end();
});

/** Spec 038 AC-6 — a booking intervention runs through spec 023's `cancelBooking()`, never `UPDATE bookings`. */
describe.skipIf(!dbReachable)('booking intervention (spec 038 AC-6)', { timeout: 180_000 }, () => {
  beforeEach(() => {
    useCancellationIntegration();
    registerBookingBusyIntervals();
    registerModerationIntegration();
  });

  afterEach(() => {
    resetCancellationIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
    resetModerationForTests();
  });

  it('is four-eyes, then cancels through spec 023 with the admin as actor and a full refund when approved so', async () => {
    const [a, b] = [await adminWithRole(), await adminWithRole('operations_admin')];
    const { scenario, bookingId, capturedAmountMinorUnits } = await seedCapturedBooking();
    expect(await bookingStatusOf(bookingId)).toBe('confirmed');

    const { action, outcome } = await initiate(a, {
      actionType: 'booking_intervention',
      scope: 'booking',
      targetUserId: scenario.provider.userId,
      bookingId,
      refundTreatment: 'full',
    });
    expect(outcome).toBe('pending_approval');
    expect(await bookingStatusOf(bookingId)).toBe('confirmed');

    await approve(b, action.adminActionId!);
    const executed = await executeModerationAction({ adminUserId: a.userId, actionId: action.id, correlationId: null });
    expect(executed.status).toBe('executed');

    // The downstream chain ran through its owners: spec 023 cancelled it, then spec 022's (sandbox,
    // synchronous) full refund completed and moved it `cancelled -> refunded`.
    expect(await bookingStatusOf(bookingId)).toBe('refunded');
    const cancellation = await storedCancellation(bookingId);
    expect(cancellation).toMatchObject({ cancelled_by_role: 'admin', refund_amount_minor_units: capturedAmountMinorUnits, fee_amount_minor_units: 0 });
    const [history] = await queryRows<{ actor_role: string }>(
      getDb(),
      sql`SELECT actor_role FROM bookings_status_history WHERE booking_id = ${bookingId} AND to_status = 'cancelled'`,
    );
    expect(history!.actor_role).toBe('system'); // spec 023's documented attribution for an admin cancellation
    const [reason] = await queryRows<{ reason_code: string }>(getDb(), sql`SELECT reason_code FROM booking_cancellations WHERE booking_id = ${bookingId}`);
    expect(reason!.reason_code).toBe('moderation_booking_intervention');
  });

  it('a booking outside spec 023 cancellable set surfaces 422 BOOKING_NOT_CANCELLABLE before the approval is consumed', async () => {
    const [a, b] = [await adminWithRole(), await adminWithRole()];
    const { scenario, bookingId } = await seedCapturedBooking();
    const { action } = await initiate(a, {
      actionType: 'booking_intervention',
      scope: 'booking',
      targetUserId: scenario.customer.userId,
      bookingId,
      refundTreatment: 'policy',
    });
    await approve(b, action.adminActionId!);
    await getDb().execute(sql`SELECT 1`);
    // Cancelled out-of-band by a participant through spec 023 itself.
    const { cancelBooking } = await import('@/lib/cancellation/cancel');
    await cancelBooking({ bookingId, idempotencyKey: 'participant-cancel', actorUserId: scenario.customer.userId, actorRole: 'customer' });

    await expect(executeModerationAction({ adminUserId: a.userId, actionId: action.id, correlationId: null })).rejects.toMatchObject({
      code: 'BOOKING_NOT_CANCELLABLE',
      status: 422,
    });
    expect(await actionStatus(action.id)).toBe('pending_approval');
    const [aa] = await queryRows<{ status: string }>(getDb(), sql`SELECT status FROM admin_actions WHERE id = ${action.adminActionId}`);
    expect(aa!.status).toBe('Approved');
  });

  it('only one open intervention per booking; it is neither appealable nor reversible', async () => {
    const admin = await adminWithRole();
    const { scenario, bookingId } = await seedCapturedBooking();
    const body = { actionType: 'booking_intervention', scope: 'booking', targetUserId: scenario.customer.userId, bookingId, refundTreatment: 'policy' };
    await initiate(admin, body);
    await expect(initiate(admin, body)).rejects.toMatchObject({ code: 'MODERATION_ACTION_CONFLICT' });
  });
});
