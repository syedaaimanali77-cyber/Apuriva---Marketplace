import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { RATE_LIMIT_DEFAULTS, resetRateLimitState } from '@/lib/api/rate-limit';
import { OPENAPI_ROUTES } from '@/lib/api/openapi-registry';
import { authenticatedRequest, sessionGet, type TestSession } from '@/lib/bookings/bookings-test-support';
import {
  driveToInProgress,
  isDatabaseReachable,
  resetMessagingIntegration,
  resetServiceExecutionIntegration,
  seedConfirmedBooking,
  setCompletionEvidenceRequired,
  uploadEvidence,
  useMessagingIntegration,
  useServiceExecutionIntegration,
  useTemporaryStorageDir,
} from '@/lib/bookings/service-execution-test-support';
import { PATCH as SWITCH_MODE } from '@/app/api/v1/users/me/active-mode/route';
import { GET as GET_MILESTONES, POST as POST_MILESTONE } from './[id]/milestones/route';
import { GET as GET_EVIDENCE } from './[id]/evidence/route';
import { POST as COMPLETE } from './[id]/complete/route';

const dbReachable = await isDatabaseReachable();
const BASE = 'http://localhost/api/v1';
const SUITE_TIMEOUT_MS = 90_000;

function post(url: string, session: TestSession, init?: { body?: unknown; idempotencyKey?: string | null }): Request {
  const req = authenticatedRequest(url, session.sessionId, session.csrfToken, { method: 'POST', body: init?.body });
  if (init?.idempotencyKey) req.headers.set('Idempotency-Key', init.idempotencyKey);
  return req;
}

function postWithoutCsrf(url: string, session: TestSession, body?: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { cookie: `apuriva_session=${session.sessionId}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function switchMode(session: TestSession, mode: 'customer' | 'provider'): Promise<void> {
  await SWITCH_MODE(
    authenticatedRequest(`${BASE}/users/me/active-mode`, session.sessionId, session.csrfToken, {
      method: 'PATCH',
      body: { mode },
    }),
  );
}

/** Spec 028 §3 — transport concerns for the three routes this spec adds. */
describe.skipIf(!dbReachable)('service execution routes (spec 028 §3, integration)', { timeout: SUITE_TIMEOUT_MS }, () => {
  const storage = useTemporaryStorageDir();

  beforeEach(() => {
    useMessagingIntegration();
    useServiceExecutionIntegration();
  });
  afterEach(() => {
    resetMessagingIntegration();
    resetServiceExecutionIntegration();
  });
  afterAll(async () => {
    storage.cleanup();
    await getPool().end();
  });

  async function inProgress() {
    const seeded = await seedConfirmedBooking();
    await driveToInProgress(seeded.scenario, seeded.bookingId);
    await switchMode(seeded.scenario.provider, 'provider');
    resetRateLimitState();
    return seeded;
  }

  const milestoneUrl = (id: string) => `${BASE}/bookings/${id}/milestones`;
  const evidenceUrl = (id: string) => `${BASE}/bookings/${id}/evidence`;

  describe('POST /bookings/{id}/milestones', () => {
    it('201 on creation, 200 on an identical replay', async () => {
      const { scenario, bookingId } = await inProgress();
      const key = randomUUID();
      const body = { milestoneType: 'working', note: 'Halfway' };

      const created = await POST_MILESTONE(post(milestoneUrl(bookingId), scenario.provider, { body, idempotencyKey: key }));
      expect(created.status).toBe(201);
      const payload = await created.json();
      expect(payload.correlationId).toBeTruthy();
      expect(payload.data.milestoneType).toBe('working');

      const replay = await POST_MILESTONE(post(milestoneUrl(bookingId), scenario.provider, { body, idempotencyKey: key }));
      expect(replay.status).toBe(200);
      expect((await replay.json()).data.id).toBe(payload.data.id);
    });

    it('400 without an Idempotency-Key', async () => {
      const { scenario, bookingId } = await inProgress();
      const res = await POST_MILESTONE(
        post(milestoneUrl(bookingId), scenario.provider, { body: { milestoneType: 'working' }, idempotencyKey: null }),
      );
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('VALIDATION_ERROR');
    });

    it('403 CSRF_TOKEN_INVALID without the CSRF header', async () => {
      const { scenario, bookingId } = await inProgress();
      const res = await POST_MILESTONE(postWithoutCsrf(milestoneUrl(bookingId), scenario.provider, { milestoneType: 'working' }));
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('CSRF_TOKEN_INVALID');
    });

    it('401 when anonymous', async () => {
      const { bookingId } = await inProgress();
      const res = await POST_MILESTONE(
        new Request(milestoneUrl(bookingId), { method: 'POST', body: JSON.stringify({ milestoneType: 'working' }) }),
      );
      expect(res.status).toBe(401);
    });

    /** The customer is a participant, but this route is the provider's: wrong mode is `403`. */
    it('403 for a caller in customer mode', async () => {
      const { scenario, bookingId } = await inProgress();
      await switchMode(scenario.customer, 'customer');
      resetRateLimitState();
      const res = await POST_MILESTONE(
        post(milestoneUrl(bookingId), scenario.customer, {
          body: { milestoneType: 'working' },
          idempotencyKey: randomUUID(),
        }),
      );
      expect(res.status).toBe(403);
    });

    it('404 for a non-participant provider', async () => {
      const { bookingId } = await inProgress();
      const stranger = await seedConfirmedBooking();
      await switchMode(stranger.scenario.provider, 'provider');
      resetRateLimitState();

      const res = await POST_MILESTONE(
        post(milestoneUrl(bookingId), stranger.scenario.provider, {
          body: { milestoneType: 'working' },
          idempotencyKey: randomUUID(),
        }),
      );
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe('BOOKING_NOT_FOUND');
    });

    it('400 for a milestone type outside the closed vocabulary', async () => {
      const { scenario, bookingId } = await inProgress();
      const res = await POST_MILESTONE(
        post(milestoneUrl(bookingId), scenario.provider, {
          body: { milestoneType: 'nearly_there' },
          idempotencyKey: randomUUID(),
        }),
      );
      expect(res.status).toBe(400);
    });

    it('429 once the bookings rate-limit budget is spent', async () => {
      const { scenario, bookingId } = await inProgress();
      const budget = RATE_LIMIT_DEFAULTS.bookings.limit;
      for (let i = 0; i < budget; i += 1) {
        await POST_MILESTONE(
          post(milestoneUrl(bookingId), scenario.provider, {
            body: { milestoneType: 'working' },
            idempotencyKey: randomUUID(),
          }),
        );
      }
      const res = await POST_MILESTONE(
        post(milestoneUrl(bookingId), scenario.provider, {
          body: { milestoneType: 'working' },
          idempotencyKey: randomUUID(),
        }),
      );
      expect(res.status).toBe(429);
    });
  });

  describe('GET /bookings/{id}/milestones and /evidence', () => {
    it('both participants read milestones; a stranger is 404', async () => {
      const { scenario, bookingId } = await inProgress();
      await POST_MILESTONE(
        post(milestoneUrl(bookingId), scenario.provider, {
          body: { milestoneType: 'almost_done' },
          idempotencyKey: randomUUID(),
        }),
      );
      resetRateLimitState();

      for (const session of [scenario.customer, scenario.provider]) {
        const res = await GET_MILESTONES(sessionGet(milestoneUrl(bookingId), session));
        expect(res.status).toBe(200);
        expect((await res.json()).data).toHaveLength(1);
      }

      const stranger = await seedConfirmedBooking();
      resetRateLimitState();
      const res = await GET_MILESTONES(sessionGet(milestoneUrl(bookingId), stranger.scenario.customer));
      expect(res.status).toBe(404);
    });

    /** AC-8 across the real route: an empty list before completion, the asset after. */
    it('the customer reads evidence only after completion', async () => {
      const { scenario, bookingId } = await inProgress();
      await uploadEvidence(scenario.provider.userId, 'provider', bookingId);
      resetRateLimitState();

      const before = await GET_EVIDENCE(sessionGet(evidenceUrl(bookingId), scenario.customer));
      expect(before.status).toBe(200);
      expect((await before.json()).data).toEqual([]);

      await switchMode(scenario.provider, 'provider');
      resetRateLimitState();
      const completed = await COMPLETE(
        post(`${BASE}/bookings/${bookingId}/complete`, scenario.provider, { idempotencyKey: randomUUID() }),
      );
      expect(completed.status).toBe(200);
      resetRateLimitState();

      const after = await GET_EVIDENCE(sessionGet(evidenceUrl(bookingId), scenario.customer));
      expect((await after.json()).data).toHaveLength(1);
    });

    /** §3 — metadata only: no storage key, checksum, scan internals or owner id. */
    it('the evidence route returns metadata only, never storage or owner internals', async () => {
      const { scenario, bookingId } = await inProgress();
      await uploadEvidence(scenario.provider.userId, 'provider', bookingId);
      resetRateLimitState();

      const res = await GET_EVIDENCE(sessionGet(evidenceUrl(bookingId), scenario.provider));
      const body = JSON.stringify((await res.json()).data);
      for (const forbidden of ['storageKey', 'storage_key', 'checksum', 'scanOutcome', 'uploadedByUserId', 'url']) {
        expect(body, forbidden).not.toContain(forbidden);
      }
      expect(body).not.toContain(scenario.customer.userId);
      expect(body).not.toContain(scenario.provider.userId);
    });

    it('401 when anonymous', async () => {
      const { bookingId } = await inProgress();
      expect((await GET_EVIDENCE(new Request(evidenceUrl(bookingId)))).status).toBe(401);
      expect((await GET_MILESTONES(new Request(milestoneUrl(bookingId)))).status).toBe(401);
    });
  });

  describe('POST /bookings/{id}/complete — the spec 028 body extension', () => {
    /** Backward compatibility: spec 020's body (none at all) still behaves identically. */
    it('still completes with no body at all', async () => {
      const { scenario, bookingId } = await inProgress();
      const res = await COMPLETE(
        post(`${BASE}/bookings/${bookingId}/complete`, scenario.provider, { idempotencyKey: randomUUID() }),
      );
      expect(res.status).toBe(200);
      expect((await res.json()).data.status).toBe('completed');
    });

    it('422 EVIDENCE_ASSET_INVALID for an id that is not this bookings evidence', async () => {
      const { scenario, bookingId } = await inProgress();
      const res = await COMPLETE(
        post(`${BASE}/bookings/${bookingId}/complete`, scenario.provider, {
          body: { evidenceFileAssetIds: [randomUUID()] },
          idempotencyKey: randomUUID(),
        }),
      );
      expect(res.status).toBe(422);
      expect((await res.json()).code).toBe('EVIDENCE_ASSET_INVALID');
    });

    it('400 when evidenceFileAssetIds is not an array', async () => {
      const { scenario, bookingId } = await inProgress();
      const res = await COMPLETE(
        post(`${BASE}/bookings/${bookingId}/complete`, scenario.provider, {
          body: { evidenceFileAssetIds: 'nope' },
          idempotencyKey: randomUUID(),
        }),
      );
      expect(res.status).toBe(400);
    });

    /** AC-4 through the real route: the catalog decides, and the body cannot argue. */
    it('422 COMPLETION_EVIDENCE_REQUIRED, and no body field can bypass it', async () => {
      const { scenario, bookingId } = await inProgress();
      await setCompletionEvidenceRequired(scenario.serviceId, true);

      for (const body of [
        undefined,
        { evidenceFileAssetIds: [] },
        // Values a client might invent to try to skip the gate. None of them is an input.
        { completionEvidenceRequired: false },
        { skipEvidence: true, evidenceRequired: false },
      ]) {
        resetRateLimitState();
        const res = await COMPLETE(
          post(`${BASE}/bookings/${bookingId}/complete`, scenario.provider, { body, idempotencyKey: randomUUID() }),
        );
        expect(res.status, JSON.stringify(body)).toBe(422);
        expect((await res.json()).code).toBe('COMPLETION_EVIDENCE_REQUIRED');
      }

      const assetId = await uploadEvidence(scenario.provider.userId, 'provider', bookingId);
      resetRateLimitState();
      const ok = await COMPLETE(
        post(`${BASE}/bookings/${bookingId}/complete`, scenario.provider, {
          body: { evidenceFileAssetIds: [assetId] },
          idempotencyKey: randomUUID(),
        }),
      );
      expect(ok.status).toBe(200);
    });
  });

  describe('contract', () => {
    it('every spec 028 route is registered in OPENAPI_ROUTES', () => {
      const registered = new Set(OPENAPI_ROUTES.map((route) => `${route.method} ${route.path}`));
      for (const entry of [
        'POST /bookings/{id}/milestones',
        'GET /bookings/{id}/milestones',
        'GET /bookings/{id}/evidence',
      ]) {
        expect(registered.has(entry), entry).toBe(true);
      }
    });

    it('adds no rate-limit domain of its own — it reuses spec 020s bookings budget', () => {
      expect(RATE_LIMIT_DEFAULTS.bookings).toEqual({ limit: 30, windowMs: 60_000 });
    });

    /**
     * AC-9, asserted on the shipped route sources: neither route reads a location signal, and
     * neither transitions a booking. There is no interface here for a GPS ping to act through.
     */
    it('no spec 028 route accepts a location signal or changes booking status', () => {
      const root = join(__dirname, '..', '..', '..', '..');
      for (const file of [
        join('app', 'api', 'v1', 'bookings', '[id]', 'milestones', 'route.ts'),
        join('app', 'api', 'v1', 'bookings', '[id]', 'evidence', 'route.ts'),
      ]) {
        const source = readFileSync(join(root, file), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, ' ')
          .replace(/(^|[^:])\/\/.*$/gm, '$1');
        expect(source, file).not.toMatch(/latitude|longitude|geofence|geolocation|\bgps\b/i);
        expect(source, file).not.toMatch(/applyBookingTransition|advanceBooking|completeBooking/);
      }
    });
  });
});
