/**
 * Spec 029 §6 — the one configurable value, and its bounds.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_REVIEW_WINDOW_DAYS,
  MAX_REVIEW_WINDOW_DAYS,
  MIN_REVIEW_WINDOW_DAYS,
  reviewWindowDays,
} from './limits';

const ORIGINAL = process.env.REVIEW_WINDOW_DAYS;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.REVIEW_WINDOW_DAYS;
  else process.env.REVIEW_WINDOW_DAYS = ORIGINAL;
});

describe('reviewWindowDays', () => {
  it('defaults to 14 when unset', () => {
    delete process.env.REVIEW_WINDOW_DAYS;
    expect(reviewWindowDays()).toBe(DEFAULT_REVIEW_WINDOW_DAYS);
    expect(DEFAULT_REVIEW_WINDOW_DAYS).toBe(14);
  });

  it('accepts a value inside the bounds', () => {
    process.env.REVIEW_WINDOW_DAYS = '30';
    expect(reviewWindowDays()).toBe(30);
  });

  it('accepts exactly the bounds', () => {
    process.env.REVIEW_WINDOW_DAYS = String(MIN_REVIEW_WINDOW_DAYS);
    expect(reviewWindowDays()).toBe(MIN_REVIEW_WINDOW_DAYS);
    process.env.REVIEW_WINDOW_DAYS = String(MAX_REVIEW_WINDOW_DAYS);
    expect(reviewWindowDays()).toBe(MAX_REVIEW_WINDOW_DAYS);
  });

  it('falls back to the default for anything out of range or malformed', () => {
    // A typo in an environment variable must not silently open or close the window forever.
    for (const value of ['0', '91', '-3', '7.5', 'fortnight', '']) {
      process.env.REVIEW_WINDOW_DAYS = value;
      expect(reviewWindowDays()).toBe(DEFAULT_REVIEW_WINDOW_DAYS);
    }
  });

  it('sits outside spec 021 default 48-hour protection window', () => {
    // §3 "Eligibility": reviewing must never be a lever on money, so the windows must not coincide.
    expect(DEFAULT_REVIEW_WINDOW_DAYS * 24).toBeGreaterThan(48);
  });
});
