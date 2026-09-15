import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { GET as READ_BOOKING } from '@/app/api/v1/bookings/[id]/route';
import { GET as LIST_REFUNDS, POST as CREATE_REFUND } from '@/app/api/v1/bookings/[id]/refunds/route';
import {
  allowRefund,
  completeBookingFor,
  freshKey,
  isDatabaseReachable,
  resetRefundIntegration,
  seedCapturedBooking,
  sessionGet,
  sessionMutate,
  useRefundIntegration,
} from '@/lib/refunds/refunds-test-support';

/**
 * Spec 022 §6 "E2E (Vitest)".
 *
 * There is NO Playwright in this repository and none is introduced: `e2e/*.spec.ts` is a Vitest
 * pattern already configured in `vitest.config.ts`, driving the real route handlers against the
 * isolated `*_test` database. This walks the whole customer path — booking, payment, completion,
 * eligible refund — with no module mocked.
 */
const dbReachable = await isDatabaseReachable();
const SUITE_TIMEOUT_MS = 60_000;
const BASE = 'http://localhost/api/v1';

afterAll(async () => {
  await getPool().end();
});

function keyed(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.set('Idempotency-Key', freshKey());
  return new Request(request, { headers });
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe.skipIf(!dbReachable)('customer refund journey (spec 022)', { timeout: SUITE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    useRefundIntegration();
    registerBookingBusyIntervals();
  });

  afterEach(() => {
    resetRefundIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  /** AC-1 — an eligible decision refunds automatically, with no manual step anywhere in the path. */
  it('eligible cancellation refunds automatically', async () => {
    const { scenario, bookingId, capturedAmountMinorUnits } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);

    // Spec 023's decision, supplied through the port this spec ships.
    allowRefund(capturedAmountMinorUnits, 'Cancelled within the free window');

    const created = await CREATE_REFUND(keyed(sessionMutate(`${BASE}/bookings/${bookingId}/refunds`, scenario.customer, 'POST')));
    expect(created.status).toBe(201);
    expect((await body(created)).data).toMatchObject({
      status: 'completed',
      totalAmountMinorUnits: capturedAmountMinorUnits,
      reconciliationState: 'pending',
    });

    // The booking the customer comes back to reflects the full refund.
    const reread = await READ_BOOKING(sessionGet(`${BASE}/bookings/${bookingId}`, scenario.customer));
    expect((await body(reread)).data).toMatchObject({ status: 'refunded' });
  });

  /** AC-2 — a partial refund leaves the booking alone and shows the remaining position honestly. */
  it('a partial refund does not mark the booking refunded', async () => {
    const { scenario, bookingId, capturedAmountMinorUnits } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(Math.floor(capturedAmountMinorUnits / 4), 'Partial goodwill');

    await CREATE_REFUND(keyed(sessionMutate(`${BASE}/bookings/${bookingId}/refunds`, scenario.customer, 'POST')));

    const reread = await READ_BOOKING(sessionGet(`${BASE}/bookings/${bookingId}`, scenario.customer));
    const booking = (await body(reread)).data as { status: string };
    expect(booking.status).not.toBe('refunded');

    const listed = await LIST_REFUNDS(sessionGet(`${BASE}/bookings/${bookingId}/refunds`, scenario.customer));
    expect((await body(listed)).data).toHaveLength(1);
  });

  /** AC-8 end to end: a customer double-submitting is refunded once. */
  it('a double-submitted refund refunds once', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(50_000);

    const key = freshKey();
    const submit = () => {
      const headers = new Headers(sessionMutate(`${BASE}/bookings/${bookingId}/refunds`, scenario.customer, 'POST').headers);
      headers.set('Idempotency-Key', key);
      return CREATE_REFUND(new Request(`${BASE}/bookings/${bookingId}/refunds`, { method: 'POST', headers }));
    };

    const first = await submit();
    const second = await submit();

    expect(first.status).toBe(201);
    // The replay is a 200, not a second 201 — and the same refund.
    expect(second.status).toBe(200);
    const firstRefund = (await body(first)).data as { id: string };
    const secondRefund = (await body(second)).data as { id: string };
    expect(secondRefund.id).toBe(firstRefund.id);

    const listed = await LIST_REFUNDS(sessionGet(`${BASE}/bookings/${bookingId}/refunds`, scenario.customer));
    expect((await body(listed)).data).toHaveLength(1);
  });
});
