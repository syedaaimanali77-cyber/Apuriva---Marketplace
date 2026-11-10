/**
 * Spec 031 §6 — the HTTP surface: envelope, status codes, CSRF, idempotency and the participant /
 * admin routing every shared route performs.
 *
 * The handlers are driven directly with a plain `Request`, the way specs 029 and 030 drive theirs,
 * so the routing helpers (`disputeIdFromUrl`, `isParticipantOf`) are exercised as written.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BASE,
  freshKey,
  isDatabaseReachable,
  resetDisputeIntegrationForTests,
  seedProtectedBooking,
  trustSafetyAdmin,
  useDisputeIntegration,
  type SettledBooking,
  type TestAdmin,
} from '@/lib/disputes/disputes-test-support';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { CSRF_HEADER_NAME } from '@/lib/auth/csrf';
import { POST as openRoute } from '../bookings/[id]/disputes/route';
import { GET as listRoute } from './route';
import { GET as detailRoute } from './[id]/route';
import { GET as messagesGet, POST as messagesPost } from './[id]/messages/route';
import { POST as appealRoute } from './[id]/appeal/route';
import { GET as adminQueueRoute } from '../admin/disputes/route';
import { GET as adminDetailRoute } from '../admin/disputes/[id]/route';
import { POST as resolveRoute } from '../admin/disputes/[id]/resolve/route';

const reachable = await isDatabaseReachable();

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

interface Session {
  sessionId: string;
  csrfToken: string;
}

/** A GET carrying the session cookie. GETs change no state, so no CSRF header. */
function get(session: Session, url: string): Request {
  return new Request(url, { method: 'GET', headers: { cookie: `${SESSION_COOKIE_NAME}=${session.sessionId}` } });
}

/**
 * A state-changing request carrying the session cookie, the CSRF header and — unless explicitly
 * omitted — an `Idempotency-Key`. The shared `sessionMutate` helper has no slot for that header,
 * and every state-changing POST in this spec requires one.
 */
function mutate(session: Session, url: string, payload: unknown, idempotencyKey: string | null = freshKey()): Request {
  const headers: Record<string, string> = {
    cookie: `${SESSION_COOKIE_NAME}=${session.sessionId}`,
    [CSRF_HEADER_NAME]: session.csrfToken,
    'content-type': 'application/json',
  };
  if (idempotencyKey !== null) headers['Idempotency-Key'] = idempotencyKey;
  return new Request(url, { method: 'POST', headers, body: JSON.stringify(payload) });
}

describe.skipIf(!reachable)('dispute routes (spec 031 §3)', () => {
  let seeded: SettledBooking;
  let admin: TestAdmin;

  beforeAll(() => useDisputeIntegration());
  afterAll(() => resetDisputeIntegrationForTests());

  beforeEach(async () => {
    useDisputeIntegration();
    seeded = await seedProtectedBooking();
    admin = await trustSafetyAdmin();
  }, 60_000);

  function customer() {
    return seeded.scenario.customer;
  }

  async function openViaRoute(reason = 'The provider never arrived and did not call.') {
    const response = await openRoute(
      mutate(customer(), `${BASE}/bookings/${seeded.bookingId}/disputes`, { reason }) as never,
    );
    return response;
  }

  it('POST /bookings/{id}/disputes answers 201 with the spec 004 envelope', async () => {
    const response = await openViaRoute();
    expect(response.status).toBe(201);

    const payload = await body(response);
    expect(payload).toHaveProperty('data');
    expect(payload).toHaveProperty('correlationId');
    expect((payload.data as { status: string }).status).toBe('open');
  });

  it('requires an Idempotency-Key on every state-changing POST', async () => {
    const response = await openRoute(
      mutate(customer(), `${BASE}/bookings/${seeded.bookingId}/disputes`, { reason: 'The provider never arrived and did not call.' }, null) as never,
    );
    expect(response.status).toBe(400);
    expect((await body(response)).code).toBe('VALIDATION_ERROR');
  });

  it('replays an identical open as 200 rather than creating a second dispute', async () => {
    const key = freshKey();
    const make = () =>
      openRoute(
        mutate(customer(), `${BASE}/bookings/${seeded.bookingId}/disputes`, { reason: 'The provider never arrived and did not call.' }, key) as never,
      );

    expect((await make()).status).toBe(201);
    expect((await make()).status).toBe(200);
  });

  it('refuses a non-participant with 404 on POST, never 403', async () => {
    const stranger = await seedProtectedBooking();
    const response = await openRoute(
      mutate(stranger.scenario.customer, `${BASE}/bookings/${seeded.bookingId}/disputes`, { reason: 'A booking that is nothing to do with me.' }) as never,
    );
    expect(response.status).toBe(404);
  });

  it('GET /disputes returns only the caller own disputes', async () => {
    await openViaRoute();
    const other = await seedProtectedBooking();

    const mine = await listRoute(get(customer(), `${BASE}/disputes`) as never);
    expect(mine.status).toBe(200);
    const items = (await body(mine)).data as { bookingId: string }[];
    expect(items.every((d) => d.bookingId === seeded.bookingId)).toBe(true);

    const theirs = await listRoute(get(other.scenario.customer, `${BASE}/disputes`) as never);
    expect(((await body(theirs)).data as unknown[]).length).toBe(0);
  });

  it('GET /disputes/{id} answers 404 for a non-participant, never 403', async () => {
    const created = await body(await openViaRoute());
    const disputeId = (created.data as { id: string }).id;
    const stranger = await seedProtectedBooking();

    const response = await detailRoute(get(stranger.scenario.customer, `${BASE}/disputes/${disputeId}`) as never);
    expect(response.status).toBe(404);
    expect((await body(response)).code).toBe('NOT_FOUND');
  });

  it('routes a message POST by participation: the party posts as themselves', async () => {
    const created = await body(await openViaRoute());
    const disputeId = (created.data as { id: string }).id;

    const response = await messagesPost(
      mutate(customer(), `${BASE}/disputes/${disputeId}/messages`, { body: 'Nobody came to the door at all.' }) as never,
    );

    expect(response.status).toBe(201);
    const message = (await body(response)).data as { isAdmin: boolean; authorRole: string };
    expect(message.isAdmin).toBe(false);
    expect(message.authorRole).toBe('me');
  });

  it('routes a message POST by participation: an admin posts flagged isAdmin', async () => {
    const created = await body(await openViaRoute());
    const disputeId = (created.data as { id: string }).id;

    const response = await messagesPost(
      mutate(admin, `${BASE}/disputes/${disputeId}/messages`, { body: 'We are reviewing both accounts now.' }) as never,
    );

    expect(response.status).toBe(201);
    expect(((await body(response)).data as { isAdmin: boolean }).isAdmin).toBe(true);
  });

  it('GET messages is paged with the spec 004 page envelope', async () => {
    const created = await body(await openViaRoute());
    const disputeId = (created.data as { id: string }).id;

    const response = await messagesGet(get(customer(), `${BASE}/disputes/${disputeId}/messages?limit=10`) as never);
    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(payload).toHaveProperty('page');
    expect(payload.page).toHaveProperty('total');
  });

  it('GET /admin/disputes refuses an unauthorized admin with 403', async () => {
    await openViaRoute();
    const response = await adminQueueRoute(get(customer(), `${BASE}/admin/disputes`) as never);
    expect(response.status).toBe(403);
  });

  it('GET /admin/disputes serves an authorized admin', async () => {
    await openViaRoute();
    const response = await adminQueueRoute(get(admin, `${BASE}/admin/disputes`) as never);
    expect(response.status).toBe(200);
    expect(((await body(response)).data as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it('GET /admin/disputes/{id} exposes the admin-only fields the participant DTO withholds', async () => {
    const created = await body(await openViaRoute());
    const disputeId = (created.data as { id: string }).id;

    const response = await adminDetailRoute(get(admin, `${BASE}/admin/disputes/${disputeId}`) as never);
    expect(response.status).toBe(200);
    const dto = (await body(response)).data as Record<string, unknown>;
    expect(dto).toHaveProperty('openedByUserId');
    expect(dto).toHaveProperty('aiSummary');
    expect(dto).toHaveProperty('legalHold');
  });

  it('POST /admin/disputes/{id}/resolve records a decision and answers 200', async () => {
    const created = await body(await openViaRoute());
    const disputeId = (created.data as { id: string }).id;

    const response = await resolveRoute(
      mutate(admin, `${BASE}/admin/disputes/${disputeId}/resolve`, { decision: 'no_action', reasoning: 'Neither party substantiated their account.' }) as never,
    );

    expect(response.status).toBe(200);
    const resolution = (await body(response)).data as { decision: string; refundState: string };
    expect(resolution.decision).toBe('no_action');
    expect(resolution.refundState).toBe('none');
  });

  it('AC-5: rejects a refund decision with no amount at the route boundary', async () => {
    const created = await body(await openViaRoute());
    const disputeId = (created.data as { id: string }).id;

    const response = await resolveRoute(
      mutate(admin, `${BASE}/admin/disputes/${disputeId}/resolve`, { decision: 'refund_customer', reasoning: 'The customer should get their money back.' }) as never,
    );

    expect(response.status).toBe(400);
  });

  it('refuses an appeal before anything has been decided', async () => {
    const created = await body(await openViaRoute());
    const disputeId = (created.data as { id: string }).id;

    const response = await appealRoute(
      mutate(customer(), `${BASE}/disputes/${disputeId}/appeal`, { reason: 'Nothing has been decided yet, but I want to appeal.' }) as never,
    );

    expect(response.status).toBe(422);
    expect((await body(response)).code).toBe('APPEAL_NOT_AVAILABLE');
  });
});
