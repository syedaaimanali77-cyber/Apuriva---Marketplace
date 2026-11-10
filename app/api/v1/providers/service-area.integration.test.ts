import { afterAll, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { isProviderEligibleForLocation } from '@/lib/availability/service-areas';
import { fromMicroDegrees } from '@/lib/location/geo';
import { GET as GET_AREAS, PUT as PUT_AREAS } from './me/service-areas/route';
import { GET as SERVICE_AREA_CHECK } from './[id]/service-area-check/route';
import {
  ISLAMABAD,
  LAHORE,
  LAHORE_NEARBY,
  isDatabaseReachable,
  registerCustomer,
  registerProvider,
  seedAddressAt,
  seedForeignService,
  seedProviderService,
  sessionGet,
  sessionMutate,
} from './availability-test-support';

const dbReachable = await isDatabaseReachable();

const AREAS_URL = 'http://localhost/api/v1/providers/me/service-areas';

function pointOf(micro: { latitudeMicroDegrees: number; longitudeMicroDegrees: number }) {
  return { latitude: fromMicroDegrees(micro.latitudeMicroDegrees), longitude: fromMicroDegrees(micro.longitudeMicroDegrees) };
}

function checkUrl(providerProfileId: string, micro: { latitudeMicroDegrees: number; longitudeMicroDegrees: number }): string {
  const point = pointOf(micro);
  return `http://localhost/api/v1/providers/${providerProfileId}/service-area-check?lat=${point.latitude}&lng=${point.longitude}`;
}

describe.skipIf(!dbReachable)('provider service areas (spec 016 §3 S1–S5, integration)', () => {
  afterAll(async () => {
    await getPool().end();
  });

  describe('AC-3: "Lahore + 20 km"', () => {
    it('excludes a request origin beyond a 20 km radius around the configured center address', async () => {
      resetRateLimitState();
      const provider = await registerProvider();
      const { addressId } = await seedAddressAt(provider.userId, LAHORE, 'Lahore');

      const saved = await PUT_AREAS(
        sessionMutate(AREAS_URL, provider, 'PUT', {
          areas: [{ mode: 'radius', radiusKm: 20, centerAddressId: addressId }],
        }),
      );
      expect(saved.status).toBe(200);
      const areas = (await saved.json()).data;
      expect(areas).toHaveLength(1);
      expect(areas[0]).toMatchObject({ serviceId: null, mode: 'radius', radiusKm: 20, centerAddressId: addressId });
      // Privacy (spec 012): the owner sees an approximate label, never raw coordinates.
      expect(areas[0].centerApproxAreaLabel).toBe('Gulberg, Lahore');
      expect(JSON.stringify(areas[0])).not.toContain('31.52');

      // Islamabad is ~270 km away — outside.
      await expect(
        isProviderEligibleForLocation(provider.providerProfileId, null, { point: pointOf(ISLAMABAD), city: 'Islamabad' }),
      ).resolves.toBe(false);

      // ~9 km away — inside.
      await expect(
        isProviderEligibleForLocation(provider.providerProfileId, null, { point: pointOf(LAHORE_NEARBY), city: 'Lahore' }),
      ).resolves.toBe(true);
    });

    it('the spec-012 service-area-check route now answers false for a point outside the radius', async () => {
      resetRateLimitState();
      const provider = await registerProvider();
      const { addressId } = await seedAddressAt(provider.userId, LAHORE, 'Lahore');
      await PUT_AREAS(
        sessionMutate(AREAS_URL, provider, 'PUT', { areas: [{ mode: 'radius', radiusKm: 20, centerAddressId: addressId }] }),
      );

      const outside = await SERVICE_AREA_CHECK(new Request(checkUrl(provider.providerProfileId, ISLAMABAD)));
      expect(outside.status).toBe(200);
      expect((await outside.json()).data).toEqual({ inServiceArea: false });

      const inside = await SERVICE_AREA_CHECK(new Request(checkUrl(provider.providerProfileId, LAHORE_NEARBY)));
      expect((await inside.json()).data).toEqual({ inServiceArea: true });
    });

    it('S2: a provider with no configured area at all stays unrestricted', async () => {
      resetRateLimitState();
      const provider = await registerProvider();
      await expect(
        isProviderEligibleForLocation(provider.providerProfileId, null, { point: pointOf(ISLAMABAD), city: 'Islamabad' }),
      ).resolves.toBe(true);

      const res = await SERVICE_AREA_CHECK(new Request(checkUrl(provider.providerProfileId, ISLAMABAD)));
      expect((await res.json()).data).toEqual({ inServiceArea: true });
    });

    it('S4: a candidate with no coordinates is never silently inside a radius area', async () => {
      resetRateLimitState();
      const provider = await registerProvider();
      const { addressId } = await seedAddressAt(provider.userId, LAHORE, 'Lahore');
      await PUT_AREAS(
        sessionMutate(AREAS_URL, provider, 'PUT', { areas: [{ mode: 'radius', radiusKm: 20, centerAddressId: addressId }] }),
      );

      await expect(isProviderEligibleForLocation(provider.providerProfileId, null, { city: 'Lahore' })).resolves.toBe(false);
    });
  });

  describe('AC-4: remote services', () => {
    it('a remote service is eligible for any origin while the provider\'s other services keep their radius area', async () => {
      resetRateLimitState();
      const provider = await registerProvider();
      const { addressId } = await seedAddressAt(provider.userId, LAHORE, 'Lahore');
      const onsite = await seedProviderService(provider.providerProfileId);
      const online = await seedProviderService(provider.providerProfileId);

      const saved = await PUT_AREAS(
        sessionMutate(AREAS_URL, provider, 'PUT', {
          areas: [
            // Global default: Lahore + 20 km.
            { mode: 'radius', radiusKm: 20, centerAddressId: addressId },
            // One service overrides it as remote.
            { serviceId: online.serviceId, mode: 'remote' },
          ],
        }),
      );
      expect(saved.status).toBe(200);
      expect((await saved.json()).data).toHaveLength(2);

      const farAway = { point: pointOf(ISLAMABAD), city: 'Islamabad' };

      // The remote service bypasses the geographic rules entirely...
      await expect(isProviderEligibleForLocation(provider.providerProfileId, online.serviceId, farAway)).resolves.toBe(true);
      // ...while the on-site service still falls back to the global radius and is excluded.
      await expect(isProviderEligibleForLocation(provider.providerProfileId, onsite.serviceId, farAway)).resolves.toBe(false);
      // And the global default itself is unchanged.
      await expect(isProviderEligibleForLocation(provider.providerProfileId, null, farAway)).resolves.toBe(false);
    });
  });

  describe('S1/S2: cities mode and per-service precedence', () => {
    it('matches a city case- and whitespace-insensitively, and excludes others', async () => {
      resetRateLimitState();
      const provider = await registerProvider();
      await PUT_AREAS(sessionMutate(AREAS_URL, provider, 'PUT', { areas: [{ mode: 'cities', cities: ['Lahore', 'Karachi'] }] }));

      await expect(
        isProviderEligibleForLocation(provider.providerProfileId, null, { point: pointOf(LAHORE), city: '  lahore ' }),
      ).resolves.toBe(true);
      await expect(
        isProviderEligibleForLocation(provider.providerProfileId, null, { point: pointOf(ISLAMABAD), city: 'Islamabad' }),
      ).resolves.toBe(false);
    });

    it("a service's own row wins over the global default", async () => {
      resetRateLimitState();
      const provider = await registerProvider();
      const service = await seedProviderService(provider.providerProfileId);

      await PUT_AREAS(
        sessionMutate(AREAS_URL, provider, 'PUT', {
          areas: [
            { mode: 'cities', cities: ['Lahore'] },
            { serviceId: service.serviceId, mode: 'cities', cities: ['Islamabad'] },
          ],
        }),
      );

      const islamabad = { point: pointOf(ISLAMABAD), city: 'Islamabad' };
      await expect(isProviderEligibleForLocation(provider.providerProfileId, service.serviceId, islamabad)).resolves.toBe(true);
      await expect(isProviderEligibleForLocation(provider.providerProfileId, null, islamabad)).resolves.toBe(false);
    });
  });

  describe('S5: validation', () => {
    async function expectInvalid(provider: Awaited<ReturnType<typeof registerProvider>>, areas: unknown[], field: string) {
      const res = await PUT_AREAS(sessionMutate(AREAS_URL, provider, 'PUT', { areas }));
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('INVALID_SERVICE_AREA');
      expect(body.errors.some((error: { field: string }) => error.field === field)).toBe(true);
      return body;
    }

    it('rejects a radius area missing radiusKm or centerAddressId', async () => {
      resetRateLimitState();
      const provider = await registerProvider();
      await expectInvalid(provider, [{ mode: 'radius' }], 'areas[0].radiusKm');
    });

    it('rejects an out-of-range or non-integer radius', async () => {
      resetRateLimitState();
      const provider = await registerProvider();
      const { addressId } = await seedAddressAt(provider.userId, LAHORE);
      await expectInvalid(provider, [{ mode: 'radius', radiusKm: 501, centerAddressId: addressId }], 'areas[0].radiusKm');
      await expectInvalid(provider, [{ mode: 'radius', radiusKm: 20.5, centerAddressId: addressId }], 'areas[0].radiusKm');
    });

    it("rejects a centerAddressId the caller does not own", async () => {
      resetRateLimitState();
      const provider = await registerProvider();
      const stranger = await registerCustomer();
      const { addressId } = await seedAddressAt(stranger.userId, LAHORE);
      await expectInvalid(provider, [{ mode: 'radius', radiusKm: 20, centerAddressId: addressId }], 'areas[0].centerAddressId');
    });

    it('rejects an empty or blank cities list', async () => {
      resetRateLimitState();
      const provider = await registerProvider();
      await expectInvalid(provider, [{ mode: 'cities', cities: [] }], 'areas[0].cities');
      await expectInvalid(provider, [{ mode: 'cities', cities: ['  '] }], 'areas[0].cities');
    });

    it('rejects a remote area carrying geographic fields', async () => {
      resetRateLimitState();
      const provider = await registerProvider();
      await expectInvalid(provider, [{ mode: 'remote', radiusKm: 20 }], 'areas[0].mode');
    });

    it('rejects a serviceId the provider does not offer', async () => {
      resetRateLimitState();
      const provider = await registerProvider();
      const { serviceId } = await seedForeignService();
      await expectInvalid(provider, [{ serviceId, mode: 'remote' }], 'areas[0].serviceId');
    });

    it('rejects two entries naming the same serviceId', async () => {
      resetRateLimitState();
      const provider = await registerProvider();
      await expectInvalid(provider, [{ mode: 'remote' }, { mode: 'remote' }], 'areas[1].serviceId');
    });

    it('leaves the previous configuration completely untouched when an entry is rejected', async () => {
      resetRateLimitState();
      const provider = await registerProvider();
      await PUT_AREAS(sessionMutate(AREAS_URL, provider, 'PUT', { areas: [{ mode: 'cities', cities: ['Lahore'] }] }));

      const rejected = await PUT_AREAS(
        sessionMutate(AREAS_URL, provider, 'PUT', { areas: [{ mode: 'cities', cities: ['Karachi'] }, { mode: 'radius' }] }),
      );
      expect(rejected.status).toBe(422);

      const current = await GET_AREAS(sessionGet(AREAS_URL, provider));
      expect((await current.json()).data).toMatchObject([{ mode: 'cities', cities: ['Lahore'] }]);
    });
  });

  describe('authorization', () => {
    it('rejects a customer-mode session with 403', async () => {
      resetRateLimitState();
      const customer = await registerCustomer();
      const res = await GET_AREAS(sessionGet(AREAS_URL, customer));
      expect(res.status).toBe(403);
    });

    it('404s the service-area-check for an unknown provider', async () => {
      resetRateLimitState();
      const res = await SERVICE_AREA_CHECK(
        new Request('http://localhost/api/v1/providers/00000000-0000-0000-0000-000000000000/service-area-check?lat=31.5&lng=74.3'),
      );
      expect(res.status).toBe(404);
    });
  });
});
