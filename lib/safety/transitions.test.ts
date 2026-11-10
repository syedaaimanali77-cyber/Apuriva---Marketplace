/**
 * Spec 030 §6 "Unit" — the safety report transition table.
 *
 * Exhaustive over every (from, to) pair rather than spot-checked, so a future edit that quietly
 * widens the table fails here rather than in production. The property that matters most is the last
 * one: `resolved` is TERMINAL (DECIDED-4).
 */
import { describe, expect, it } from 'vitest';
import { SAFETY_REPORT_STATUSES, type SafetyReportStatus } from '@/lib/types/safety';
import { canTransition, isOpenSafetyStatus, OPEN_SAFETY_STATUSES, SAFETY_TRANSITIONS } from './transitions';

const LEGAL: Array<[SafetyReportStatus, SafetyReportStatus]> = [
  ['submitted', 'under_review'],
  ['submitted', 'escalated'],
  ['submitted', 'resolved'],
  ['under_review', 'escalated'],
  ['under_review', 'resolved'],
  ['escalated', 'resolved'],
];

describe('spec 030 safety report lifecycle', () => {
  it('permits exactly the six transitions in the spec, and no others', () => {
    for (const from of SAFETY_REPORT_STATUSES) {
      for (const to of SAFETY_REPORT_STATUSES) {
        const expected = LEGAL.some(([f, t]) => f === from && t === to);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it('never permits a self-transition, so a repeated action is a conflict rather than a no-op', () => {
    for (const status of SAFETY_REPORT_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  describe("DECIDED-4: `resolved` is terminal", () => {
    it('has no outgoing transition at all — a report is never re-opened', () => {
      expect(SAFETY_TRANSITIONS.resolved).toEqual([]);
      for (const to of SAFETY_REPORT_STATUSES) {
        expect(canTransition('resolved', to)).toBe(false);
      }
    });

    it('is not an open status, so it leaves the queue', () => {
      expect(isOpenSafetyStatus('resolved')).toBe(false);
      expect(OPEN_SAFETY_STATUSES).not.toContain('resolved');
    });
  });

  it('treats every non-resolved status as open work', () => {
    expect(isOpenSafetyStatus('submitted')).toBe(true);
    expect(isOpenSafetyStatus('under_review')).toBe(true);
    expect(isOpenSafetyStatus('escalated')).toBe(true);
  });

  it('can always reach `resolved` from any open status, so nothing can become stuck', () => {
    for (const status of OPEN_SAFETY_STATUSES) {
      expect(canTransition(status, 'resolved')).toBe(true);
    }
  });
});
