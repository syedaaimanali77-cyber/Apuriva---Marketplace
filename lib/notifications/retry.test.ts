import { afterEach, describe, expect, it } from 'vitest';
import { backoffMinutes, decideAfterAttempt, fallbackCandidates, maxAttemptsFor } from './retry';

/** Spec 026 AC-6 — the pure retry policy. */
describe('notification retry policy (spec 026 AC-6)', () => {
  const original = process.env.NOTIFICATION_MAX_ATTEMPTS;
  afterEach(() => {
    if (original === undefined) delete process.env.NOTIFICATION_MAX_ATTEMPTS;
    else process.env.NOTIFICATION_MAX_ATTEMPTS = original;
  });

  it('backs off exponentially: 2^attempts minutes', () => {
    expect([1, 2, 3, 4].map(backoffMinutes)).toEqual([2, 4, 8, 16]);
  });

  it('critical categories get NOTIFICATION_MAX_ATTEMPTS (default 5); non-critical get one retry', () => {
    delete process.env.NOTIFICATION_MAX_ATTEMPTS;
    expect(maxAttemptsFor('security')).toBe(5);
    expect(maxAttemptsFor('payments')).toBe(5);
    expect(maxAttemptsFor('operational')).toBe(5);
    expect(maxAttemptsFor('booking')).toBe(2);
    expect(maxAttemptsFor('promotions')).toBe(2);
    process.env.NOTIFICATION_MAX_ATTEMPTS = '3';
    expect(maxAttemptsFor('security')).toBe(3);
    process.env.NOTIFICATION_MAX_ATTEMPTS = 'garbage';
    expect(maxAttemptsFor('security')).toBe(5);
  });

  it('a critical failure retries until the ceiling, then fails, escalates and falls back', () => {
    delete process.env.NOTIFICATION_MAX_ATTEMPTS;
    for (let attempts = 1; attempts < 5; attempts += 1) {
      expect(decideAfterAttempt('payments', 'failed', attempts)).toEqual({ status: 'retrying', retryInMinutes: 2 ** attempts });
    }
    expect(decideAfterAttempt('payments', 'failed', 5)).toEqual({ status: 'failed', exhausted: true, escalate: true, fallback: true });
  });

  it('a non-critical failure is retried once, then abandoned quietly', () => {
    expect(decideAfterAttempt('booking', 'failed', 1)).toEqual({ status: 'retrying', retryInMinutes: 2 });
    expect(decideAfterAttempt('booking', 'failed', 2)).toEqual({ status: 'failed', exhausted: true, escalate: false, fallback: false });
  });

  it('unknown is never collapsed into delivered or failed, even at the ceiling', () => {
    expect(decideAfterAttempt('security', 'unknown', 1)).toEqual({ status: 'retrying', retryInMinutes: 2 });
    const exhausted = decideAfterAttempt('security', 'unknown', 5);
    expect(exhausted.status).toBe('retrying');
    expect(exhausted).toMatchObject({ retryInMinutes: null, exhausted: true, escalate: true });
  });

  it('delivered is terminal on the first attempt', () => {
    expect(decideAfterAttempt('promotions', 'delivered', 1)).toEqual({ status: 'delivered' });
  });

  it('the fallback order is fixed: push → email → sms', () => {
    expect(fallbackCandidates('push')).toEqual(['email', 'sms']);
    expect(fallbackCandidates('email')).toEqual(['sms']);
    expect(fallbackCandidates('sms')).toEqual([]);
  });
});
