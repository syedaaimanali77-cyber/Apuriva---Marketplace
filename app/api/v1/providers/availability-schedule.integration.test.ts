import { afterAll, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { GET as GET_SCHEDULE, PUT as PUT_SCHEDULE } from './me/availability/schedule/route';
import { GET as LIST_OVERRIDES, POST as CREATE_OVERRIDE } from './me/availability/overrides/route';
import { DELETE as DELETE_OVERRIDE, PUT as UPDATE_OVERRIDE } from './me/availability/overrides/[date]/route';
import { GET as GET_SLOTS } from './me/availability/slots/route';
import {
  isDatabaseReachable,
  registerCustomer,
  registerProvider,
  seedForeignService,
  seedProviderService,
  sessionGet,
  sessionMutate,
} from './availability-test-support';

const dbReachable = await isDatabaseReachable();

const SCHEDULE_URL = 'http://localhost/api/v1/providers/me/availability/schedule';
const OVERRIDES_URL = 'http://localhost/api/v1/providers/me/availability/overrides';
const SLOTS_URL = 'http://localhost/api/v1/providers/me/availability/slots';

/** Mon–Fri 09:00–18:00 (spec 016 AC-1 / master spec §40's example). */
const MON_TO_FRI = [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, startMinute: 540, endMinute: 1080 }));

describe.skipIf(!dbReachable)('provider schedule & overrides (spec 016 §3, integration)', () => {
  afterAll(async () => {
    await getPool().end();
  });

  describe('weekly schedule (R1/R2/R6)', () => {
    it('starts empty with the default Asia/Karachi timezone, then saves and reads back', async () => {
      resetRateLimitState();
      const provider = await registerProvider();

      const initial = await GET_SCHEDULE(sessionGet(SCHEDULE_URL, provider));
      expect(initial.status).toBe(200);
      const initialBody = (await initial.json()).data;
      expect(initialBody.entries).toEqual([]);
      expect(initialBody.timezone).toBe('Asia/Karachi');

      const saved = await PUT_SCHEDULE(
        sessionMutate(SCHEDULE_URL, provider, 'PUT', {
          timezone: 'Asia/Karachi',
          entries: MON_TO_FRI,
          expectedVersion: initialBody.version,
        }),
      );
      expect(saved.status).toBe(200);
      const savedBody = (await saved.json()).data;
      expect(savedBody.entries).toHaveLength(5);
      expect(savedBody.version).toBe(initialBody.version + 1);

      const reread = await GET_SCHEDULE(sessionGet(SCHEDULE_URL, provider));
      expect((await reread.json()).data.entries).toHaveLength(5);
    });

    it('replaces the whole set rather than appending to it', async () => {
      resetRateLimitState();
      const provider = await registerProvider();

      await PUT_SCHEDULE(sessionMutate(SCHEDULE_URL, provider, 'PUT', { timezone: 'Asia/Karachi', entries: MON_TO_FRI }));
      const second = await PUT_SCHEDULE(
        sessionMutate(SCHEDULE_URL, provider, 'PUT', {
          timezone: 'Asia/Karachi',
          entries: [{ dayOfWeek: 6, startMinute: 600, endMinute: 720 }],
        }),
      );

      const body = (await second.json()).data;
      expect(body.entries).toEqual([{ dayOfWeek: 6, startMinute: 600, endMinute: 720 }]);
    });

    it('accepts an empty set — "never available", the provider stays discoverable', async () => {
      resetRateLimitState();
      const provider = await registerProvider();
      const res = await PUT_SCHEDULE(sessionMutate(SCHEDULE_URL, provider, 'PUT', { timezone: 'Asia/Karachi', entries: [] }));
      expect(res.status).toBe(200);
      expect((await res.json()).data.entries).toEqual([]);
    });

    it('rejects overlapping entries with 422 INVALID_SCHEDULE_RANGE naming the entry index', async () => {
      resetRateLimitState();
      const provider = await registerProvider();
      const res = await PUT_SCHEDULE(
        sessionMutate(SCHEDULE_URL, provider, 'PUT', {
          timezone: 'Asia/Karachi',
          entries: [
            { dayOfWeek: 1, startMinute: 540, endMinute: 800 },
            { dayOfWeek: 1, startMinute: 780, endMinute: 1080 },
          ],
        }),
      );
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('INVALID_SCHEDULE_RANGE');
      expect(body.errors[0].field).toBe('entries[1].startMinute');
    });

    it('rejects an unknown IANA timezone with 422', async () => {
      resetRateLimitState();
      const provider = await registerProvider();
      const res = await PUT_SCHEDULE(
        sessionMutate(SCHEDULE_URL, provider, 'PUT', { timezone: 'Mars/Olympus_Mons', entries: [] }),
      );
      expect(res.status).toBe(422);
      expect((await res.json()).code).toBe('INVALID_SCHEDULE_RANGE');
    });

    it('rejects a malformed body shape with 400 VALIDATION_ERROR, not 422', async () => {
      resetRateLimitState();
      const provider = await registerProvider();
      const res = await PUT_SCHEDULE(sessionMutate(SCHEDULE_URL, provider, 'PUT', { timezone: 'Asia/Karachi' }));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('VALIDATION_ERROR');
    });

    it('rejects a stale expectedVersion with 409 CONFLICT (spec 003 AC-6)', async () => {
      resetRateLimitState();
      const provider = await registerProvider();
      const initial = (await (await GET_SCHEDULE(sessionGet(SCHEDULE_URL, provider))).json()).data;

      await PUT_SCHEDULE(
        sessionMutate(SCHEDULE_URL, provider, 'PUT', {
          timezone: 'Asia/Karachi',
          entries: MON_TO_FRI,
          expectedVersion: initial.version,
        }),
      );

      const stale = await PUT_SCHEDULE(
        sessionMutate(SCHEDULE_URL, provider, 'PUT', {
          timezone: 'Asia/Karachi',
          entries: [],
          expectedVersion: initial.version,
        }),
      );
      expect(stale.status).toBe(409);
      expect((await stale.json()).code).toBe('CONFLICT');
    });
  });

  describe('authorization and ownership', () => {
    it('rejects a guest with 401', async () => {
      resetRateLimitState();
      const res = await GET_SCHEDULE(new Request(SCHEDULE_URL, { method: 'GET' }));
      expect(res.status).toBe(401);
    });

    it('rejects a customer-mode session with 403 FORBIDDEN', async () => {
      resetRateLimitState();
      const customer = await registerCustomer();
      const res = await GET_SCHEDULE(sessionGet(SCHEDULE_URL, customer));
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('FORBIDDEN');
    });

    it('rejects a write with a missing CSRF header', async () => {
      resetRateLimitState();
      const provider = await registerProvider();
      const res = await PUT_SCHEDULE(
        new Request(SCHEDULE_URL, {
          method: 'PUT',
          headers: { cookie: `apuriva_session=${provider.sessionId}`, 'content-type': 'application/json' },
          body: JSON.stringify({ timezone: 'Asia/Karachi', entries: [] }),
        }),
      );
      expect(res.status).toBe(403);
    });

    it("never lets one provider read another's schedule — the id comes from the session, not the URL", async () => {
      resetRateLimitState();
      const providerA = await registerProvider();
      const providerB = await registerProvider();

      await PUT_SCHEDULE(sessionMutate(SCHEDULE_URL, providerA, 'PUT', { timezone: 'Asia/Karachi', entries: MON_TO_FRI }));

      // B asks for "me" and gets B's own empty schedule, never A's — there is no id to tamper with.
      const res = await GET_SCHEDULE(sessionGet(SCHEDULE_URL, providerB));
      expect((await res.json()).data.entries).toEqual([]);
    });
  });

  describe('date overrides (R3/R4)', () => {
    it('AC-1: creates an unavailable override, lists it, and rejects a duplicate date with 409', async () => {
      resetRateLimitState();
      const provider = await registerProvider();

      const created = await CREATE_OVERRIDE(
        sessionMutate(OVERRIDES_URL, provider, 'POST', { date: '2026-09-18', isAvailable: false }),
      );
      expect(created.status).toBe(201);
      expect((await created.json()).data).toEqual({
        date: '2026-09-18',
        isAvailable: false,
        startMinute: null,
        endMinute: null,
      });

      const listed = await LIST_OVERRIDES(sessionGet(`${OVERRIDES_URL}?from=2026-09-01&to=2026-09-30`, provider));
      expect((await listed.json()).data).toHaveLength(1);

      const duplicate = await CREATE_OVERRIDE(
        sessionMutate(OVERRIDES_URL, provider, 'POST', { date: '2026-09-18', isAvailable: false }),
      );
      expect(duplicate.status).toBe(409);
      expect((await duplicate.json()).code).toBe('CONFLICT');
    });

    it('updates an override in place and deletes it, restoring the weekly pattern', async () => {
      resetRateLimitState();
      const provider = await registerProvider();
      await CREATE_OVERRIDE(sessionMutate(OVERRIDES_URL, provider, 'POST', { date: '2026-09-18', isAvailable: false }));

      const updated = await UPDATE_OVERRIDE(
        sessionMutate(`${OVERRIDES_URL}/2026-09-18`, provider, 'PUT', {
          isAvailable: true,
          startMinute: 600,
          endMinute: 720,
        }),
      );
      expect(updated.status).toBe(200);
      expect((await updated.json()).data).toMatchObject({ isAvailable: true, startMinute: 600, endMinute: 720 });

      const deleted = await DELETE_OVERRIDE(sessionMutate(`${OVERRIDES_URL}/2026-09-18`, provider, 'DELETE'));
      expect(deleted.status).toBe(204);

      const listed = await LIST_OVERRIDES(sessionGet(`${OVERRIDES_URL}?from=2026-09-01&to=2026-09-30`, provider));
      expect((await listed.json()).data).toEqual([]);
    });

    it('rejects an unavailable override that carries minutes with 422', async () => {
      resetRateLimitState();
      const provider = await registerProvider();
      const res = await CREATE_OVERRIDE(
        sessionMutate(OVERRIDES_URL, provider, 'POST', {
          date: '2026-09-18',
          isAvailable: false,
          startMinute: 540,
          endMinute: 1080,
        }),
      );
      expect(res.status).toBe(422);
      expect((await res.json()).code).toBe('INVALID_SCHEDULE_RANGE');
    });

    it('404s when updating or deleting a date with no override', async () => {
      resetRateLimitState();
      const provider = await registerProvider();
      const updated = await UPDATE_OVERRIDE(
        sessionMutate(`${OVERRIDES_URL}/2026-09-18`, provider, 'PUT', { isAvailable: false }),
      );
      expect(updated.status).toBe(404);

      const deleted = await DELETE_OVERRIDE(sessionMutate(`${OVERRIDES_URL}/2026-09-18`, provider, 'DELETE'));
      expect(deleted.status).toBe(404);
    });

    it('rejects an inverted or oversized date range with 400', async () => {
      resetRateLimitState();
      const provider = await registerProvider();

      const inverted = await LIST_OVERRIDES(sessionGet(`${OVERRIDES_URL}?from=2026-09-30&to=2026-09-01`, provider));
      expect(inverted.status).toBe(400);

      const tooWide = await LIST_OVERRIDES(sessionGet(`${OVERRIDES_URL}?from=2026-01-01&to=2026-12-31`, provider));
      expect(tooWide.status).toBe(400);
    });
  });

  describe('slots (R7/R8)', () => {
    it('offers only grid positions whose whole duration fits the window', async () => {
      resetRateLimitState();
      const provider = await registerProvider();
      const { serviceId } = await seedProviderService(provider.providerProfileId, { durationMinutes: 60 });
      await PUT_SCHEDULE(sessionMutate(SCHEDULE_URL, provider, 'PUT', { timezone: 'Asia/Karachi', entries: MON_TO_FRI }));

      // 2026-09-16 is a Wednesday.
      const res = await GET_SLOTS(sessionGet(`${SLOTS_URL}?serviceId=${serviceId}&from=2026-09-16&to=2026-09-16`, provider));
      expect(res.status).toBe(200);
      const slots = (await res.json()).data;

      expect(slots).toHaveLength(48);
      const available = slots.filter((slot: { available: boolean }) => slot.available);
      expect(available).toHaveLength(17); // 09:00 … 17:00 on a 30-minute grid
      expect(available[0].startAt).toBe('2026-09-16T04:00:00.000Z'); // 09:00 Asia/Karachi
    });

    it('AC-1: an unavailable override blocks every slot that day, blockedBy "override"', async () => {
      resetRateLimitState();
      const provider = await registerProvider();
      const { serviceId } = await seedProviderService(provider.providerProfileId);
      await PUT_SCHEDULE(sessionMutate(SCHEDULE_URL, provider, 'PUT', { timezone: 'Asia/Karachi', entries: MON_TO_FRI }));
      await CREATE_OVERRIDE(sessionMutate(OVERRIDES_URL, provider, 'POST', { date: '2026-09-16', isAvailable: false }));

      const res = await GET_SLOTS(sessionGet(`${SLOTS_URL}?serviceId=${serviceId}&from=2026-09-16&to=2026-09-16`, provider));
      const slots = (await res.json()).data;
      expect(slots.every((slot: { available: boolean }) => !slot.available)).toBe(true);
      expect(slots.every((slot: { blockedBy: string }) => slot.blockedBy === 'override')).toBe(true);
    });

    it('404s for a service the provider does not offer', async () => {
      resetRateLimitState();
      const provider = await registerProvider();
      const { serviceId } = await seedForeignService();
      const res = await GET_SLOTS(sessionGet(`${SLOTS_URL}?serviceId=${serviceId}&from=2026-09-16&to=2026-09-16`, provider));
      expect(res.status).toBe(404);
    });

    it('400s when serviceId is missing', async () => {
      resetRateLimitState();
      const provider = await registerProvider();
      const res = await GET_SLOTS(sessionGet(`${SLOTS_URL}?from=2026-09-16&to=2026-09-16`, provider));
      expect(res.status).toBe(400);
    });
  });
});
