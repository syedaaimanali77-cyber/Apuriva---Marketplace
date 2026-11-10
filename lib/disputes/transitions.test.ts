/**
 * Spec 031 §6 unit — the lifecycle table (AC-7, DECIDED-3). PURE: no database, no I/O.
 *
 * The properties asserted here are the ones the rest of the spec leans on: `closed` is terminal,
 * `closed` is the ONLY financially-final state, and no transition exists that the §3 table does not
 * name.
 */
import { describe, expect, it } from 'vitest';
import {
  CLOSEABLE_STATUSES,
  CONTRIBUTABLE_STATUSES,
  DISPUTE_TRANSITIONS,
  FINANCIALLY_OPEN_STATUSES,
  RESOLVABLE_STATUSES,
  canTransition,
  isCloseable,
  isContributable,
  isDisputeFinanciallyOpen,
  isResolvable,
} from './transitions';
import type { DisputeStatus } from '@/lib/types/disputes';

const ALL: DisputeStatus[] = ['open', 'under_review', 'resolved', 'appealed', 'closed'];

describe('dispute transitions (spec 031)', () => {
  it('AC-7: closed is terminal — it has no outgoing transition', () => {
    expect(DISPUTE_TRANSITIONS.closed).toEqual([]);
    for (const to of ALL) {
      expect(canTransition('closed', to)).toBe(false);
    }
  });

  it('allows exactly the transitions §3 names, and no others', () => {
    const allowed = new Set([
      'open->under_review',
      'open->resolved',
      'under_review->resolved',
      'resolved->appealed',
      'resolved->closed',
      'appealed->closed',
    ]);
    for (const from of ALL) {
      for (const to of ALL) {
        expect(canTransition(from, to)).toBe(allowed.has(`${from}->${to}`));
      }
    }
  });

  it('never allows a dispute to move backwards into open or under_review', () => {
    for (const from of ALL) {
      expect(canTransition(from, 'open')).toBe(false);
    }
    for (const from of ['resolved', 'appealed', 'closed'] as DisputeStatus[]) {
      expect(canTransition(from, 'under_review')).toBe(false);
    }
  });

  it('AC-2/AC-4: every status except closed is financially open, so money stays held through an appeal', () => {
    for (const status of ALL) {
      expect(isDisputeFinanciallyOpen(status)).toBe(status !== 'closed');
    }
    // The load-bearing case: a RESOLVED dispute still holds the money.
    expect(isDisputeFinanciallyOpen('resolved')).toBe(true);
    expect(isDisputeFinanciallyOpen('appealed')).toBe(true);
    expect(FINANCIALLY_OPEN_STATUSES).not.toContain('closed');
  });

  it('is resolvable only from open and under_review', () => {
    expect(RESOLVABLE_STATUSES).toEqual(['open', 'under_review']);
    for (const status of ALL) {
      expect(isResolvable(status)).toBe(status === 'open' || status === 'under_review');
    }
  });

  it('accepts new material while open, under_review or appealed — but never once resolved or closed', () => {
    expect(CONTRIBUTABLE_STATUSES).toEqual(['open', 'under_review', 'appealed']);
    // A decided case is frozen; an appeal is precisely the stage that reopens it for new material.
    expect(isContributable('resolved')).toBe(false);
    expect(isContributable('appealed')).toBe(true);
    expect(isContributable('closed')).toBe(false);
  });

  it('is closeable only from resolved and appealed — a dispute is never closed before it is decided', () => {
    expect(CLOSEABLE_STATUSES).toEqual(['resolved', 'appealed']);
    expect(isCloseable('open')).toBe(false);
    expect(isCloseable('under_review')).toBe(false);
    expect(isCloseable('closed')).toBe(false);
  });

  it('defines a transition list for every status, so the table is total', () => {
    for (const status of ALL) {
      expect(Array.isArray(DISPUTE_TRANSITIONS[status])).toBe(true);
    }
    expect(Object.keys(DISPUTE_TRANSITIONS).sort()).toEqual([...ALL].sort());
  });
});
