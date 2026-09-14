import { describe, expect, it } from 'vitest';
import { ALTERNATIVE_LOOKAHEAD_DAYS, MAX_ALTERNATIVES, formatLocalTimeOfDay } from './alternatives';

/**
 * Spec 020 §3 "Slot-conflict alternatives" (AC-2) — the pure parts of the contract.
 *
 * The scan itself needs a provider schedule and a busy loader, so its behaviour (ordering, the cap,
 * the horizon, the empty case, `sourceId` privacy) is proven end to end against a real database in
 * `lib/bookings/slot-conflict.integration.test.ts`. What is asserted here is the part that must be
 * true regardless of data: the published constants, and the time-of-day formatting that makes an
 * alternative re-submittable as the customer's OWN requested time.
 */
describe('slot-conflict alternatives (spec 020 AC-2)', () => {
  it('caps disclosure at three alternatives', () => {
    expect(MAX_ALTERNATIVES).toBe(3);
  });

  it('scans a fourteen local-day horizon', () => {
    expect(ALTERNATIVE_LOOKAHEAD_DAYS).toBe(14);
  });

  it.each([
    [0, '00:00'],
    [9 * 60, '09:00'],
    [9 * 60 + 30, '09:30'],
    [13 * 60 + 5, '13:05'],
    [23 * 60 + 59, '23:59'],
  ])('formats minute-of-day %i as %s', (minuteOfDay, expected) => {
    expect(formatLocalTimeOfDay(minuteOfDay)).toBe(expected);
  });

  it('always zero-pads, so a returned time round-trips as a stable HH:MM', () => {
    for (let minute = 0; minute < 1440; minute += 7) {
      expect(formatLocalTimeOfDay(minute)).toMatch(/^\d{2}:\d{2}$/);
    }
  });
});
