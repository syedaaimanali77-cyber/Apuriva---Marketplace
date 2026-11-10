import { describe, expect, it } from 'vitest';
import {
  BOOKING_STATUSES,
  EARLY_START_GRACE_MINUTES,
  isAllowedBookingTransition,
  MIN_IN_PROGRESS_SECONDS,
  SPEC_020_TRANSITIONS,
} from './state-machine';
import type { BookingStatus } from '@/lib/types/bookings';

/** Spec 020 §2 AC-6, §3 "The complete transition matrix". */
describe('booking state machine (spec 020 AC-6)', () => {
  it('declares master spec §125\'s twelve statuses, authored once', () => {
    expect([...BOOKING_STATUSES]).toEqual([
      'pending',
      'confirmed',
      'provider_en_route',
      'arrived',
      'in_progress',
      'completed',
      'protected',
      'settled',
      'cancelled',
      'disputed',
      'refunded',
      'failed',
    ]);
  });

  it('seeds exactly the six transitions spec 020 performs', () => {
    expect(SPEC_020_TRANSITIONS.map(([from, to]) => `${from}->${to}`)).toEqual([
      'pending->confirmed',
      'confirmed->provider_en_route',
      'confirmed->arrived',
      'provider_en_route->arrived',
      'arrived->in_progress',
      'in_progress->completed',
    ]);
  });

  it('accepts every seeded pair', () => {
    for (const [from, to] of SPEC_020_TRANSITIONS) expect(isAllowedBookingTransition(from, to)).toBe(true);
  });

  it('rejects every pair outside the seeded graph', () => {
    const allowed = new Set(SPEC_020_TRANSITIONS.map(([from, to]) => `${from}->${to}`));
    for (const from of BOOKING_STATUSES) {
      for (const to of BOOKING_STATUSES) {
        if (allowed.has(`${from}->${to}`)) continue;
        expect(isAllowedBookingTransition(from as BookingStatus, to as BookingStatus)).toBe(false);
      }
    }
  });

  it.each([
    ['pending', 'in_progress'],
    ['pending', 'completed'],
    ['confirmed', 'completed'],
    ['confirmed', 'in_progress'],
    ['arrived', 'completed'],
    ['provider_en_route', 'in_progress'],
  ])('rejects the out-of-sequence jump %s -> %s', (from, to) => {
    expect(isAllowedBookingTransition(from as BookingStatus, to as BookingStatus)).toBe(false);
  });

  /** §3 "Payment boundary" / §7: reaching `completed` triggers nothing on the payment side. */
  it('owns no transition into protected or settled — spec 021 seeds and performs both', () => {
    expect(isAllowedBookingTransition('completed', 'protected')).toBe(false);
    expect(isAllowedBookingTransition('protected', 'settled')).toBe(false);
    expect(SPEC_020_TRANSITIONS.some(([, to]) => to === 'protected' || to === 'settled')).toBe(false);
  });

  /** §7: cancellation (023), disputes (031), refunds (022) and payment failure (021) are theirs. */
  it('owns no transition into cancelled, disputed, refunded or failed', () => {
    for (const terminal of ['cancelled', 'disputed', 'refunded', 'failed'] as BookingStatus[]) {
      expect(SPEC_020_TRANSITIONS.some(([, to]) => to === terminal)).toBe(false);
      for (const from of BOOKING_STATUSES) {
        expect(isAllowedBookingTransition(from as BookingStatus, terminal)).toBe(false);
      }
    }
  });

  /** Safeguard S8 — there is no un-complete; redress is spec 031's explicit dispute (AC-10). */
  it('makes completed terminal within this spec', () => {
    expect(SPEC_020_TRANSITIONS.some(([from]) => from === 'completed')).toBe(false);
  });

  /** AC-4 — the "on my way" step is optional, so `arrived` has two legal sources. */
  it('reaches arrived from confirmed directly as well as via provider_en_route', () => {
    expect(isAllowedBookingTransition('confirmed', 'arrived')).toBe(true);
    expect(isAllowedBookingTransition('provider_en_route', 'arrived')).toBe(true);
  });

  /** AC-11 — the two safeguard constants are exported so a later spec can tune without forking. */
  it('exports the AC-11 safeguard constants at their specified values', () => {
    expect(MIN_IN_PROGRESS_SECONDS).toBe(60);
    expect(EARLY_START_GRACE_MINUTES).toBe(60);
  });
});
