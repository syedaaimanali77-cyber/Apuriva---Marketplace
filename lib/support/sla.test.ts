/**
 * Spec 032 §6 "Unit" — the SLA clock (AC-8, DECIDED-5).
 *
 * All arithmetic, no database, so the pause/resume/recompute rules are pinned independently of any
 * SQL. The integration suite then proves the SQL agrees with them.
 */
import { describe, expect, it } from 'vitest';
import { SUPPORT_PRIORITIES } from '@/lib/types/support';
import {
  assertSlaTableValid,
  initialSlaDeadline,
  isSlaBreached,
  MAX_SLA_HOURS,
  MIN_SLA_HOURS,
  pausedSecondsBetween,
  recomputeSlaDeadline,
  resumeSlaDeadline,
  SLA_HOURS_BY_PRIORITY,
  slaHoursFor,
} from './sla';

const HOUR = 60 * 60 * 1000;
const T0 = new Date('2026-09-20T10:00:00.000Z');

describe('the SLA table', () => {
  it('is valid: in bounds and strictly tighter as urgency rises', () => {
    expect(() => assertSlaTableValid()).not.toThrow();
  });

  it('pins the documented product values', () => {
    expect(slaHoursFor('critical')).toBe(4);
    expect(slaHoursFor('high')).toBe(12);
    expect(slaHoursFor('medium')).toBe(24);
    expect(slaHoursFor('low')).toBe(72);
  });

  it('is exhaustive over SUPPORT_PRIORITIES', () => {
    expect(Object.keys(SLA_HOURS_BY_PRIORITY).sort()).toEqual([...SUPPORT_PRIORITIES].sort());
  });

  it('rejects a table that inverts the queue ranking — the reason these are constants', () => {
    expect(() =>
      assertSlaTableValid({ critical: 48, high: 12, medium: 24, low: 72 }),
    ).toThrow(/monotonic/);
  });

  it('rejects out-of-bounds durations', () => {
    expect(() => assertSlaTableValid({ critical: 0, high: 12, medium: 24, low: 72 })).toThrow(
      new RegExp(`${MIN_SLA_HOURS}`),
    );
    expect(() =>
      assertSlaTableValid({ critical: 4, high: 12, medium: 24, low: MAX_SLA_HOURS + 1 }),
    ).toThrow();
  });
});

describe('deadline arithmetic', () => {
  it('starts the clock at creation', () => {
    expect(initialSlaDeadline(T0, 'critical').getTime()).toBe(T0.getTime() + 4 * HOUR);
    expect(initialSlaDeadline(T0, 'low').getTime()).toBe(T0.getTime() + 72 * HOUR);
  });

  it('resuming pushes the deadline forward by EXACTLY the elapsed pause', () => {
    const deadline = new Date(T0.getTime() + 24 * HOUR);
    const awaitingSince = new Date(T0.getTime() + 2 * HOUR);
    const now = new Date(T0.getTime() + 5 * HOUR); // paused for 3 hours

    const resumed = resumeSlaDeadline(deadline, awaitingSince, now);
    expect(resumed.getTime()).toBe(deadline.getTime() + 3 * HOUR);
  });

  it('banks the pause in whole seconds', () => {
    expect(pausedSecondsBetween(T0, new Date(T0.getTime() + 90_000))).toBe(90);
    // Never negative, even if clocks disagree.
    expect(pausedSecondsBetween(T0, new Date(T0.getTime() - 5_000))).toBe(0);
  });

  it('a priority change re-anchors to CREATION plus the banked pause, never to now', () => {
    const pausedSeconds = 3 * 60 * 60; // 3h already spent waiting on the user
    const recomputed = recomputeSlaDeadline(T0, 'high', pausedSeconds);
    expect(recomputed.getTime()).toBe(T0.getTime() + 12 * HOUR + 3 * HOUR);
  });

  it('re-prioritising cannot buy time: the result does not depend on when it happens', () => {
    const a = recomputeSlaDeadline(T0, 'medium', 0);
    const b = recomputeSlaDeadline(T0, 'medium', 0);
    expect(a.getTime()).toBe(b.getTime());
    // And a tighter priority always yields an earlier deadline from the same anchor.
    expect(recomputeSlaDeadline(T0, 'critical', 0).getTime()).toBeLessThan(a.getTime());
  });
});

describe('isSlaBreached — the whole of the consequence', () => {
  const past = new Date(T0.getTime() - HOUR);

  it('flags a live ticket past its deadline', () => {
    expect(isSlaBreached('open', past, T0)).toBe(true);
    expect(isSlaBreached('assigned', past, T0)).toBe(true);
  });

  it('NEVER flags an awaiting_user ticket, however old its stored deadline', () => {
    // AC-8: the clock is paused and the platform is not the one holding things up.
    expect(isSlaBreached('awaiting_user', past, T0)).toBe(false);
    expect(isSlaBreached('awaiting_user', new Date(T0.getTime() - 1000 * HOUR), T0)).toBe(false);
  });

  it('never flags a ticket past resolution', () => {
    expect(isSlaBreached('resolved', past, T0)).toBe(false);
    expect(isSlaBreached('closed', past, T0)).toBe(false);
  });

  it('does not flag a ticket still inside its deadline', () => {
    expect(isSlaBreached('assigned', new Date(T0.getTime() + HOUR), T0)).toBe(false);
  });
});
