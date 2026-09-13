import { afterAll, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { registerBusyIntervalLoader, resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { GET as GET_AVAILABILITY } from './[id]/availability/route';
import { POST as NOTIFY } from './[id]/availability-notify/route';
import {
  allWeekAlwaysOpen,
  guestGet,
  isDatabaseReachable,
  registerCustomer,
  registerProvider,
  seedProviderService,
  seedWeeklyHours,
  sessionGet,
  sessionMutate,
} from './availability-test-support';

const dbReachable = await isDatabaseReachable();

function availabilityUrl(providerProfileId: string): string {
  return `http://localhost/api/v1/providers/${providerProfileId}/availability`;
}

function notifyUrl(providerProfileId: string): string {
  return `http://localhost/api/v1/providers/${providerProfileId}/availability-notify`;
}

describe.skipIf(!dbReachable)('customer-facing availability (spec 016 AC-5/AC-6, integration)', () => {
  afterAll(async () => {
    resetBusyIntervalLoader();
    await getPool().end();
  });

  describe('AC-5: state, reason, and what is never exposed', () => {
    it('returns a state with a non-null reason and never exposes weekly rows, overrides, slots, bookings or timezone to a non-owner', async () => {
      resetRateLimitState();
      resetBusyIntervalLoader();
      const provider = await registerProvider();
      await seedWeeklyHours(provider.providerProfileId, allWeekAlwaysOpen());

      const res = await GET_AVAILABILITY(guestGet(availabilityUrl(provider.providerProfileId)));
      expect(res.status).toBe(200);
      const { data } = await res.json();

      expect(data.state).toBe('available');
      expect(typeof data.reason).toBe('string');
      expect(data.reason.length).toBeGreaterThan(0);

      // The DTO is exactly three fields — nothing about the provider's internals leaks.
      expect(Object.keys(data).sort()).toEqual(['nextAvailableDate', 'reason', 'state']);
      const serialized = JSON.stringify(data);
      for (const forbidden of ['entries', 'dayOfWeek', 'startMinute', 'endMinute', 'timezone', 'Karachi', 'slots', 'booking', 'buffer']) {
        expect(serialized).not.toContain(forbidden);
      }
    });

    it('a provider with no working hours is unavailable but still resolves — discoverable', async () => {
      resetRateLimitState();
      const provider = await registerProvider();

      const res = await GET_AVAILABILITY(guestGet(availabilityUrl(provider.providerProfileId)));
      expect(res.status).toBe(200); // not a 404, not an error — the profile is still there
      const { data } = await res.json();
      expect(data.state).toBe('unavailable');
      expect(data.reason).toBe('No working hours set yet');
    });

    it('a provider whose lifecycle status is not active reads as unavailable with its own reason', async () => {
      resetRateLimitState();
      const provider = await registerProvider({ lifecycleStatus: 'paused' });
      await seedWeeklyHours(provider.providerProfileId, allWeekAlwaysOpen());

      const { data } = await (await GET_AVAILABILITY(guestGet(availabilityUrl(provider.providerProfileId)))).json();
      expect(data.state).toBe('unavailable');
      expect(data.reason).toBe('Not accepting work right now');
    });

    it('reads as busy — with a next-available date — when inside working hours but fully committed', async () => {
      resetRateLimitState();
      const provider = await registerProvider();
      await seedWeeklyHours(provider.providerProfileId, allWeekAlwaysOpen());
      const { serviceId } = await seedProviderService(provider.providerProfileId);

      // Everything for the next two days is taken; day three onward is free.
      const from = new Date();
      registerBusyIntervalLoader(async () => [
        {
          startAt: new Date(from.getTime() - 3_600_000),
          endAt: new Date(from.getTime() + 2 * 86_400_000),
          serviceId,
          sourceId: 'committed',
        },
      ]);

      const { data } = await (await GET_AVAILABILITY(guestGet(availabilityUrl(provider.providerProfileId)))).json();
      resetBusyIntervalLoader();

      expect(data.state).toBe('busy');
      expect(data.reason).toBe('Fully booked today');
      // A coarse local DATE only — never a time, which would be a schedule internal.
      expect(data.nextAvailableDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('404s an unknown provider id rather than leaking whether it exists', async () => {
      resetRateLimitState();
      const res = await GET_AVAILABILITY(guestGet(availabilityUrl('00000000-0000-0000-0000-000000000000')));
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe('NOT_FOUND');
    });
  });

  describe('AC-6: availability notifications', () => {
    it('creates a pending request (201), returns the same id on a repeat call (200), and rejects a notify for an available provider (422)', async () => {
      resetRateLimitState();
      resetBusyIntervalLoader();

      // An unavailable provider — no working hours at all.
      const unavailable = await registerProvider();
      const customer = await registerCustomer();

      const first = await NOTIFY(sessionMutate(notifyUrl(unavailable.providerProfileId), customer, 'POST'));
      expect(first.status).toBe(201);
      const firstBody = (await first.json()).data;
      expect(firstBody.status).toBe('pending');

      // Idempotent: the same pending row comes back with 200, never a duplicate.
      const second = await NOTIFY(sessionMutate(notifyUrl(unavailable.providerProfileId), customer, 'POST'));
      expect(second.status).toBe(200);
      expect((await second.json()).data.id).toBe(firstBody.id);

      // An available provider has nothing to notify about.
      const available = await registerProvider();
      await seedWeeklyHours(available.providerProfileId, allWeekAlwaysOpen());
      const rejected = await NOTIFY(sessionMutate(notifyUrl(available.providerProfileId), customer, 'POST'));
      expect(rejected.status).toBe(422);
      expect((await rejected.json()).code).toBe('AVAILABILITY_NOTIFY_NOT_APPLICABLE');
    });

    it('keeps two different customers\' opt-ins separate', async () => {
      resetRateLimitState();
      const provider = await registerProvider();
      const customerA = await registerCustomer();
      const customerB = await registerCustomer();

      const a = await NOTIFY(sessionMutate(notifyUrl(provider.providerProfileId), customerA, 'POST'));
      const b = await NOTIFY(sessionMutate(notifyUrl(provider.providerProfileId), customerB, 'POST'));

      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect((await a.json()).data.id).not.toBe((await b.json()).data.id);
    });

    it('rejects a provider-mode session with 403 — the opt-in is a customer action', async () => {
      resetRateLimitState();
      const target = await registerProvider();
      const otherProvider = await registerProvider();

      const res = await NOTIFY(sessionMutate(notifyUrl(target.providerProfileId), otherProvider, 'POST'));
      expect(res.status).toBe(403);
    });

    it('rejects a guest with 401', async () => {
      resetRateLimitState();
      const provider = await registerProvider();
      const res = await NOTIFY(new Request(notifyUrl(provider.providerProfileId), { method: 'POST' }));
      expect(res.status).toBe(401);
    });

    it('404s for an unknown provider', async () => {
      resetRateLimitState();
      const customer = await registerCustomer();
      const res = await NOTIFY(sessionMutate(notifyUrl('00000000-0000-0000-0000-000000000000'), customer, 'POST'));
      expect(res.status).toBe(404);
    });
  });

  describe('rate limiting (spec 004 AC-5)', () => {
    it('applies the availability budget to the public read', async () => {
      resetRateLimitState();
      const provider = await registerProvider();
      const customer = await registerCustomer();

      let limited = false;
      for (let i = 0; i < 65; i += 1) {
        const res = await GET_AVAILABILITY(sessionGet(availabilityUrl(provider.providerProfileId), customer));
        if (res.status === 429) {
          limited = true;
          break;
        }
      }
      expect(limited).toBe(true);
      resetRateLimitState();
    });
  });
});
