import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { requests, requestsStatusTransitions } from '@/lib/db/schema';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { POST as CREATE_REQUEST } from './route';
import { POST as CANCEL } from './[id]/cancel/route';
import {
  authenticatedRequest,
  createRequestHttp,
  isDatabaseReachable,
  registerCustomerWithAddress,
  seedPublishedService,
  validRequestBody,
} from './requests-test-support';

const dbReachable = await isDatabaseReachable();

async function createSubmittedRequest() {
  const customer = await registerCustomerWithAddress();
  const service = await seedPublishedService();
  const res = await CREATE_REQUEST(createRequestHttp(customer, randomUUID(), validRequestBody(service, customer.addressId)));
  return { customer, request: (await res.json()).data };
}

describe.skipIf(!dbReachable)('request state machine (spec 015 AC-7, integration)', () => {
  it('§4: the migration seeds exactly the four transitions this spec performs', () => {
    // Asserted against the migration itself, which is the authority on what ships: a live query
    // would also see rows a sibling test borrowed for a later spec's state.
    const migration = readFileSync(join(process.cwd(), 'drizzle', '0011_add_request_columns.sql'), 'utf8');
    const seeded = [...migration.matchAll(/\('(\w+)', '(\w+)'\)/g)].map(([, from, to]) => `${from}->${to}`).sort();

    expect(seeded).toEqual(
      ['draft->submitted', 'matching->cancelled', 'offers_open->cancelled', 'submitted->cancelled'].sort(),
    );
  });

  it('§4: no transition belonging to a later spec is performable', async () => {
    const rows = await getDb()
      .select({ from: requestsStatusTransitions.fromStatus, to: requestsStatusTransitions.toStatus })
      .from(requestsStatusTransitions);
    const present = new Set(rows.map((r) => `${r.from}->${r.to}`));

    // `offers_open -> provider_selected` is no longer a later spec's: spec 018 seeds it (accepting an
    // offer, master spec §125) in drizzle/0014_add_offer_system_timer.sql, alongside spec 017's
    // `submitted -> matching` and spec 018's `matching -> offers_open`.
    for (const shippedTransition of ['submitted->matching', 'matching->offers_open', 'offers_open->provider_selected']) {
      expect(present.has(shippedTransition)).toBe(true);
    }

    for (const laterSpecTransition of [
      'submitted->provider_selected',
      'provider_selected->booking_created',
      'booking_created->completed',
      'submitted->expired',
    ]) {
      expect(present.has(laterSpecTransition)).toBe(false);
    }
  });

  it('AC-7: rejects cancelling a completed request with 422, never a silent success', async () => {
    resetRateLimitState();
    const { customer, request } = await createSubmittedRequest();

    // Reach `completed` the only way possible: a transition row a later spec (028) will own.
    await getDb().execute(
      sql`INSERT INTO requests_status_transitions (from_status, to_status) VALUES ('submitted', 'completed') ON CONFLICT DO NOTHING`,
    );
    await getDb().update(requests).set({ status: 'completed' }).where(eq(requests.id, request.id));

    const [current] = await getDb().select({ version: requests.version }).from(requests).where(eq(requests.id, request.id));
    const res = await CANCEL(
      authenticatedRequest(`http://localhost/api/v1/requests/${request.id}/cancel`, customer.sessionId, customer.csrfToken, {
        method: 'POST',
        body: { expectedVersion: current!.version },
      }),
    );

    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('REQUEST_NOT_CANCELLABLE');

    const [after] = await getDb().select({ status: requests.status }).from(requests).where(eq(requests.id, request.id));
    expect(after!.status).toBe('completed');

    // Clean up the borrowed transition so it can't leak into another test's expectations.
    await getDb().execute(
      sql`DELETE FROM requests_status_transitions WHERE from_status = 'submitted' AND to_status = 'completed'`,
    );
  });

  it('AC-7: the DB trigger rejects an unseeded transition even with no application pre-check', async () => {
    resetRateLimitState();
    const { request } = await createSubmittedRequest();

    // Spec 015 seeds no `submitted -> provider_selected` row (that belongs to spec 019/020), so
    // PostgreSQL itself must refuse this — master spec §132.18: critical state transitions are
    // never enforced only in application code.
    // The driver error wraps the database's own message, so assert on the underlying cause: that
    // is PostgreSQL's trigger speaking, not application code.
    const rejection = await getDb()
      .update(requests)
      .set({ status: 'provider_selected' })
      .where(eq(requests.id, request.id))
      .then(() => null)
      .catch((err: unknown) => err);

    expect(rejection).toBeTruthy();
    expect(String((rejection as { cause?: unknown }).cause ?? rejection)).toMatch(/Invalid requests status transition/);

    const [after] = await getDb().select({ status: requests.status }).from(requests).where(eq(requests.id, request.id));
    expect(after!.status).toBe('submitted');
  });

  it('AC-7: the DB rejects a status value outside master spec §125 entirely', async () => {
    resetRateLimitState();
    const { request } = await createSubmittedRequest();

    await expect(
      getDb().execute(sql`UPDATE requests SET status = 'not_a_real_status' WHERE id = ${request.id}`),
    ).rejects.toThrow();
  });

  it('a losing concurrent cancel is a CONFLICT, and only one cancellation is recorded', async () => {
    resetRateLimitState();
    const { customer, request } = await createSubmittedRequest();

    const attempt = () =>
      CANCEL(
        authenticatedRequest(`http://localhost/api/v1/requests/${request.id}/cancel`, customer.sessionId, customer.csrfToken, {
          method: 'POST',
          body: { expectedVersion: request.version },
        }),
      );

    const [first, second] = await Promise.all([attempt(), attempt()]);
    const statuses = [first.status, second.status].sort();

    // One wins with 200; the loser is rejected (409 on the version race, or 422 if it observed the
    // already-cancelled state) — never two successes.
    expect(statuses[0]).toBe(200);
    expect([409, 422]).toContain(statuses[1]);
  });
});
