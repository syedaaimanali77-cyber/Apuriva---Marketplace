import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import type { ApiRouteError } from '@/lib/api/errors';
import { cancelBooking, cancelBookingAsParticipant, previewCancellation } from './cancel';
import { readBookingCancellationPolicy, setProviderCancellationOption } from './booking-policy';
import { cancellationRefundEligibility } from './refund-eligibility';
import { resolveEffectivePolicy } from './resolution';
import { PLATFORM_DEFAULT_CANCELLATION_CONFIG } from './policy-config';
import { getDb } from '@/lib/db';
import {
  advanceTo,
  bookingScope,
  bookingStatusOf,
  flatConfig,
  isDatabaseReachable,
  makeReportable,
  resetCancellationIntegration,
  seedCapturedBooking,
  seedPolicyOverride,
  seedStranger,
  setHoursBeforeScheduled,
  storedAcceptance,
  storedCancellation,
  storedRefunds,
  uniqueKey,
  useCancellationIntegration,
} from './cancellation-test-support';

const dbReachable = await isDatabaseReachable();
const SUITE_TIMEOUT_MS = 90_000;

afterAll(async () => {
  await getPool().end();
});

async function expectError(fn: () => Promise<unknown>, code: string): Promise<ApiRouteError> {
  try {
    await fn();
  } catch (err) {
    expect((err as ApiRouteError).code).toBe(code);
    return err as ApiRouteError;
  }
  throw new Error(`expected ${code} to be thrown`);
}

describe.skipIf(!dbReachable)('spec 023 cancellation', { timeout: SUITE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    useCancellationIntegration();
    registerBookingBusyIntervals();
  });

  afterEach(() => {
    resetCancellationIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  describe('policy resolution and precedence (AC-1, AC-4)', () => {
    it('resolves the seeded platform default when no override exists', async () => {
      const { bookingId } = await seedCapturedBooking();
      const { serviceId } = await bookingScope(bookingId);

      const resolved = await resolveEffectivePolicy(getDb(), serviceId, new Date());
      expect(resolved.source).toBe('platform_default');
      expect(resolved.tiers).toEqual(PLATFORM_DEFAULT_CANCELLATION_CONFIG.tiers);
    });

    it('a category override beats the platform default', async () => {
      const { bookingId } = await seedCapturedBooking();
      const { serviceId, categoryId } = await bookingScope(bookingId);
      await seedPolicyOverride({ scope: 'category', scopeId: categoryId, config: flatConfig(10) });

      const resolved = await resolveEffectivePolicy(getDb(), serviceId, new Date());
      expect(resolved.source).toBe('category_override');
      expect(resolved.tiers[0]!.feePercent).toBe(10);
    });

    it('a service override beats both the category override and the platform default', async () => {
      const { bookingId } = await seedCapturedBooking();
      const { serviceId, categoryId } = await bookingScope(bookingId);
      await seedPolicyOverride({ scope: 'category', scopeId: categoryId, config: flatConfig(10) });
      await seedPolicyOverride({ scope: 'service', scopeId: serviceId, config: flatConfig(70) });

      const resolved = await resolveEffectivePolicy(getDb(), serviceId, new Date());
      expect(resolved.source).toBe('service_override');
      expect(resolved.tiers[0]!.feePercent).toBe(70);
    });

    it('an INACTIVE override is treated as absent and falls through', async () => {
      const { bookingId } = await seedCapturedBooking();
      const { serviceId } = await bookingScope(bookingId);
      await seedPolicyOverride({ scope: 'service', scopeId: serviceId, config: flatConfig(70), isActive: false });

      const resolved = await resolveEffectivePolicy(getDb(), serviceId, new Date());
      expect(resolved.source).toBe('platform_default');
    });

    it('an override whose version does not cover the instant falls through', async () => {
      const { bookingId } = await seedCapturedBooking();
      const { serviceId } = await bookingScope(bookingId);
      const past = new Date(Date.now() - 10 * 24 * 3600 * 1000);
      await seedPolicyOverride({
        scope: 'service',
        scopeId: serviceId,
        config: flatConfig(70),
        effectiveFrom: new Date(0),
        effectiveTo: past,
      });

      const resolved = await resolveEffectivePolicy(getDb(), serviceId, new Date());
      expect(resolved.source).toBe('platform_default');
    });

    /**
     * An invalid stored config is never trusted, never repaired in place, and never allowed to price
     * a cancellation: it is treated as ABSENT and resolution falls through to the next scope.
     *
     * The bad config is written at INSERT time, because a published version is immutable — which is
     * itself the reason this can only ever arise from a manual write, not from the admin API.
     * `{minHoursBefore: 24, maxHoursBefore: 48}` passes the database's structural floor (an object
     * with a non-empty `tiers` array) and fails the domain grammar (the ladder is not exhaustive).
     */
    it('treats an invalid stored configuration as absent', async () => {
      const { bookingId } = await seedCapturedBooking();
      const { serviceId } = await bookingScope(bookingId);
      await seedPolicyOverride({
        scope: 'service',
        scopeId: serviceId,
        config: { tiers: [{ minHoursBefore: 24, maxHoursBefore: 48, feePercent: 0 }], allowedOptions: [] },
      });

      const resolved = await resolveEffectivePolicy(getDb(), serviceId, new Date());
      expect(resolved.source).toBe('platform_default');
    });

    /** The exclusion constraint makes "two versions cover one instant" impossible, not merely rare. */
    it('rejects an overlapping version at the database', async () => {
      const { bookingId } = await seedCapturedBooking();
      const { serviceId } = await bookingScope(bookingId);
      const { policyId } = await seedPolicyOverride({ scope: 'service', scopeId: serviceId, config: flatConfig(10) });

      const { sql } = await import('drizzle-orm');
      await expect(
        getDb().execute(
          sql`INSERT INTO policy_versions (policy_id, config, effective_from, effective_to)
              VALUES (${policyId}, '{"tiers":[{"minHoursBefore":null,"maxHoursBefore":null,"feePercent":5}]}'::jsonb,
                      ${new Date(0)}, NULL)`,
        ),
      ).rejects.toThrow();
    });
  });

  describe('policy acceptance snapshot (AC-1)', () => {
    it('materialises one snapshot per booking, resolved as of the booking’s creation', async () => {
      const { bookingId } = await seedCapturedBooking();

      const policy = await readBookingCancellationPolicy(
        (await seedContext(bookingId)).customerUserId,
        bookingId,
      );
      expect(policy.source).toBe('platform_default');
      expect(policy.tiers).toEqual(PLATFORM_DEFAULT_CANCELLATION_CONFIG.tiers);

      const stored = await storedAcceptance(bookingId);
      expect(stored?.policy_version_id).toBe(policy.policyVersionId);
      expect(stored?.source).toBe('platform_default');
    });

    /**
     * THE central guarantee of AC-1: a policy published after a booking exists cannot reach back and
     * change that booking's terms.
     */
    it('a later policy change does NOT alter an existing booking’s terms', async () => {
      const { scenario, bookingId } = await seedCapturedBooking();
      const first = await readBookingCancellationPolicy(scenario.customer.userId, bookingId);
      expect(first.tiers[0]!.feePercent).toBe(0);

      const { serviceId } = await bookingScope(bookingId);
      await seedPolicyOverride({
        scope: 'service',
        scopeId: serviceId,
        config: flatConfig(100),
        effectiveFrom: new Date(),
      });

      const second = await readBookingCancellationPolicy(scenario.customer.userId, bookingId);
      expect(second.policyVersionId).toBe(first.policyVersionId);
      expect(second.tiers).toEqual(first.tiers);

      // And the enforced consequence follows the snapshot, not the new policy.
      await setHoursBeforeScheduled(bookingId, 48);
      const preview = await previewCancellation(scenario.customer.userId, bookingId);
      expect(preview.feeAmountMinorUnits).toBe(0);
    });

    it('is immutable at the database', async () => {
      const { scenario, bookingId } = await seedCapturedBooking();
      await readBookingCancellationPolicy(scenario.customer.userId, bookingId);

      const { sql } = await import('drizzle-orm');
      await expect(
        getDb().execute(sql`UPDATE policy_acceptances SET source = 'service_override' WHERE booking_id = ${bookingId}`),
      ).rejects.toThrow();
    });
  });

  describe('the exact fee boundaries, end to end (AC-2, AC-3)', () => {
    /**
     * The EXACT boundary instants (hoursBefore === 24, === 12, === 0) are proven in
     * `tiers.test.ts`, where the arithmetic can be evaluated at a held instant. They cannot be
     * proven through the live path: the server re-reads `clock_timestamp()` milliseconds after the
     * fixture positions the booking, so "exactly 24 hours" has already become 23.99997 by the time
     * the tier is chosen. What these cases prove is that the live path applies THAT arithmetic to
     * the database clock — including a few seconds either side of each boundary, which is where a
     * sign error or an off-by-one comparison would show up.
     */
    const CASES: Array<[number, number, string]> = [
      [48, 0, 'well before'],
      [24 + 1 / 360, 0, 'ten seconds beyond 24 hours'],
      [23.5, 25, 'just inside 24 hours'],
      [12 + 1 / 360, 25, 'ten seconds beyond 12 hours'],
      [11.5, 50, 'just inside 12 hours'],
      [1, 50, 'an hour before'],
      [-1 / 360, 100, 'ten seconds after the scheduled time'],
      [-2, 100, 'well after the scheduled time'],
    ];

    for (const [hoursBefore, expectedPercent, label] of CASES) {
      it(`charges ${expectedPercent}% ${label}`, async () => {
        const { scenario, bookingId, capturedAmountMinorUnits } = await seedCapturedBooking();
        await setHoursBeforeScheduled(bookingId, hoursBefore);

        const preview = await previewCancellation(scenario.customer.userId, bookingId);
        expect(preview.cancellable).toBe(true);
        expect(preview.tier?.feePercent).toBe(expectedPercent);

        const expectedFee = Math.floor((capturedAmountMinorUnits * expectedPercent) / 100 + 0.5);
        expect(preview.feeAmountMinorUnits).toBe(expectedFee);
        expect(preview.refundAmountMinorUnits).toBe(capturedAmountMinorUnits - expectedFee);
      });
    }

    it('the executed cancellation matches the preview exactly', async () => {
      const { scenario, bookingId } = await seedCapturedBooking();
      await setHoursBeforeScheduled(bookingId, 18);

      const preview = await previewCancellation(scenario.customer.userId, bookingId);
      const cancellation = await cancelBookingAsParticipant(
        scenario.customer.userId,
        bookingId,
        'customer',
        uniqueKey(),
      );

      expect(cancellation.tier.feePercent).toBe(preview.tier!.feePercent);
      expect(cancellation.feeAmountMinorUnits).toBe(preview.feeAmountMinorUnits);
      expect(cancellation.refundAmountMinorUnits).toBe(preview.refundAmountMinorUnits);
    });

    it('records fee + refund = captured at the database', async () => {
      const { scenario, bookingId, capturedAmountMinorUnits } = await seedCapturedBooking();
      await setHoursBeforeScheduled(bookingId, 18);
      await cancelBookingAsParticipant(scenario.customer.userId, bookingId, 'customer', uniqueKey());

      const stored = await storedCancellation(bookingId);
      expect(stored!.fee_amount_minor_units + stored!.refund_amount_minor_units).toBe(capturedAmountMinorUnits);
      expect(stored!.captured_amount_minor_units).toBe(capturedAmountMinorUnits);
    });
  });

  describe('authorization and eligible states (AC-7)', () => {
    /**
     * A booking cancelled with a PARTIAL refund stays `cancelled`: spec 022 moves a booking to
     * `refunded` only when the whole captured amount comes back, asserted separately below.
     */
    it('the customer may cancel a confirmed booking', async () => {
      const { scenario, bookingId } = await seedCapturedBooking();
      await setHoursBeforeScheduled(bookingId, 18);

      const cancellation = await cancelBookingAsParticipant(scenario.customer.userId, bookingId, 'customer', uniqueKey());
      expect(cancellation.cancelledByRole).toBe('customer');
      expect(cancellation.bookingStatus).toBe('cancelled');
      expect(await bookingStatusOf(bookingId)).toBe('cancelled');
    });

    it('the provider may cancel too, and is attributed as the provider', async () => {
      const { scenario, bookingId } = await seedCapturedBooking();
      await setHoursBeforeScheduled(bookingId, 18);

      const cancellation = await cancelBookingAsParticipant(scenario.provider.userId, bookingId, 'provider', uniqueKey());
      expect(cancellation.cancelledByRole).toBe('provider');
      expect(await bookingStatusOf(bookingId)).toBe('cancelled');
    });

    /**
     * The cross-spec seam, stated as a test: this spec transitions the booking to `cancelled`, and
     * spec 022 — on completing a refund for the WHOLE captured amount — moves it on to `refunded`
     * through the `cancelled -> refunded` pair it owns and seeds. Neither spec performs the other's
     * transition, and the end state proves both ran.
     */
    it('a fully refunded cancellation ends at refunded, via spec 022 own transition', async () => {
      const { scenario, bookingId } = await seedCapturedBooking();
      await setHoursBeforeScheduled(bookingId, 48);

      const cancellation = await cancelBookingAsParticipant(scenario.customer.userId, bookingId, 'customer', uniqueKey());
      expect(cancellation.bookingStatus).toBe('cancelled');
      expect(await bookingStatusOf(bookingId)).toBe('refunded');
    });

    it('cancels from provider_en_route and arrived as well', async () => {
      for (const target of ['provider_en_route', 'arrived'] as const) {
        const { scenario, bookingId } = await seedCapturedBooking();
        await setHoursBeforeScheduled(bookingId, 0.4);
        await advanceTo(scenario, bookingId, target);

        await cancelBookingAsParticipant(scenario.customer.userId, bookingId, 'customer', uniqueKey());
        expect(await bookingStatusOf(bookingId)).toBe('cancelled');
      }
    });

    /** A stranger cannot even learn the booking exists — `404`, never `403` (privacy-safe). */
    it('a non-participant gets BOOKING_NOT_FOUND, never FORBIDDEN', async () => {
      const { bookingId } = await seedCapturedBooking();
      const stranger = await seedStranger();

      await expectError(
        () => cancelBookingAsParticipant(stranger.customer.userId, bookingId, 'customer', uniqueKey()),
        'BOOKING_NOT_FOUND',
      );
      await expectError(() => previewCancellation(stranger.customer.userId, bookingId), 'BOOKING_NOT_FOUND');
    });

    it('a customer acting in provider mode on their own booking is not treated as the provider', async () => {
      const { scenario, bookingId } = await seedCapturedBooking();
      await expectError(
        () => cancelBookingAsParticipant(scenario.customer.userId, bookingId, 'provider', uniqueKey()),
        'BOOKING_NOT_FOUND',
      );
    });

    it('refuses an in_progress booking: that is a completion or dispute matter', async () => {
      const { scenario, bookingId } = await seedCapturedBooking();
      await setHoursBeforeScheduled(bookingId, 0.4);
      await advanceTo(scenario, bookingId, 'arrived');
      const { advanceBooking } = await import('@/lib/bookings/lifecycle');
      const { requireOwnProviderProfile } = await import('@/lib/availability/owner');
      const profile = await requireOwnProviderProfile(scenario.provider.userId);
      await advanceBooking(scenario.provider.userId, profile.id, bookingId, 'in_progress');

      const error = await expectError(
        () => cancelBookingAsParticipant(scenario.customer.userId, bookingId, 'customer', uniqueKey()),
        'BOOKING_NOT_CANCELLABLE',
      );
      expect(error.status).toBe(422);
      expect(await bookingStatusOf(bookingId)).toBe('in_progress');
    });

    it('refuses a second cancellation', async () => {
      const { scenario, bookingId } = await seedCapturedBooking();
      await setHoursBeforeScheduled(bookingId, 18);
      await cancelBookingAsParticipant(scenario.customer.userId, bookingId, 'customer', uniqueKey());

      await expectError(
        () => cancelBookingAsParticipant(scenario.customer.userId, bookingId, 'customer', uniqueKey()),
        'BOOKING_ALREADY_CANCELLED',
      );
    });

    /** Once spec 022 has refunded it in full, the booking is terminal for this spec too. */
    it('refuses to cancel a fully refunded booking', async () => {
      const { scenario, bookingId } = await seedCapturedBooking();
      await setHoursBeforeScheduled(bookingId, 48);
      await cancelBookingAsParticipant(scenario.customer.userId, bookingId, 'customer', uniqueKey());
      expect(await bookingStatusOf(bookingId)).toBe('refunded');

      await expectError(
        () => cancelBookingAsParticipant(scenario.customer.userId, bookingId, 'customer', uniqueKey()),
        'BOOKING_NOT_CANCELLABLE',
      );
    });

    it('reports a not-cancellable booking in the preview rather than throwing', async () => {
      const { scenario, bookingId } = await seedCapturedBooking();
      await setHoursBeforeScheduled(bookingId, 18);
      await cancelBookingAsParticipant(scenario.customer.userId, bookingId, 'customer', uniqueKey());

      const preview = await previewCancellation(scenario.customer.userId, bookingId);
      expect(preview.cancellable).toBe(false);
      expect(preview.blockedReason).toBe('BOOKING_ALREADY_CANCELLED');
    });
  });

  describe('the spec 022 handoff (AC-7)', () => {
    it('produces an eligibility decision spec 022 can execute', async () => {
      const { scenario, bookingId, capturedAmountMinorUnits } = await seedCapturedBooking();
      await setHoursBeforeScheduled(bookingId, 48);
      await cancelBookingAsParticipant(scenario.customer.userId, bookingId, 'customer', uniqueKey());

      const decision = await cancellationRefundEligibility(getDb(), bookingId);
      expect(decision.eligible).toBe(true);
      expect(decision.amountMinorUnits).toBe(capturedAmountMinorUnits);
      expect(decision.reason).toBe('cancellation_tier_0');
      expect(decision.decisionRef).toContain(bookingId);
    });

    it('a free cancellation produces a completed FULL refund through spec 022', async () => {
      const { scenario, bookingId, capturedAmountMinorUnits } = await seedCapturedBooking();
      await setHoursBeforeScheduled(bookingId, 48);
      await cancelBookingAsParticipant(scenario.customer.userId, bookingId, 'customer', uniqueKey());

      const refunds = await storedRefunds(bookingId);
      expect(refunds).toHaveLength(1);
      expect(refunds[0]!.total_amount_minor_units).toBe(capturedAmountMinorUnits);
      expect(refunds[0]!.status).toBe('completed');
      expect(refunds[0]!.source).toBe('policy');
    });

    it('a 25% tier produces a PARTIAL refund of the remainder', async () => {
      const { scenario, bookingId, capturedAmountMinorUnits } = await seedCapturedBooking();
      await setHoursBeforeScheduled(bookingId, 18);
      const cancellation = await cancelBookingAsParticipant(scenario.customer.userId, bookingId, 'customer', uniqueKey());

      const refunds = await storedRefunds(bookingId);
      expect(refunds).toHaveLength(1);
      expect(refunds[0]!.total_amount_minor_units).toBe(cancellation.refundAmountMinorUnits);
      expect(refunds[0]!.total_amount_minor_units).toBeLessThan(capturedAmountMinorUnits);
    });

    /** A 100% fee is "nothing is owed", which spec 022 expresses as ineligible — not a zero refund. */
    it('a 100% tier creates NO refund at all', async () => {
      const { scenario, bookingId } = await seedCapturedBooking();
      await setHoursBeforeScheduled(bookingId, -1);
      const cancellation = await cancelBookingAsParticipant(scenario.customer.userId, bookingId, 'customer', uniqueKey());

      expect(cancellation.refundAmountMinorUnits).toBe(0);
      expect(await storedRefunds(bookingId)).toHaveLength(0);

      const decision = await cancellationRefundEligibility(getDb(), bookingId);
      expect(decision.eligible).toBe(false);
    });

    it('the gate declines for a booking that was never cancelled', async () => {
      const { bookingId } = await seedCapturedBooking();
      expect((await cancellationRefundEligibility(getDb(), bookingId)).eligible).toBe(false);
    });
  });

  describe('idempotency and concurrency (AC-8)', () => {
    it('the same key replays one cancellation and one refund', async () => {
      const { scenario, bookingId } = await seedCapturedBooking();
      await setHoursBeforeScheduled(bookingId, 48);
      const key = uniqueKey();

      const first = await cancelBookingAsParticipant(scenario.customer.userId, bookingId, 'customer', key);
      const second = await cancelBookingAsParticipant(scenario.customer.userId, bookingId, 'customer', key);

      expect(second.id).toBe(first.id);
      expect(await storedRefunds(bookingId)).toHaveLength(1);
    });

    it('the same key with a different body is a conflict', async () => {
      const { scenario, bookingId } = await seedCapturedBooking();
      await setHoursBeforeScheduled(bookingId, 48);
      const key = uniqueKey();
      await cancelBookingAsParticipant(scenario.customer.userId, bookingId, 'customer', key, { reasonCode: 'plans_changed' });

      await expectError(
        () => cancelBookingAsParticipant(scenario.customer.userId, bookingId, 'customer', key, { reasonCode: 'other' }),
        'IDEMPOTENCY_KEY_CONFLICT',
      );
    });

    /** Two different keys racing: the row lock admits exactly one cancellation. */
    it('two concurrent cancellations admit exactly one', async () => {
      const { scenario, bookingId } = await seedCapturedBooking();
      await setHoursBeforeScheduled(bookingId, 48);

      const results = await Promise.allSettled([
        cancelBookingAsParticipant(scenario.customer.userId, bookingId, 'customer', uniqueKey()),
        cancelBookingAsParticipant(scenario.provider.userId, bookingId, 'provider', uniqueKey()),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await storedRefunds(bookingId)).toHaveLength(1);
      // `refunded` when spec 022's full refund completed, `cancelled` otherwise — either way, once.
      expect(['cancelled', 'refunded']).toContain(await bookingStatusOf(bookingId));
    });

    it('records exactly one cancellation row per booking', async () => {
      const { scenario, bookingId } = await seedCapturedBooking();
      await setHoursBeforeScheduled(bookingId, 48);
      await cancelBookingAsParticipant(scenario.customer.userId, bookingId, 'customer', uniqueKey());

      const { sql } = await import('drizzle-orm');
      const result = (await getDb().execute(
        sql`SELECT COUNT(*)::int AS count FROM booking_cancellations WHERE booking_id = ${bookingId}`,
      )) as unknown as { rows: Array<{ count: number }> };
      expect(result.rows[0]!.count).toBe(1);
    });

    /** A cancellation record is a financial record: append-only, by database trigger. */
    it('a recorded cancellation is immutable', async () => {
      const { scenario, bookingId } = await seedCapturedBooking();
      await setHoursBeforeScheduled(bookingId, 48);
      await cancelBookingAsParticipant(scenario.customer.userId, bookingId, 'customer', uniqueKey());

      const { sql } = await import('drizzle-orm');
      await expect(
        getDb().execute(sql`UPDATE booking_cancellations SET fee_amount_minor_units = 0 WHERE booking_id = ${bookingId}`),
      ).rejects.toThrow();
      await expect(
        getDb().execute(sql`DELETE FROM booking_cancellations WHERE booking_id = ${bookingId}`),
      ).rejects.toThrow();
    });
  });

  describe('the booking transition seam (AC-7)', () => {
    it('writes exactly one cancellation history row, attributed to the acting party', async () => {
      const { scenario, bookingId } = await seedCapturedBooking();
      await setHoursBeforeScheduled(bookingId, 48);
      await cancelBookingAsParticipant(scenario.customer.userId, bookingId, 'customer', uniqueKey());

      const { sql } = await import('drizzle-orm');
      const result = (await getDb().execute(
        sql`SELECT from_status, to_status, actor_role FROM bookings_status_history
             WHERE booking_id = ${bookingId} AND to_status = 'cancelled'`,
      )) as unknown as { rows: Array<{ from_status: string; to_status: string; actor_role: string }> };

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]!.from_status).toBe('confirmed');
      expect(result.rows[0]!.actor_role).toBe('customer');
    });
  });

  describe('provider-selectable options (AC-4)', () => {
    it('applies an option the effective version publishes', async () => {
      const { scenario, bookingId } = await seedCapturedBooking();
      const { serviceId } = await bookingScope(bookingId);
      await seedPolicyOverride({
        scope: 'service',
        scopeId: serviceId,
        config: flatConfig(80, [
          { key: 'flexible', tiers: [{ minHoursBefore: null, maxHoursBefore: null, feePercent: 0 }] },
        ]),
      });

      const { requireOwnProviderProfile } = await import('@/lib/availability/owner');
      const profile = await requireOwnProviderProfile(scenario.provider.userId);
      await setProviderCancellationOption(profile.id, serviceId, 'flexible');

      const resolved = await resolveEffectivePolicy(getDb(), serviceId, new Date(), { providerOptionKey: 'flexible' });
      expect(resolved.providerOptionKey).toBe('flexible');
      expect(resolved.tiers[0]!.feePercent).toBe(0);
    });

    it('refuses an option the policy does not allow', async () => {
      const { scenario, bookingId } = await seedCapturedBooking();
      const { serviceId } = await bookingScope(bookingId);
      const { requireOwnProviderProfile } = await import('@/lib/availability/owner');
      const profile = await requireOwnProviderProfile(scenario.provider.userId);

      const error = await expectError(
        () => setProviderCancellationOption(profile.id, serviceId, 'free_for_me'),
        'POLICY_OPTION_NOT_ALLOWED',
      );
      expect(error.status).toBe(422);
    });

    /**
     * A provider's stored key can go stale when a NEW version is published without that option — a
     * published version is immutable, so this is the only way it can happen. A customer's
     * cancellation must not fail because of it: the key is ignored and the version's own tiers apply.
     */
    it('a stale option key falls back to the version own tiers rather than failing a cancellation', async () => {
      const { bookingId } = await seedCapturedBooking();
      const { serviceId } = await bookingScope(bookingId);
      await seedPolicyOverride({ scope: 'service', scopeId: serviceId, config: flatConfig(40) });

      const resolved = await resolveEffectivePolicy(getDb(), serviceId, new Date(), {
        providerOptionKey: 'an_option_this_version_does_not_publish',
      });
      expect(resolved.providerOptionKey).toBeNull();
      expect(resolved.tiers[0]!.feePercent).toBe(40);
    });
  });

  describe('no client-controlled money (AC-3)', () => {
    /**
     * The domain entry point has no parameter through which an amount could arrive — the request
     * type carries only `reasonCode` and `note`. This asserts the recorded amounts come from the
     * policy and the capture, not from anything the caller said.
     */
    it('ignores everything the caller says about money', async () => {
      const { scenario, bookingId, capturedAmountMinorUnits } = await seedCapturedBooking();
      await setHoursBeforeScheduled(bookingId, 18);

      const cancellation = await cancelBooking({
        bookingId,
        idempotencyKey: uniqueKey(),
        actorUserId: scenario.customer.userId,
        actorRole: 'customer',
        // Deliberately shaped like an attempt to set a fee; the type permits neither field.
        body: { reasonCode: 'plans_changed', note: 'feeAmountMinorUnits=0 refundAmountMinorUnits=999999' } as never,
      });

      expect(cancellation.feeAmountMinorUnits).toBe(Math.floor((capturedAmountMinorUnits * 25) / 100 + 0.5));
      expect(cancellation.refundAmountMinorUnits).toBe(capturedAmountMinorUnits - cancellation.feeAmountMinorUnits);
    });
  });
});

/** The booking's customer, for the few assertions that need it before a scenario is in scope. */
async function seedContext(bookingId: string): Promise<{ customerUserId: string }> {
  const { sql } = await import('drizzle-orm');
  const result = (await getDb().execute(
    sql`SELECT cp.user_id AS customer_user_id FROM bookings b
          JOIN customer_profiles cp ON cp.id = b.customer_profile_id WHERE b.id = ${bookingId}`,
  )) as unknown as { rows: Array<{ customer_user_id: string }> };
  return { customerUserId: result.rows[0]!.customer_user_id };
}

void makeReportable;
