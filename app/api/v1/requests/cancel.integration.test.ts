import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { requests, requestsStatusHistory, requestsStatusTransitions } from '@/lib/db/schema';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { POST as CREATE_REQUEST } from './route';
import { POST as CANCEL } from './[id]/cancel/route';
import { GET as CANCEL_PREVIEW } from './[id]/cancel-preview/route';
import {
  authenticatedRequest,
  createRequestHttp,
  isDatabaseReachable,
  registerCustomerWithAddress,
  seedPublishedService,
  validRequestBody,
  type TestSession,
} from './requests-test-support';

const dbReachable = await isDatabaseReachable();

async function createSubmittedRequest() {
  const customer = await registerCustomerWithAddress();
  const service = await seedPublishedService();
  const res = await CREATE_REQUEST(createRequestHttp(customer, randomUUID(), validRequestBody(service, customer.addressId)));
  const { data } = await res.json();
  return { customer, service, request: data };
}

function previewRequest(session: TestSession, requestId: string): Request {
  return new Request(`http://localhost/api/v1/requests/${requestId}/cancel-preview`, {
    method: 'GET',
    headers: { cookie: `apuriva_session=${session.sessionId}` },
  });
}

function cancelRequestHttp(session: TestSession, requestId: string, expectedVersion: unknown): Request {
  return authenticatedRequest(`http://localhost/api/v1/requests/${requestId}/cancel`, session.sessionId, session.csrfToken, {
    method: 'POST',
    body: { expectedVersion },
  });
}

/** Moves a request into a state only a later spec can reach, so this spec's rules can be tested
 * against it. Written straight at the DB with the transition row the trigger requires, since spec
 * 015 itself seeds no `submitted -> matching`/`-> offers_open` transition of its own.
 *
 * Some of these transitions have since been permanently seeded by the later spec that owns them
 * (`submitted -> matching` by spec 017's own migration) — this helper must never delete a row it
 * did not itself borrow, or it would silently narrow what the database permits for every test that
 * runs after it in the same process. It therefore checks whether the row already existed BEFORE
 * inserting, and only removes it afterward if this call was the one that added it. */
async function forceStatus(requestId: string, status: 'matching' | 'offers_open' | 'completed', fromStatus: string) {
  const db = getDb();
  const [existing] = await db
    .select({ id: requestsStatusTransitions.id })
    .from(requestsStatusTransitions)
    .where(and(eq(requestsStatusTransitions.fromStatus, fromStatus), eq(requestsStatusTransitions.toStatus, status)));
  const alreadySeeded = Boolean(existing);

  if (!alreadySeeded) {
    await db.execute(
      sql`INSERT INTO requests_status_transitions (from_status, to_status) VALUES (${fromStatus}, ${status}) ON CONFLICT DO NOTHING`,
    );
  }
  await db.update(requests).set({ status }).where(eq(requests.id, requestId));
  // Remove the borrowed row immediately, but ONLY if this call was the one that added it — a
  // transition a shipped spec now seeds permanently must never be deleted by a test exercising a
  // different spec.
  if (!alreadySeeded) {
    await db.execute(
      sql`DELETE FROM requests_status_transitions WHERE from_status = ${fromStatus} AND to_status = ${status}`,
    );
  }
}

describe.skipIf(!dbReachable)('request cancellation (spec 015 AC-4, integration)', () => {
  it('AC-4: previews a null consequence, then cancels from submitted', async () => {
    resetRateLimitState();
    const { customer, request } = await createSubmittedRequest();

    const preview = await CANCEL_PREVIEW(previewRequest(customer, request.id));
    expect(preview.status).toBe(200);
    expect((await preview.json()).data).toEqual({
      cancellable: true,
      consequence: null,
      feeAmountMinorUnits: null,
      currencyCode: null,
    });

    const res = await CANCEL(cancelRequestHttp(customer, request.id, request.version));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.status).toBe('cancelled');
    expect(data.customerFacingStep).toBe('Cancelled');

    const history = await getDb()
      .select({ from: requestsStatusHistory.fromStatus, to: requestsStatusHistory.toStatus })
      .from(requestsStatusHistory)
      .where(eq(requestsStatusHistory.requestId, request.id))
      .orderBy(asc(requestsStatusHistory.occurredAt));
    expect(history).toEqual([
      { from: null, to: 'draft' },
      { from: 'draft', to: 'submitted' },
      { from: 'submitted', to: 'cancelled' },
    ]);
  });

  it('AC-4: cancels from matching and from offers_open too (every pre-selection state)', async () => {
    for (const [status, fromStatus] of [
      ['matching', 'submitted'],
      ['offers_open', 'submitted'],
    ] as const) {
      resetRateLimitState();
      const { customer, request } = await createSubmittedRequest();
      await forceStatus(request.id, status, fromStatus);

      const preview = await CANCEL_PREVIEW(previewRequest(customer, request.id));
      expect((await preview.json()).data.cancellable).toBe(true);

      const [current] = await getDb().select({ version: requests.version }).from(requests).where(eq(requests.id, request.id));
      const res = await CANCEL(cancelRequestHttp(customer, request.id, current!.version));
      expect(res.status).toBe(200);
      expect((await res.json()).data.status).toBe('cancelled');
    }
  });

  it('the preview is a dry run — it never mutates the request', async () => {
    resetRateLimitState();
    const { customer, request } = await createSubmittedRequest();

    await CANCEL_PREVIEW(previewRequest(customer, request.id));

    const [row] = await getDb().select({ status: requests.status, version: requests.version }).from(requests).where(eq(requests.id, request.id));
    expect(row).toMatchObject({ status: 'submitted', version: request.version });
  });

  it('rejects cancellation by someone who is not the owner, with 404 (never 403)', async () => {
    resetRateLimitState();
    const { request } = await createSubmittedRequest();
    const stranger = await registerCustomerWithAddress();

    const preview = await CANCEL_PREVIEW(previewRequest(stranger, request.id));
    expect(preview.status).toBe(404);
    expect((await preview.json()).code).toBe('REQUEST_NOT_FOUND');

    const res = await CANCEL(cancelRequestHttp(stranger, request.id, request.version));
    expect(res.status).toBe(404);

    const [row] = await getDb().select({ status: requests.status }).from(requests).where(eq(requests.id, request.id));
    expect(row!.status).toBe('submitted');
  });

  it('rejects a stale expectedVersion with 409 CONFLICT and leaves the request untouched', async () => {
    resetRateLimitState();
    const { customer, request } = await createSubmittedRequest();

    const res = await CANCEL(cancelRequestHttp(customer, request.id, request.version + 5));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CONFLICT');

    const [row] = await getDb().select({ status: requests.status }).from(requests).where(eq(requests.id, request.id));
    expect(row!.status).toBe('submitted');
  });

  it('a second cancel of an already-cancelled request is 422, not a silent success', async () => {
    resetRateLimitState();
    const { customer, request } = await createSubmittedRequest();

    const first = await CANCEL(cancelRequestHttp(customer, request.id, request.version));
    const cancelled = (await first.json()).data;

    const second = await CANCEL(cancelRequestHttp(customer, request.id, cancelled.version));
    expect(second.status).toBe(422);
    expect((await second.json()).code).toBe('REQUEST_NOT_CANCELLABLE');
  });

  it('requires CSRF on the cancel mutation', async () => {
    resetRateLimitState();
    const { customer, request } = await createSubmittedRequest();

    const res = await CANCEL(
      new Request(`http://localhost/api/v1/requests/${request.id}/cancel`, {
        method: 'POST',
        headers: { cookie: `apuriva_session=${customer.sessionId}`, 'content-type': 'application/json' },
        body: JSON.stringify({ expectedVersion: request.version }),
      }),
    );
    expect(res.status).toBe(403);
  });
});
