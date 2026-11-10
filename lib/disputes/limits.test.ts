/**
 * Spec 031 §6 unit — the appeal window and the spec's bounded constants (AC-4, DECIDED-4).
 *
 * PURE: no database, no I/O. The environment variable is set and restored per test, the way spec
 * 029's review-window suite does, so nothing leaks between files.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DISPUTE_APPEAL_WINDOW_DAYS,
  MAX_DISPUTE_APPEAL_WINDOW_DAYS,
  MAX_DISPUTE_EVIDENCE,
  MAX_DISPUTE_MESSAGES,
  MIN_DISPUTE_APPEAL_WINDOW_DAYS,
  appealWindowEndsAt,
  disputeAppealWindowDays,
  hasAppealWindowElapsed,
  isValidAppealWindowDays,
} from './limits';

const ORIGINAL = process.env.DISPUTE_APPEAL_WINDOW_DAYS;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.DISPUTE_APPEAL_WINDOW_DAYS;
  else process.env.DISPUTE_APPEAL_WINDOW_DAYS = ORIGINAL;
});

describe('dispute appeal window (spec 031)', () => {
  it('defaults to 7 days when nothing is configured', () => {
    delete process.env.DISPUTE_APPEAL_WINDOW_DAYS;
    expect(disputeAppealWindowDays()).toBe(DEFAULT_DISPUTE_APPEAL_WINDOW_DAYS);
    expect(DEFAULT_DISPUTE_APPEAL_WINDOW_DAYS).toBe(7);
  });

  it('honours a configured value inside the bounds', () => {
    process.env.DISPUTE_APPEAL_WINDOW_DAYS = '14';
    expect(disputeAppealWindowDays()).toBe(14);
  });

  it('falls back to the default for anything out of bounds or malformed, never throwing', () => {
    for (const bad of ['0', '31', '-1', '7.5', 'seven', '', 'NaN']) {
      process.env.DISPUTE_APPEAL_WINDOW_DAYS = bad;
      expect(disputeAppealWindowDays()).toBe(DEFAULT_DISPUTE_APPEAL_WINDOW_DAYS);
    }
  });

  it('validates the bounds explicitly', () => {
    expect(isValidAppealWindowDays(MIN_DISPUTE_APPEAL_WINDOW_DAYS)).toBe(true);
    expect(isValidAppealWindowDays(MAX_DISPUTE_APPEAL_WINDOW_DAYS)).toBe(true);
    expect(isValidAppealWindowDays(MIN_DISPUTE_APPEAL_WINDOW_DAYS - 1)).toBe(false);
    expect(isValidAppealWindowDays(MAX_DISPUTE_APPEAL_WINDOW_DAYS + 1)).toBe(false);
    expect(isValidAppealWindowDays(7.5)).toBe(false);
  });

  it('computes the deadline from resolved_at, exactly', () => {
    const resolvedAt = new Date('2026-09-01T12:00:00.000Z');
    expect(appealWindowEndsAt(resolvedAt, 7)?.toISOString()).toBe('2026-09-08T12:00:00.000Z');
  });

  it('returns null for a dispute that has not been resolved', () => {
    expect(appealWindowEndsAt(null, 7)).toBeNull();
    expect(hasAppealWindowElapsed(null, 7)).toBe(false);
  });

  it('returns null rather than an Invalid Date for unparseable input', () => {
    expect(appealWindowEndsAt('not-a-date', 7)).toBeNull();
  });

  it('treats the boundary instant as elapsed, so the deadline is inclusive of its own end', () => {
    const resolvedAt = new Date('2026-09-01T12:00:00.000Z');
    const exactly = new Date('2026-09-08T12:00:00.000Z');
    const justBefore = new Date('2026-09-08T11:59:59.999Z');

    expect(hasAppealWindowElapsed(resolvedAt, 7, exactly)).toBe(true);
    expect(hasAppealWindowElapsed(resolvedAt, 7, justBefore)).toBe(false);
  });

  it('accepts an ISO string as readily as a Date, because the row arrives either way', () => {
    expect(hasAppealWindowElapsed('2026-09-01T12:00:00.000Z', 7, new Date('2026-09-09T00:00:00.000Z'))).toBe(true);
  });
});

describe('dispute caps (spec 031)', () => {
  it('caps evidence at 10 per dispute, across both parties', () => {
    expect(MAX_DISPUTE_EVIDENCE).toBe(10);
  });

  it('caps the thread at 200 messages across all authors', () => {
    expect(MAX_DISPUTE_MESSAGES).toBe(200);
  });
});
