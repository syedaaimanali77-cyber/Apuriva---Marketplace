import { afterEach, describe, expect, it } from 'vitest';
import { FILE_STATUSES } from '@/lib/types/files';
import { canTransition, decideAfterScan, isReadable, isTerminalStatus, scanBackoffMinutes } from './lifecycle';

/** Spec 027 AC-4 and AC-7 — the lifecycle policy, independent of any I/O. */
describe('file lifecycle (spec 027 AC-4, AC-7)', () => {
  const originalMaxAttempts = process.env.FILE_SCAN_MAX_ATTEMPTS;
  afterEach(() => {
    if (originalMaxAttempts === undefined) delete process.env.FILE_SCAN_MAX_ATTEMPTS;
    else process.env.FILE_SCAN_MAX_ATTEMPTS = originalMaxAttempts;
  });

  it('permits exactly the documented transitions', () => {
    expect(canTransition('pending', 'scanning')).toBe(true);
    expect(canTransition('pending', 'rejected')).toBe(true);
    expect(canTransition('scanning', 'ready')).toBe(true);
    expect(canTransition('scanning', 'rejected')).toBe(true);
    // The `unknown` retry is a real, repeatable step.
    expect(canTransition('scanning', 'scanning')).toBe(true);

    // Nothing reaches `ready` without passing through `scanning` — so nothing reaches it unscanned.
    expect(canTransition('pending', 'ready')).toBe(false);
  });

  it('terminal states cannot change', () => {
    expect(isTerminalStatus('ready')).toBe(true);
    expect(isTerminalStatus('rejected')).toBe(true);
    expect(isTerminalStatus('pending')).toBe(false);
    expect(isTerminalStatus('scanning')).toBe(false);

    for (const to of FILE_STATUSES) {
      expect(canTransition('ready', to), `ready -> ${to}`).toBe(false);
      // A rejected file is never re-admitted — not even back to `scanning` for another try.
      expect(canTransition('rejected', to), `rejected -> ${to}`).toBe(false);
    }
  });

  it('only a ready asset is readable — including by its own owner', () => {
    expect(isReadable('ready')).toBe(true);
    expect(isReadable('pending')).toBe(false);
    expect(isReadable('scanning')).toBe(false);
    expect(isReadable('rejected')).toBe(false);
  });

  it('a clean scan is the only path to ready', () => {
    expect(decideAfterScan('clean', 1)).toEqual({ status: 'ready' });
  });

  it('a rejection is terminal and always carries a reason code', () => {
    expect(decideAfterScan('rejected', 1, 'eicar')).toEqual({ status: 'rejected', reasonCode: 'eicar' });
    // Even a scanner that rejected without saying why yields a code, because C-5 requires one.
    expect(decideAfterScan('rejected', 1)).toEqual({ status: 'rejected', reasonCode: 'scan_rejected' });
  });

  it('unknown never becomes ready, at any attempt count', () => {
    process.env.FILE_SCAN_MAX_ATTEMPTS = '3';
    for (const attempts of [1, 2, 3, 4, 50]) {
      const decision = decideAfterScan('unknown', attempts);
      expect(decision.status, `attempt ${attempts}`).toBe('scanning');
      expect(decision.status).not.toBe('ready');
      expect(decision.status).not.toBe('rejected');
    }
  });

  it('backs off 2^attempts minutes until the ceiling, then stops being auto-claimed', () => {
    process.env.FILE_SCAN_MAX_ATTEMPTS = '4';
    expect(decideAfterScan('unknown', 1)).toEqual({ status: 'scanning', retryInMinutes: 2 });
    expect(decideAfterScan('unknown', 2)).toEqual({ status: 'scanning', retryInMinutes: 4 });
    expect(decideAfterScan('unknown', 3)).toEqual({ status: 'scanning', retryInMinutes: 8 });

    // At the ceiling: still `scanning` (never a guessed terminal), but `retryInMinutes: null` is
    // what takes it out of the sweep's claim path and into an operator's hands.
    expect(decideAfterScan('unknown', 4)).toEqual({ status: 'scanning', retryInMinutes: null, exhausted: true });

    expect(scanBackoffMinutes(1)).toBe(2);
    expect(scanBackoffMinutes(5)).toBe(32);
    // Defensive: an attempt count of 0 must never mean "retry immediately, forever".
    expect(scanBackoffMinutes(0)).toBe(2);
  });
});
