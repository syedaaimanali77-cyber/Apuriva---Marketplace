import { describe, expect, it } from 'vitest';
import { countdownSecondsRemaining, effectiveStatus, isLiveAt, OFFER_WINDOW_MS } from './timer';

const SENT = new Date('2026-09-14T10:00:00.000Z');
const EXPIRES = new Date(SENT.getTime() + OFFER_WINDOW_MS);
const at = (offsetMs: number) => new Date(SENT.getTime() + offsetMs);

describe('lib/offers/timer (spec 018 §3 "Timing rules")', () => {
  it('the offer window is exactly 2 minutes', () => {
    expect(OFFER_WINDOW_MS).toBe(2 * 60 * 1000);
  });

  it('an offer is live strictly before expires_at (T+1:59 and T+1:59.999)', () => {
    expect(isLiveAt('sent', EXPIRES, at(119_000))).toBe(true);
    expect(isLiveAt('viewed', EXPIRES, at(119_999))).toBe(true);
  });

  it('an offer is expired exactly at expires_at, and after it', () => {
    expect(isLiveAt('sent', EXPIRES, at(120_000))).toBe(false);
    expect(effectiveStatus('sent', EXPIRES, at(120_000))).toBe('expired');
    expect(effectiveStatus('viewed', EXPIRES, at(121_000))).toBe('expired');
  });

  it('terminal statuses are reported as stored, regardless of the clock (accepted never expires)', () => {
    for (const status of ['accepted', 'declined', 'withdrawn', 'expired'] as const) {
      expect(effectiveStatus(status, EXPIRES, at(10 * 60_000))).toBe(status);
    }
  });

  describe('countdownSecondsRemaining (display only)', () => {
    it('is derived from expiresAt - serverNow, not the device clock', () => {
      expect(countdownSecondsRemaining(EXPIRES.toISOString(), SENT.toISOString(), 0)).toBe(120);
      // A device clock hours off is irrelevant: only server-provided instants and elapsed time are used.
      expect(countdownSecondsRemaining(EXPIRES.toISOString(), at(30_000).toISOString(), 0)).toBe(90);
    });

    it('subtracts monotonic elapsed time since the fetch and never goes below 0', () => {
      expect(countdownSecondsRemaining(EXPIRES.toISOString(), SENT.toISOString(), 10_500)).toBe(110);
      expect(countdownSecondsRemaining(EXPIRES.toISOString(), SENT.toISOString(), 500_000)).toBe(0);
      expect(countdownSecondsRemaining(EXPIRES.toISOString(), at(130_000).toISOString(), 0)).toBe(0);
    });
  });
});
