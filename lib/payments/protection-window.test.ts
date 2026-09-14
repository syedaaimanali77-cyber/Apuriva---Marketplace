import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROTECTION_WINDOW_HOURS,
  MAX_PROTECTION_WINDOW_HOURS,
  MIN_PROTECTION_WINDOW_HOURS,
  hasProtectionWindowElapsed,
  isValidProtectionWindowHours,
  nextProtectionState,
  protectionWindowEndsAt,
  resolveProtectionWindowHours,
} from './protection-window';

/** Spec 021 §3 "Protection window" — the pure arithmetic behind AC-5a, AC-5b and AC-5c. */
describe('protection window (spec 021 AC-5a/AC-5b/AC-5c)', () => {
  /** AC-5a — 48 hours unless a service or payment model configured something else. */
  it('uses the configured duration, defaulting to 48h', () => {
    expect(DEFAULT_PROTECTION_WINDOW_HOURS).toBe(48);
    expect(resolveProtectionWindowHours(null)).toBe(48);
    expect(resolveProtectionWindowHours(undefined)).toBe(48);
    expect(resolveProtectionWindowHours(72)).toBe(72);
    expect(resolveProtectionWindowHours(1)).toBe(1);
  });

  /** §4 I-6 — the window is configurable but bounded; an out-of-range value falls back, never applies. */
  it('rejects an out-of-range or non-integer duration and falls back to the default', () => {
    expect(isValidProtectionWindowHours(MIN_PROTECTION_WINDOW_HOURS)).toBe(true);
    expect(isValidProtectionWindowHours(MAX_PROTECTION_WINDOW_HOURS)).toBe(true);
    expect(isValidProtectionWindowHours(0)).toBe(false);
    expect(isValidProtectionWindowHours(721)).toBe(false);
    expect(isValidProtectionWindowHours(4.5)).toBe(false);
    expect(resolveProtectionWindowHours(0)).toBe(48);
    expect(resolveProtectionWindowHours(721)).toBe(48);
  });

  it('computes the window end from the start instant and the duration', () => {
    const start = new Date('2026-09-01T10:00:00.000Z');
    expect(protectionWindowEndsAt(start, 48)?.toISOString()).toBe('2026-09-03T10:00:00.000Z');
    expect(protectionWindowEndsAt(start.toISOString(), 1)?.toISOString()).toBe('2026-09-01T11:00:00.000Z');
  });

  /** An unopened window has no deadline — never a synthesized one that could release early. */
  it('has no end instant until the window has opened', () => {
    expect(protectionWindowEndsAt(null, 48)).toBeNull();
    expect(hasProtectionWindowElapsed(null, 48, new Date('2030-01-01T00:00:00.000Z'))).toBe(false);
  });

  it('treats the window as elapsed only at or after its end instant', () => {
    const start = new Date('2026-09-01T10:00:00.000Z');
    expect(hasProtectionWindowElapsed(start, 48, new Date('2026-09-03T09:59:59.999Z'))).toBe(false);
    expect(hasProtectionWindowElapsed(start, 48, new Date('2026-09-03T10:00:00.000Z'))).toBe(true);
    expect(hasProtectionWindowElapsed(start, 48, new Date('2026-09-04T00:00:00.000Z'))).toBe(true);
  });

  /** AC-5b — release requires BOTH an elapsed window and no dispute. */
  it('releases only on an elapsed window with no dispute', () => {
    expect(nextProtectionState({ current: 'held', disputeOpen: false, windowElapsed: true })).toBe('released');
    expect(nextProtectionState({ current: 'held', disputeOpen: false, windowElapsed: false })).toBe('held');
  });

  /**
   * AC-5c — an open dispute wins however much of the window has passed, elapsed or not. This is the
   * assertion that makes "payout stays blocked past window elapse" structural rather than incidental.
   */
  it('holds a disputed payment whether or not the window has elapsed', () => {
    expect(nextProtectionState({ current: 'held', disputeOpen: true, windowElapsed: false })).toBe('disputed');
    expect(nextProtectionState({ current: 'held', disputeOpen: true, windowElapsed: true })).toBe('disputed');
  });

  /** Neither `released` nor `disputed` is ever walked back by this spec. */
  it('never moves a payment out of released or disputed', () => {
    expect(nextProtectionState({ current: 'released', disputeOpen: true, windowElapsed: true })).toBe('released');
    expect(nextProtectionState({ current: 'disputed', disputeOpen: false, windowElapsed: true })).toBe('disputed');
  });
});
