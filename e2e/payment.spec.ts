import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { isDatabaseReachable } from '@/lib/db/test-support';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { POST as CREATE_BOOKING } from '@/app/api/v1/bookings/route';
import { GET as READ_BOOKING } from '@/app/api/v1/bookings/[id]/route';
import { POST as AUTHORIZE } from '@/app/api/v1/bookings/[id]/payment/authorize/route';
import { GET as READ_PAYMENT } from '@/app/api/v1/bookings/[id]/payment/route';
import {
  createBookingBody,
  freshKey,
  resetPaymentIntegration,
  seedBookingScenario,
  sessionGet,
  sessionMutate,
  storedPayment,
  usePaymentIntegration,
} from '@/lib/payments/payments-test-support';

/**
 * Spec 021 §6 "E2E (Vitest)".
 *
 * There is NO Playwright in this repository and none is introduced: `e2e/*.spec.ts` is a Vitest
 * pattern already configured in `vitest.config.ts`, driving the real route handlers against the
 * isolated `*_test` database. That is what "end-to-end" means here — the whole customer path from
 * booking creation through payment to a confirmed booking, with no module mocked.
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

describe.skipIf(!dbReachable)('customer payment journey (spec 021)', { timeout: SUITE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    usePaymentIntegration();
    registerBookingBusyIntervals();
  });

  afterEach(() => {
    resetPaymentIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  /**
   * AC-1/AC-6's positive path, end to end: the booking is created `pending` because spec 021's gate
   * is installed, and only the provider-confirmed capture moves it to `confirmed`.
   */
  it('creates a booking, pays, and sees a confirmed booking', async () => {
    const scenario = await seedBookingScenario();

    const created = await CREATE_BOOKING(
      keyed(sessionMutate(`${BASE}/bookings`, scenario.customer, 'POST', createBookingBody(scenario.offerId))),
    );
    expect(created.status).toBe(201);
    const booking = (await body(created)).data as { id: string; status: string };

    // The gate is what makes this `pending` rather than `confirmed` — spec 020 standalone returns
    // `confirmed`, and spec 020 §3 designed for exactly this interposition.
    expect(booking.status).toBe('pending');

    const paid = await AUTHORIZE(
      keyed(sessionMutate(`${BASE}/bookings/${booking.id}/payment/authorize`, scenario.customer, 'POST')),
    );
    expect(paid.status).toBe(200);
    expect((await body(paid)).data).toMatchObject({ status: 'captured' });

    const reread = await READ_BOOKING(sessionGet(`${BASE}/bookings/${booking.id}`, scenario.customer));
    expect((await body(reread)).data).toMatchObject({ id: booking.id, status: 'confirmed' });
  });

  /**
   * AC-6's negative path, end to end: the customer sees the §105 wording, and the booking they came
   * back to is still unconfirmed — nothing anywhere claimed a payment that did not happen.
   */
  it('failed payment confirms no booking', async () => {
    // The sandbox declines this amount by design (its reserved test suffix).
    const scenario = await seedBookingScenario({ priceAmountMinorUnits: 321_102 });

    const created = await CREATE_BOOKING(
      keyed(sessionMutate(`${BASE}/bookings`, scenario.customer, 'POST', createBookingBody(scenario.offerId))),
    );
    const booking = (await body(created)).data as { id: string; status: string };
    expect(booking.status).toBe('pending');

    const failed = await AUTHORIZE(
      keyed(sessionMutate(`${BASE}/bookings/${booking.id}/payment/authorize`, scenario.customer, 'POST')),
    );
    expect(failed.status).toBe(422);
    const error = await body(failed);
    expect(error.code).toBe('PAYMENT_FAILED');
    expect(error.message).toBe("Payment wasn't completed. No charge was confirmed.");

    const reread = await READ_BOOKING(sessionGet(`${BASE}/bookings/${booking.id}`, scenario.customer));
    expect((await body(reread)).data).toMatchObject({ status: 'pending' });

    // And the payment surface reports the truth: nothing captured, nothing protected.
    const payment = await READ_PAYMENT(sessionGet(`${BASE}/bookings/${booking.id}/payment`, scenario.customer));
    expect((await body(payment)).data).toMatchObject({ status: 'created', protectionState: null });
    expect((await storedPayment(booking.id))!.status).toBe('created');
  });

  /** AC-7 end to end: a customer double-submitting the pay button is charged once. */
  it('a double-submitted payment charges once', async () => {
    const scenario = await seedBookingScenario();

    const created = await CREATE_BOOKING(
      keyed(sessionMutate(`${BASE}/bookings`, scenario.customer, 'POST', createBookingBody(scenario.offerId))),
    );
    const booking = (await body(created)).data as { id: string };

    const key = freshKey();
    const submit = () => {
      const headers = new Headers(sessionMutate(`${BASE}/bookings/${booking.id}/payment/authorize`, scenario.customer, 'POST').headers);
      headers.set('Idempotency-Key', key);
      return AUTHORIZE(new Request(`${BASE}/bookings/${booking.id}/payment/authorize`, { method: 'POST', headers }));
    };

    const first = await submit();
    const second = await submit();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstPayment = (await body(first)).data as { id: string; version: number };
    const secondPayment = (await body(second)).data as { id: string; version: number };
    expect(secondPayment.id).toBe(firstPayment.id);
    expect(secondPayment.version).toBe(firstPayment.version);
  });
});
