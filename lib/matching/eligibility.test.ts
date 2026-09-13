import { describe, expect, it } from 'vitest';
import { evaluateCapacity, isVerified } from './eligibility';

/**
 * Pure-logic coverage only (no DB): `isVerified` and `evaluateCapacity` do no I/O. The composed
 * `evaluateEligibility` calls spec 016's DB-backed helpers (`isProviderEligibleForLocation`,
 * `availabilityFitAt`/`availabilityFitUnscheduled`) directly, so E1-E4's full exclusion behaviour
 * is covered by `lib/matching/eligibility.integration.test.ts` instead — this repository's
 * convention is that a plain `.test.ts` file never touches the database
 * (`lib/availability/resolve.test.ts`/`slots.test.ts` vs. `*.integration.test.ts`).
 */
describe('lib/matching/eligibility — pure rules (spec 017 AC-1)', () => {
  describe('isVerified (rule E4)', () => {
    it('only lifecycleStatus "active" is verified', () => {
      expect(isVerified('active')).toBe(true);
      for (const status of ['draft', 'pending_verification', 'paused', 'restricted', 'suspended', 'banned']) {
        expect(isVerified(status)).toBe(false);
      }
    });
  });

  describe('evaluateCapacity (rule E5 — DECIDED-1 documented no-op)', () => {
    it('always returns eligible, for any input', () => {
      expect(
        evaluateCapacity({
          providerProfileId: 'p1',
          lifecycleStatus: 'suspended',
          schedulingTimezone: 'Asia/Karachi',
          offersService: false,
          durationMinutes: 60,
        }),
      ).toEqual({ eligible: true });
    });

    it('never returns a reason (in particular, never "at_capacity" — reserved but unemitted this release)', () => {
      const result = evaluateCapacity({
        providerProfileId: 'p1',
        lifecycleStatus: 'active',
        schedulingTimezone: 'Asia/Karachi',
        offersService: true,
        durationMinutes: 60,
      });
      expect('reason' in result).toBe(false);
    });
  });
});
