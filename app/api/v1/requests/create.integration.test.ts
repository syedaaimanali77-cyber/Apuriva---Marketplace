import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { requestFieldValues, requests, requestsStatusHistory, serviceFields } from '@/lib/db/schema';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { createRequest } from '@/lib/requests/create';
import { POST as CREATE_REQUEST } from './route';
import {
  createRequestHttp,
  customerProfileIdFor,
  isDatabaseReachable,
  registerCustomerWithAddress,
  seedDraftService,
  seedPublishedService,
  validRequestBody,
} from './requests-test-support';

const dbReachable = await isDatabaseReachable();

async function historyFor(requestId: string) {
  return getDb()
    .select({ from: requestsStatusHistory.fromStatus, to: requestsStatusHistory.toStatus, actor: requestsStatusHistory.actorUserId })
    .from(requestsStatusHistory)
    .where(eq(requestsStatusHistory.requestId, requestId))
    .orderBy(asc(requestsStatusHistory.occurredAt));
}

describe.skipIf(!dbReachable)('POST /api/v1/requests (spec 015 AC-1/AC-2/AC-3/AC-6, integration)', () => {
  it('AC-1: creates the row draft and transitions it to submitted, recording both history rows', async () => {
    resetRateLimitState();
    const customer = await registerCustomerWithAddress();
    const service = await seedPublishedService();

    const res = await CREATE_REQUEST(
      createRequestHttp(customer, randomUUID(), validRequestBody(service, customer.addressId)),
    );

    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data).toMatchObject({
      status: 'submitted',
      serviceId: service.id,
      serviceName: service.name,
      urgency: 'normal',
      offerCount: 0,
      // AC-5: the master spec §37 step, derived server-side.
      customerFacingStep: 'Request sent',
      budget: null,
    });
    expect(data.fieldValues).toEqual({ [service.requiredTextKey]: 'Dripping tap' });

    // AC-1: `status = 'submitted'` is itself what makes the request eligible for matching — there
    // is no separate eligibility flag anywhere on the row.
    const [row] = await getDb().select().from(requests).where(eq(requests.id, data.id));
    expect(row!.status).toBe('submitted');
    expect(Object.keys(row!)).not.toContain('matchingEligible');

    expect(await historyFor(data.id)).toEqual([
      { from: null, to: 'draft', actor: customer.userId },
      { from: 'draft', to: 'submitted', actor: customer.userId },
    ]);
  });

  it('AC-1: stores each field value against the ServiceField it answers', async () => {
    resetRateLimitState();
    const customer = await registerCustomerWithAddress();
    const service = await seedPublishedService();

    const res = await CREATE_REQUEST(
      createRequestHttp(
        customer,
        randomUUID(),
        validRequestBody(service, customer.addressId, {
          fieldValues: { [service.requiredTextKey]: 'Leaking pipe', [service.optionalSelectKey]: 'Someone home' },
        }),
      ),
    );
    const { data } = await res.json();

    const stored = await getDb()
      .select({ key: serviceFields.key, value: requestFieldValues.value })
      .from(requestFieldValues)
      .innerJoin(serviceFields, eq(serviceFields.id, requestFieldValues.serviceFieldId))
      .where(eq(requestFieldValues.requestId, data.id));

    expect(stored).toHaveLength(2);
    expect(Object.fromEntries(stored.map((r) => [r.key, r.value]))).toEqual({
      [service.requiredTextKey]: 'Leaking pipe',
      [service.optionalSelectKey]: 'Someone home',
    });
  });

  it('AC-2: rejects a missing required field by key and persists no row', async () => {
    resetRateLimitState();
    const customer = await registerCustomerWithAddress();
    const service = await seedPublishedService();

    const res = await CREATE_REQUEST(
      createRequestHttp(customer, randomUUID(), validRequestBody(service, customer.addressId, { fieldValues: {} })),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.errors).toEqual([{ field: service.requiredTextKey, message: 'What is the problem is required' }]);

    const rows = await getDb()
      .select({ id: requests.id })
      .from(requests)
      .where(eq(requests.customerProfileId, await customerProfileIdFor(customer.userId)));
    expect(rows).toEqual([]);
  });

  it('AC-2: rejects a select value outside the field\'s options (spec 011\'s shared validator)', async () => {
    resetRateLimitState();
    const customer = await registerCustomerWithAddress();
    const service = await seedPublishedService();

    const res = await CREATE_REQUEST(
      createRequestHttp(
        customer,
        randomUUID(),
        validRequestBody(service, customer.addressId, {
          fieldValues: { [service.requiredTextKey]: 'x', [service.optionalSelectKey]: 'Not an option' },
        }),
      ),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors[0].field).toBe(service.optionalSelectKey);
    expect(body.errors[0].message).toContain('must be one of');
  });

  it('AC-3: succeeds with budget omitted, with a target amount, and with a range', async () => {
    resetRateLimitState();
    const customer = await registerCustomerWithAddress();
    const service = await seedPublishedService();

    const omitted = await CREATE_REQUEST(
      createRequestHttp(customer, randomUUID(), validRequestBody(service, customer.addressId)),
    );
    expect(omitted.status).toBe(201);
    expect((await omitted.json()).data.budget).toBeNull();

    const amount = await CREATE_REQUEST(
      createRequestHttp(
        customer,
        randomUUID(),
        validRequestBody(service, customer.addressId, { budget: { amountMinorUnits: 300000, currencyCode: 'PKR' } }),
      ),
    );
    expect(amount.status).toBe(201);
    expect((await amount.json()).data.budget).toEqual({ amountMinorUnits: 300000, currencyCode: 'PKR' });

    const range = await CREATE_REQUEST(
      createRequestHttp(
        customer,
        randomUUID(),
        validRequestBody(service, customer.addressId, {
          budget: { minAmountMinorUnits: 200000, maxAmountMinorUnits: 500000, currencyCode: 'PKR' },
        }),
      ),
    );
    expect(range.status).toBe(201);
    expect((await range.json()).data.budget).toEqual({
      minAmountMinorUnits: 200000,
      maxAmountMinorUnits: 500000,
      currencyCode: 'PKR',
    });
  });

  it('AC-3: an invalid budget is a field error, never a database constraint violation', async () => {
    resetRateLimitState();
    const customer = await registerCustomerWithAddress();
    const service = await seedPublishedService();

    const res = await CREATE_REQUEST(
      createRequestHttp(
        customer,
        randomUUID(),
        validRequestBody(service, customer.addressId, {
          budget: { minAmountMinorUnits: 500000, maxAmountMinorUnits: 100000, currencyCode: 'PKR' },
        }),
      ),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).errors[0].field).toBe('budget.maxAmountMinorUnits');
  });

  it('rejects an address that is not the caller\'s, as a body-field error (never a 404)', async () => {
    resetRateLimitState();
    const customer = await registerCustomerWithAddress();
    const otherCustomer = await registerCustomerWithAddress();
    const service = await seedPublishedService();

    const res = await CREATE_REQUEST(
      createRequestHttp(customer, randomUUID(), validRequestBody(service, otherCustomer.addressId)),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors).toEqual([{ field: 'addressId', message: 'does not match one of your saved addresses' }]);
  });

  it('rejects an unpublished service — the same customer-facing visibility rule as the catalog', async () => {
    resetRateLimitState();
    const customer = await registerCustomerWithAddress();
    const draft = await seedDraftService();

    const res = await CREATE_REQUEST(
      createRequestHttp(customer, randomUUID(), {
        serviceId: draft.id,
        description: 'Anything',
        fieldValues: {},
        addressId: customer.addressId,
        urgency: 'normal',
      }),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).errors[0].field).toBe('serviceId');
  });

  it('§3: requires the Idempotency-Key header', async () => {
    resetRateLimitState();
    const customer = await registerCustomerWithAddress();
    const service = await seedPublishedService();

    const res = await CREATE_REQUEST(
      new Request('http://localhost/api/v1/requests', {
        method: 'POST',
        headers: {
          cookie: `apuriva_session=${customer.sessionId}`,
          'x-csrf-token': customer.csrfToken,
          'content-type': 'application/json',
        },
        body: JSON.stringify(validRequestBody(service, customer.addressId)),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors).toEqual([{ field: 'Idempotency-Key', message: 'is required' }]);
  });

  it('§3: same key + same body returns the same request with 200, and creates no second row', async () => {
    resetRateLimitState();
    const customer = await registerCustomerWithAddress();
    const service = await seedPublishedService();
    const key = randomUUID();
    const body = validRequestBody(service, customer.addressId);

    const first = await CREATE_REQUEST(createRequestHttp(customer, key, body));
    expect(first.status).toBe(201);
    const created = (await first.json()).data;

    const replay = await CREATE_REQUEST(createRequestHttp(customer, key, body));
    expect(replay.status).toBe(200);
    expect((await replay.json()).data.id).toBe(created.id);

    const rows = await getDb()
      .select({ id: requests.id })
      .from(requests)
      .where(eq(requests.customerProfileId, await customerProfileIdFor(customer.userId)));
    expect(rows).toHaveLength(1);

    // The replay must not re-record the lifecycle either.
    expect(await historyFor(created.id)).toHaveLength(2);
  });

  it('§3: a retry whose body differs only in property order is still the same request', async () => {
    resetRateLimitState();
    const customer = await registerCustomerWithAddress();
    const service = await seedPublishedService();
    const key = randomUUID();

    const first = await CREATE_REQUEST(
      createRequestHttp(customer, key, {
        serviceId: service.id,
        description: 'Same content',
        fieldValues: { [service.requiredTextKey]: 'x' },
        addressId: customer.addressId,
        urgency: 'normal',
      }),
    );
    const replay = await CREATE_REQUEST(
      createRequestHttp(customer, key, {
        urgency: 'normal',
        addressId: customer.addressId,
        fieldValues: { [service.requiredTextKey]: 'x' },
        description: 'Same content',
        serviceId: service.id,
      }),
    );

    expect(replay.status).toBe(200);
    expect((await replay.json()).data.id).toBe((await first.json()).data.id);
  });

  it('§3: same key + different body is 409 IDEMPOTENCY_KEY_CONFLICT, and writes no second request', async () => {
    resetRateLimitState();
    const customer = await registerCustomerWithAddress();
    const service = await seedPublishedService();
    const key = randomUUID();

    const first = await CREATE_REQUEST(
      createRequestHttp(customer, key, validRequestBody(service, customer.addressId)),
    );
    expect(first.status).toBe(201);

    const conflicting = await CREATE_REQUEST(
      createRequestHttp(
        customer,
        key,
        validRequestBody(service, customer.addressId, { description: 'A completely different job' }),
      ),
    );

    expect(conflicting.status).toBe(409);
    expect((await conflicting.json()).code).toBe('IDEMPOTENCY_KEY_CONFLICT');

    const rows = await getDb()
      .select({ id: requests.id })
      .from(requests)
      .where(eq(requests.customerProfileId, await customerProfileIdFor(customer.userId)));
    expect(rows).toHaveLength(1);
  });

  it('§3: the same key used by a different customer is not a conflict — keys are scoped per customer', async () => {
    resetRateLimitState();
    const first = await registerCustomerWithAddress();
    const second = await registerCustomerWithAddress();
    const service = await seedPublishedService();
    const sharedKey = randomUUID();

    const a = await CREATE_REQUEST(createRequestHttp(first, sharedKey, validRequestBody(service, first.addressId)));
    const b = await CREATE_REQUEST(createRequestHttp(second, sharedKey, validRequestBody(service, second.addressId)));

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect((await a.json()).data.id).not.toBe((await b.json()).data.id);
  });

  it('rejects an unauthenticated caller', async () => {
    resetRateLimitState();
    const res = await CREATE_REQUEST(
      new Request('http://localhost/api/v1/requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': randomUUID() },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('AC-6: the route adds no validation beyond createRequest — the domain function rejects the identical set', async () => {
    resetRateLimitState();
    const customer = await registerCustomerWithAddress();
    const service = await seedPublishedService();

    // The exact call a future MCP tool (spec 036) makes: same function, no HTTP involved.
    await expect(createRequest(customer.userId, randomUUID(), validRequestBody(service, customer.addressId, { fieldValues: {} })))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', errors: [{ field: service.requiredTextKey }] });

    const viaHttp = await CREATE_REQUEST(
      createRequestHttp(customer, randomUUID(), validRequestBody(service, customer.addressId, { fieldValues: {} })),
    );
    expect(viaHttp.status).toBe(400);
    expect((await viaHttp.json()).errors[0].field).toBe(service.requiredTextKey);

    // ...and the success path is identical too: the same authoritative function, same result shape.
    const direct = await createRequest(customer.userId, randomUUID(), validRequestBody(service, customer.addressId));
    expect(direct.request.status).toBe('submitted');
    expect(direct.replayed).toBe(false);

    const [row] = await getDb()
      .select({ status: requests.status })
      .from(requests)
      .where(and(eq(requests.id, direct.request.id), eq(requests.status, 'submitted')));
    expect(row).toBeDefined();
  });
});
