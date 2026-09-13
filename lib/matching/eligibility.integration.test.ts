import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { candidateForRequest } from '@/lib/availability/service-areas';
import { evaluateEligibility, type EligibilityContext, type EligibilityInput } from './eligibility';
import {
  ISLAMABAD,
  LAHORE,
  isDatabaseReachable,
  registerProvider,
  seedAddressAt,
  seedCustomerWithAddress,
  seedForeignService,
  seedProviderService,
  seedSubmittedRequest,
  seedWeeklyHours,
  allWeekAlwaysOpen,
} from './matching-test-support';

const dbReachable = await isDatabaseReachable();

/** Builds the (input, context) pair `evaluateEligibility` needs, from real seeded rows. */
async function eligibilityArgsFor(
  providerProfileId: string,
  serviceId: string,
  requestId: string,
  overrides?: Partial<EligibilityInput>,
): Promise<{ input: EligibilityInput; context: EligibilityContext }> {
  const candidate = (await candidateForRequest(requestId)) ?? {};
  return {
    input: {
      providerProfileId,
      lifecycleStatus: 'active',
      schedulingTimezone: 'Asia/Karachi',
      offersService: true,
      durationMinutes: 60,
      ...overrides,
    },
    context: { serviceId, candidate, preferredAt: null },
  };
}

describe.skipIf(!dbReachable)('lib/matching/eligibility (spec 017 AC-1, integration)', () => {
  beforeEach(() => {
    resetRateLimitState();
  });

  it('E1: a provider with no provider_services row for the request service is excluded — service_not_offered', async () => {
    const provider = await registerProvider();
    const { serviceId } = await seedForeignService();
    const customer = await seedCustomerWithAddress();
    const request = await seedSubmittedRequest(customer.userId, serviceId, customer.addressId);

    const { input, context } = await eligibilityArgsFor(provider.providerProfileId, serviceId, request.id, {
      offersService: false,
    });
    const outcome = await evaluateEligibility(input, context);
    expect(outcome).toEqual({ eligible: false, reason: 'service_not_offered' });
  });

  it('E2: a provider whose radius service area excludes the request address is excluded — outside_service_area', async () => {
    const provider = await registerProvider();
    const { serviceId } = await seedProviderService(provider.providerProfileId);
    await seedWeeklyHours(provider.providerProfileId, allWeekAlwaysOpen());

    // Provider's declared centre + radius: Lahore, 20km — set directly at the DB layer, mirroring
    // spec 016's own service-area fixtures (this suite exercises spec 017's consumption of it,
    // not spec 016's PUT route).
    const { getDb } = await import('@/lib/db');
    const { providerServiceAreas } = await import('@/lib/db/schema');
    const center = await seedAddressAt(provider.userId, LAHORE);
    await getDb().insert(providerServiceAreas).values({
      providerProfileId: provider.providerProfileId,
      serviceId: null,
      mode: 'radius',
      radiusMeters: 20_000,
      centerAddressId: center.addressId,
    });

    const customer = await seedCustomerWithAddress();
    // Islamabad is ~270km from Lahore — well outside the 20km radius.
    const farAddress = await seedAddressAt(customer.userId, ISLAMABAD, 'Islamabad');
    const request = await seedSubmittedRequest(customer.userId, serviceId, farAddress.addressId);

    const { input, context } = await eligibilityArgsFor(provider.providerProfileId, serviceId, request.id);
    const outcome = await evaluateEligibility(input, context);
    expect(outcome).toEqual({ eligible: false, reason: 'outside_service_area' });
  });

  it('E3: a provider with no weekly availability at all is excluded — unavailable', async () => {
    const provider = await registerProvider();
    const { serviceId } = await seedProviderService(provider.providerProfileId);
    // Deliberately no seedWeeklyHours call: an unscheduled request falls back to
    // getAvailabilitySummary(), which reports 'unavailable' for a provider with zero configured
    // hours (spec 016).
    const customer = await seedCustomerWithAddress();
    const request = await seedSubmittedRequest(customer.userId, serviceId, customer.addressId);

    const { input, context } = await eligibilityArgsFor(provider.providerProfileId, serviceId, request.id);
    const outcome = await evaluateEligibility(input, context);
    expect(outcome).toEqual({ eligible: false, reason: 'unavailable' });
  });

  it('E4: a non-active provider (e.g. pending_verification) is excluded — not_verified', async () => {
    const provider = await registerProvider({ lifecycleStatus: 'pending_verification' });
    const { serviceId } = await seedProviderService(provider.providerProfileId);
    await seedWeeklyHours(provider.providerProfileId, allWeekAlwaysOpen());
    const customer = await seedCustomerWithAddress();
    // `getAvailabilitySummary()` (the unscheduled-request path spec 016 uses for E3) itself
    // reports `unavailable` for any non-active provider (spec 016 AC-5), so an unscheduled
    // request would fail at E3 before ever reaching E4 — not a useful isolation of this rule.
    // A SCHEDULED request instead resolves through `availabilityFitAt`, which checks only the
    // weekly pattern/overrides/buffers/busy intervals and never `lifecycleStatus` — so it is the
    // one request shape that lets a non-active-but-otherwise-available provider actually reach E4.
    const preferredAt = new Date('2026-09-16T05:00:00Z');
    const request = await seedSubmittedRequest(customer.userId, serviceId, customer.addressId, { preferredAt });

    const candidate = (await candidateForRequest(request.id)) ?? {};
    const outcome = await evaluateEligibility(
      {
        providerProfileId: provider.providerProfileId,
        lifecycleStatus: 'pending_verification',
        schedulingTimezone: 'Asia/Karachi',
        offersService: true,
        durationMinutes: 60,
      },
      { serviceId, candidate, preferredAt },
    );
    expect(outcome).toEqual({ eligible: false, reason: 'not_verified' });
  });

  it('an eligible provider (offers the service, unrestricted area, always available, active) passes all five rules', async () => {
    const provider = await registerProvider();
    const { serviceId } = await seedProviderService(provider.providerProfileId);
    await seedWeeklyHours(provider.providerProfileId, allWeekAlwaysOpen());
    const customer = await seedCustomerWithAddress();
    const request = await seedSubmittedRequest(customer.userId, serviceId, customer.addressId);

    const { input, context } = await eligibilityArgsFor(provider.providerProfileId, serviceId, request.id);
    const outcome = await evaluateEligibility(input, context);
    expect(outcome.eligible).toBe(true);
  });

  it('rules short-circuit in order: E1 fires before E4 even when both would fail', async () => {
    // offersService: false AND not active — E1 (service_not_offered) must win, proving the
    // documented evaluation order rather than an implementation-dependent one.
    const provider = await registerProvider({ lifecycleStatus: 'suspended' });
    const { serviceId } = await seedForeignService();
    const customer = await seedCustomerWithAddress();
    const request = await seedSubmittedRequest(customer.userId, serviceId, customer.addressId);

    const { input, context } = await eligibilityArgsFor(provider.providerProfileId, serviceId, request.id, {
      offersService: false,
      lifecycleStatus: 'suspended',
    });
    const outcome = await evaluateEligibility(input, context);
    expect(outcome).toEqual({ eligible: false, reason: 'service_not_offered' });
  });
});
