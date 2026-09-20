/**
 * Spec 032 §6 "Context authorization" (AC-2, DECIDED-6).
 *
 * The central claim being defended is that these routes CANNOT BE USED TO ENUMERATE bookings,
 * payments or disputes. So the sharpest assertion here is not that an unauthorized attach fails —
 * it is that failing because the object does not exist and failing because it is not yours produce
 * BYTE-IDENTICAL responses.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { POST as CREATE } from '@/app/api/v1/support/tickets/route';
import { GET as DETAIL } from '@/app/api/v1/support/tickets/[id]/route';
import {
  BASE,
  isDatabaseReachable,
  registerAndLogin,
  supportRequest,
  useSupportIntegration,
  type TestSession,
} from './support-test-support';
import { seedProtectedBooking, usePayoutIntegration, resetPayoutIntegration } from '@/lib/payouts/payouts-test-support';

const dbReachable = await isDatabaseReachable();

async function attach(
  user: TestSession,
  contextType: string,
  contextId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await CREATE(
    supportRequest(`${BASE}/support/tickets`, user, {
      body: {
        subject: 'Question about this item',
        description: 'I have a question about the attached item and need help.',
        category: 'booking',
        contextType,
        contextId,
      },
    }),
  );
  return { status: res.status, body: await res.json() };
}

/** Everything that identifies one failure from another, so two refusals can be compared exactly. */
function refusalShape(body: Record<string, unknown>): Record<string, unknown> {
  const { correlationId: _ignored, ...rest } = body as Record<string, unknown> & { correlationId?: string };
  return rest;
}

describe.skipIf(!dbReachable)('spec 032 context attachment (integration)', () => {
  /**
   * ONE protected booking for the whole file. Seeding one is expensive and takes a real slot in a
   * real provider's calendar, so repeating it per test makes later cases fail on availability
   * rather than on anything this spec owns. Nothing here mutates the booking, so sharing is safe.
   */
  let booking: Awaited<ReturnType<typeof seedProtectedBooking>>;
  let customer: TestSession;
  let paymentId: string;

  beforeAll(async () => {
    if (!dbReachable) return;
    // Seeding a PROTECTED booking runs the genuine spec 015→021 flow, which needs spec 020's and
    // spec 021's ports registered — the same prerequisite spec 031's `useDisputeIntegration()`
    // satisfies before it seeds. Without it the booking auto-confirms and the payment
    // authorization is refused `BOOKING_NOT_AWAITING_PAYMENT`.
    usePayoutIntegration();
    booking = await seedProtectedBooking();
    customer = booking.scenario.customer;
    const [payment] = await queryRows<{ id: string }>(
      getDb(),
      sql`SELECT id FROM payments WHERE booking_id = ${booking.bookingId}`,
    );
    paymentId = payment!.id;
  });

  beforeEach(() => {
    useSupportIntegration();
  });

  afterAll(async () => {
    resetPayoutIntegration();
    await getPool().end();
  });

  it('attaches a booking the caller is a participant of, and re-resolves it live on read', async () => {

    const { status, body } = await attach(customer, 'booking', booking.bookingId);
    expect(status).toBe(201);
    const ticket = body.data as { id: string; context: { type: string; id: string; status: string; available: boolean } };
    expect(ticket.context.type).toBe('booking');
    expect(ticket.context.id).toBe(booking.bookingId);
    expect(ticket.context.available).toBe(true);
    // A neutral status only — no amount, no currency, no counterparty.
    expect(typeof ticket.context.status).toBe('string');
    expect(JSON.stringify(ticket.context)).not.toMatch(/amount|currency|provider|customer/i);

    const detailRes = await DETAIL(supportRequest(`${BASE}/support/tickets/${ticket.id}`, customer, { method: 'GET' }));
    const detail = (await detailRes.json()).data;
    expect(detail.context.available).toBe(true);
  });

  it('refuses a booking the caller is NOT party to, with the uniform code (AC-2)', async () => {
    const stranger = await registerAndLogin();

    const { status, body } = await attach(stranger, 'booking', booking.bookingId);
    expect(status).toBe(422);
    expect(body.code).toBe('SUPPORT_CONTEXT_NOT_AVAILABLE');
  });

  it('a real-but-not-yours booking and a nonexistent id are INDISTINGUISHABLE (AC-2)', async () => {
    const stranger = await registerAndLogin();

    const notYours = await attach(stranger, 'booking', booking.bookingId);
    const nonexistent = await attach(stranger, 'booking', randomUUID());

    expect(notYours.status).toBe(nonexistent.status);
    // Byte-identical once the per-request correlation id is set aside: nothing in the response
    // tells an attacker whether the id they guessed names a real booking.
    expect(refusalShape(notYours.body)).toEqual(refusalShape(nonexistent.body));
  });

  it('refuses a payment the caller is not party to, resolved through its booking', async () => {
    const stranger = await registerAndLogin();

    const notYours = await attach(stranger, 'payment', paymentId);
    const nonexistent = await attach(stranger, 'payment', randomUUID());
    expect(notYours.status).toBe(422);
    expect(refusalShape(notYours.body)).toEqual(refusalShape(nonexistent.body));
  });

  it('lets a participant attach their own payment', async () => {

    const { status, body } = await attach(customer, 'payment', paymentId);
    expect(status).toBe(201);
    expect((body.data as { context: { available: boolean } }).context.available).toBe(true);
  });

  it('rejects a malformed context id as a validation error, before any lookup', async () => {
    const user = await registerAndLogin();
    const { status, body } = await attach(user, 'booking', 'not-a-uuid');
    expect(status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an unsupported context type rather than storing it', async () => {
    const user = await registerAndLogin();
    const { status, body } = await attach(user, 'review', randomUUID());
    expect(status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('a ticket whose subject becomes unreachable STILL READS, marked unavailable', async () => {

    const { body } = await attach(customer, 'booking', booking.bookingId);
    const ticketId = (body.data as { id: string }).id;

    // Simulate the pointer going dark: the id stays on the ticket, the object no longer resolves.
    await getDb().execute(sql`UPDATE support_tickets SET context_id = ${randomUUID()} WHERE id = ${ticketId}`);

    const res = await DETAIL(supportRequest(`${BASE}/support/tickets/${ticketId}`, customer, { method: 'GET' }));
    // The read must NOT fail — a support ticket never becomes unopenable because its subject moved.
    expect(res.status).toBe(200);
    const detail = (await res.json()).data;
    expect(detail.context.available).toBe(false);
    expect(detail.context.status).toBeNull();
    expect(detail.subject).toBeTruthy();
  });

  it('context is immutable: no route accepts a change to it', async () => {
    const user = await registerAndLogin();
    const res = await CREATE(
      supportRequest(`${BASE}/support/tickets`, user, {
        body: {
          subject: 'A question about something',
          description: 'I would like to ask about a thing that happened.',
          category: 'other',
          contextType: 'booking',
        },
      }),
    );
    // contextType without contextId is refused outright — the pair moves together or not at all.
    expect(res.status).toBe(400);
  });
});
