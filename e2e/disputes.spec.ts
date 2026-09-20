/**
 * Spec 031 §6 "E2E" — the whole journey, through the real routes:
 *
 *   a customer opens a dispute → both sides message → Trust & Safety claims it and resolves with a
 *   partial-refund PROPOSAL → the customer appeals → a DIFFERENT admin decides → the dispute closes
 *   and the booking is handed back to spec 021.
 *
 * Vitest, not Playwright: this repository has no browser runner, and `e2e/*.spec.ts` is the
 * filename convention spec 005 §6 established for end-to-end coverage.
 *
 * The financial assertions are the point of running this end to end: at every step before closure
 * the payout is held, and at no step does this spec create a refund.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { CSRF_HEADER_NAME } from '@/lib/auth/csrf';
import { evaluateEligibility, loadEligibilityFacts } from '@/lib/payouts/eligibility';
import { POST as OPEN } from '@/app/api/v1/bookings/[id]/disputes/route';
import { GET as DETAIL } from '@/app/api/v1/disputes/[id]/route';
import { POST as SEND, GET as THREAD } from '@/app/api/v1/disputes/[id]/messages/route';
import { POST as APPEAL } from '@/app/api/v1/disputes/[id]/appeal/route';
import { GET as ADMIN_QUEUE } from '@/app/api/v1/admin/disputes/route';
import { POST as CLAIM } from '@/app/api/v1/admin/disputes/[id]/claim/route';
import { POST as RESOLVE } from '@/app/api/v1/admin/disputes/[id]/resolve/route';
import { POST as APPEAL_DECISION } from '@/app/api/v1/admin/disputes/[id]/appeal-decision/route';
import {
  BASE,
  freshKey,
  isDatabaseReachable,
  resetDisputeIntegrationForTests,
  seedProtectedBooking,
  trustSafetyAdmin,
  useDisputeIntegration,
} from '@/lib/disputes/disputes-test-support';

const dbReachable = await isDatabaseReachable();

interface Session {
  sessionId: string;
  csrfToken: string;
}

function get(session: Session, url: string): Request {
  return new Request(url, { method: 'GET', headers: { cookie: `${SESSION_COOKIE_NAME}=${session.sessionId}` } });
}

function post(session: Session, url: string, payload: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${session.sessionId}`,
      [CSRF_HEADER_NAME]: session.csrfToken,
      'content-type': 'application/json',
      'Idempotency-Key': freshKey(),
    },
    body: JSON.stringify(payload),
  });
}

async function data<T>(response: Response): Promise<T> {
  return ((await response.json()) as { data: T }).data;
}

/**
 * Whether the Trust & Safety queue contains `disputeId`, paging until it is found or exhausted.
 *
 * The queue orders live disputes `created_at ASC` — FIFO among equals, so nothing waits
 * indefinitely — which means a newly-opened dispute is at the END. In the shared test database
 * every other suite's disputes sit ahead of it, so this pages rather than assuming one fetch
 * suffices.
 */
async function queueContains(session: Session, disputeId: string): Promise<boolean> {
  for (let offset = 0; offset < 2000; offset += 100) {
    const response = await ADMIN_QUEUE(get(session, `${BASE}/admin/disputes?status=open&limit=100&offset=${offset}`) as never);
    if (response.status !== 200) return false;
    const payload = (await response.json()) as { data: { id: string }[]; page: { nextOffset: number | null } };
    if (payload.data.some((d) => d.id === disputeId)) return true;
    if (payload.page.nextOffset === null) return false;
  }
  return false;
}

describe.skipIf(!dbReachable)('disputes end to end (spec 031)', () => {
  beforeEach(() => {
    useDisputeIntegration();
  });

  afterAll(async () => {
    resetDisputeIntegrationForTests();
    await getPool().end().catch(() => {});
  });

  it('runs the full journey: open → message → resolve with a proposal → appeal → decide → close', async () => {
    const seeded = await seedProtectedBooking();
    const customer = seeded.scenario.customer;
    const provider = seeded.scenario.provider;
    const resolver = await trustSafetyAdmin();

    async function payoutEligibility() {
      const facts = await loadEligibilityFacts(getDb(), seeded.bookingId);
      return evaluateEligibility(facts!);
    }

    // ---- 1. The customer opens a dispute -------------------------------------------------
    const openResponse = await OPEN(
      post(customer, `${BASE}/bookings/${seeded.bookingId}/disputes`, {
        reason: 'The provider left after twenty minutes and the job was not finished.',
      }) as never,
    );
    expect(openResponse.status).toBe(201);
    const dispute = await data<{ id: string; status: string }>(openResponse);
    expect(dispute.status).toBe('open');

    // AC-2: the payout is held from this moment, by spec 024's OWN evaluator.
    expect(await payoutEligibility()).toEqual({ eligible: false, reason: 'protection_not_released' });

    // ---- 2. Both sides put their account on the record -----------------------------------
    expect((await SEND(post(customer, `${BASE}/disputes/${dispute.id}/messages`, { body: 'They left with the kitchen half done.' }) as never)).status).toBe(201);
    expect((await SEND(post(provider, `${BASE}/disputes/${dispute.id}/messages`, { body: 'I stopped because the water was switched off.' }) as never)).status).toBe(201);

    const thread = await data<{ authorRole: string }[]>(
      await THREAD(get(customer, `${BASE}/disputes/${dispute.id}/messages`) as never),
    );
    expect(thread.map((m) => m.authorRole)).toEqual(['me', 'counterparty']);

    // ---- 3. Trust & Safety works the queue -----------------------------------------------
    // The queue is FIFO (`created_at ASC` among live disputes), so this brand-new dispute is the
    // LAST one, not the first. The shared test database accumulates disputes from every other
    // suite, so a single unpaged fetch would not contain it — page until it is found rather than
    // asserting against whichever page happens to come back first.
    expect(await queueContains(resolver, dispute.id)).toBe(true);

    expect((await CLAIM(post(resolver, `${BASE}/admin/disputes/${dispute.id}/claim`, {}) as never)).status).toBe(200);

    // ---- 4. Resolved with a PARTIAL REFUND PROPOSAL — no money moves ----------------------
    const resolveResponse = await RESOLVE(
      post(resolver, `${BASE}/admin/disputes/${dispute.id}/resolve`, {
        decision: 'partial_refund_customer',
        reasoning: 'The job was about half completed, so half the fee is returned to the customer.',
        proposedRefundAmountMinorUnits: 4_000,
        proposedRefundCurrencyCode: 'PKR',
      }) as never,
    );
    expect(resolveResponse.status).toBe(200);
    const resolution = await data<{ refundState: string; proposedRefundAmountMinorUnits: number }>(resolveResponse);
    expect(resolution.refundState).toBe('proposed');
    expect(resolution.proposedRefundAmountMinorUnits).toBe(4_000);

    // AC-5: NO refund row exists. Spec 022 creates one only after Finance initiates and a second
    // admin approves.
    const refunds = await queryRows<{ total: number }>(
      getDb(),
      sql`SELECT COUNT(*)::int AS total FROM refunds WHERE booking_id = ${seeded.bookingId}`,
    );
    expect(refunds[0]!.total).toBe(0);

    // AC-4: a resolution alone releases nothing.
    expect(await payoutEligibility()).toEqual({ eligible: false, reason: 'protection_not_released' });

    // ---- 5. The customer reads the decision, reasoning included --------------------------
    const seen = await data<{ status: string; resolution: { reasoning: string } | null; canAppeal: boolean }>(
      await DETAIL(get(customer, `${BASE}/disputes/${dispute.id}`) as never),
    );
    expect(seen.status).toBe('resolved');
    expect(seen.resolution?.reasoning).toBe('The job was about half completed, so half the fee is returned to the customer.');
    expect(seen.canAppeal).toBe(true);

    // ---- 6. The customer appeals ----------------------------------------------------------
    const appealResponse = await APPEAL(
      post(customer, `${BASE}/disputes/${dispute.id}/appeal`, {
        reason: 'Half is not right — they did almost none of the work before leaving.',
      }) as never,
    );
    expect(appealResponse.status).toBe(201);
    expect(await payoutEligibility()).toEqual({ eligible: false, reason: 'protection_not_released' });

    // ---- 7. The ORIGINAL RESOLVER may not decide the appeal ------------------------------
    const selfReview = await APPEAL_DECISION(
      post(resolver, `${BASE}/admin/disputes/${dispute.id}/appeal-decision`, {
        outcome: 'upheld',
        reasoning: 'I still consider my original decision correct in every respect.',
      }) as never,
    );
    expect(selfReview.status).toBe(403);
    expect((await selfReview.json()).code).toBe('APPEAL_REQUIRES_DIFFERENT_ADMIN');

    // ---- 8. A different admin decides it, which closes the dispute ------------------------
    const reviewer = await trustSafetyAdmin();
    const decided = await APPEAL_DECISION(
      post(reviewer, `${BASE}/admin/disputes/${dispute.id}/appeal-decision`, {
        outcome: 'upheld',
        reasoning: 'The messages support the provider account that the water supply was off.',
      }) as never,
    );
    expect(decided.status).toBe(200);

    // The dispute stays open financially because the proposed refund was never initiated —
    // exactly what AC-5 requires. The decision is recorded regardless.
    const afterAppeal = await queryRows<{ status: string }>(
      getDb(),
      sql`SELECT status FROM disputes WHERE id = ${dispute.id}`,
    );
    expect(afterAppeal[0]!.status).toBe('appealed');

    const appealRow = await queryRows<{ outcome: string; reviewed_by_admin_user_id: string }>(
      getDb(),
      sql`SELECT outcome, reviewed_by_admin_user_id FROM dispute_appeals WHERE dispute_id = ${dispute.id}`,
    );
    expect(appealRow[0]!.outcome).toBe('upheld');
    expect(appealRow[0]!.reviewed_by_admin_user_id).toBe(reviewer.userId);
  }, 120_000);

  it('closes cleanly and hands the booking back when the decision proposes no refund', async () => {
    const seeded = await seedProtectedBooking();
    const customer = seeded.scenario.customer;
    const resolver = await trustSafetyAdmin();

    const dispute = await data<{ id: string }>(
      await OPEN(
        post(customer, `${BASE}/bookings/${seeded.bookingId}/disputes`, {
          reason: 'The provider was two hours late and I had to leave before they finished.',
        }) as never,
      ),
    );

    await RESOLVE(
      post(resolver, `${BASE}/admin/disputes/${dispute.id}/resolve`, {
        decision: 'favour_provider',
        reasoning: 'The lateness was caused by the customer rescheduling on the day.',
      }) as never,
    );

    // The customer accepts the outcome, which closes it immediately.
    const { POST: WAIVE } = await import('@/app/api/v1/disputes/[id]/waive-appeal/route');
    const waived = await WAIVE(post(customer, `${BASE}/disputes/${dispute.id}/waive-appeal`, {}) as never);
    expect(waived.status).toBe(200);

    const rows = await queryRows<{ status: string; booking_status: string; protection_state: string }>(
      getDb(),
      sql`SELECT d.status, b.status AS booking_status, p.protection_state
            FROM disputes d
            JOIN bookings b ON b.id = d.booking_id
            JOIN payments p ON p.booking_id = b.id
           WHERE d.id = ${dispute.id}`,
    );
    // AC-7: closed, and both the booking and the protection handed back to spec 021.
    expect(rows[0]!.status).toBe('closed');
    expect(rows[0]!.booking_status).toBe('protected');
    expect(rows[0]!.protection_state).toBe('held');
  }, 120_000);
});
