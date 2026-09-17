import { describe, expect, it } from 'vitest';
import { BOOKING_STATUSES } from '@/lib/db/schema';
import type { BookingStatus } from '@/lib/types/bookings';
import { isArchivedBookingStatus, isContactSharingAllowed } from './lifecycle';

/** Spec 025 §3 "Active vs. archived" and "Contact-sharing protection" — every booking status decided. */
describe('conversation lifecycle derivation (spec 025 §3)', () => {
  const ACTIVE: BookingStatus[] = ['pending', 'confirmed', 'provider_en_route', 'arrived', 'in_progress', 'completed', 'protected', 'disputed'];
  const ARCHIVED: BookingStatus[] = ['settled', 'cancelled', 'refunded', 'failed'];

  it('covers all twelve booking statuses exactly once', () => {
    expect([...ACTIVE, ...ARCHIVED].sort()).toEqual([...BOOKING_STATUSES].sort());
  });

  it.each(ACTIVE)('%s keeps the conversation active', (status) => {
    expect(isArchivedBookingStatus(status)).toBe(false);
  });

  it.each(ARCHIVED)('%s archives the conversation (read-only)', (status) => {
    expect(isArchivedBookingStatus(status)).toBe(true);
  });

  it('allows contact sharing only once the booking has reached confirmed', () => {
    expect(isContactSharingAllowed('pending')).toBe(false);
    expect(isContactSharingAllowed('failed')).toBe(false);
    for (const status of BOOKING_STATUSES.filter((s) => s !== 'pending' && s !== 'failed')) {
      expect(isContactSharingAllowed(status)).toBe(true);
    }
  });
});
