import { describe, expect, it } from 'vitest';
import { anchorPendingToWallClock, setPlanFor } from './scenarios';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Spec 045 §3.3 — a set planned for an earlier `now` must not be born past spec 021 AC-9's expiry window. */
describe('anchorPendingToWallClock', () => {
  const now = new Date('2026-10-20T07:00:00.000Z');
  const wall = new Date(now.getTime() + DAY);

  for (const persona of ['customer', 'provider'] as const) {
    it(`re-anchors only the ${persona} set's pending bookings to the wall clock, keeping their timeline`, () => {
      const plan = setPlanFor(persona, now);
      const anchored = anchorPendingToWallClock(plan, now, wall);

      const pending = anchored.bookings.filter((booking) => booking.status === 'pending');
      expect(pending.length).toBeGreaterThan(0);
      for (const booking of pending) {
        const original = plan.bookings.find((candidate) => candidate.key === booking.key)!;
        expect(original.bookedAt.getTime()).toBeLessThan(now.getTime());
        expect(booking.bookedAt.getTime()).toBe(original.bookedAt.getTime() + DAY);
        expect(wall.getTime() - booking.bookedAt.getTime()).toBe(now.getTime() - original.bookedAt.getTime());
        expect(booking.scheduledAt).toEqual(original.scheduledAt);
      }
      for (const booking of anchored.bookings.filter((candidate) => candidate.status !== 'pending')) {
        expect(booking).toEqual(plan.bookings.find((candidate) => candidate.key === booking.key));
      }
      expect(anchored.providers).toEqual(plan.providers);
      expect(anchored.requests).toEqual(plan.requests);
    });
  }

  it('leaves a live plan untouched: the wall clock is `now`', () => {
    const plan = setPlanFor('customer', now);
    expect(anchorPendingToWallClock(plan, now, now)).toBe(plan);
  });
});
