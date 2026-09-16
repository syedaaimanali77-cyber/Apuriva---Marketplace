import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NO_SHOW_TRANSITIONS, isAllowedNoShowTransition, isTerminalNoShowStatus } from './state-machine';
import { NO_SHOW_STATUSES } from '@/lib/types/no-show';

/**
 * Spec 023 AC-5 — "do not automatically accuse" (master spec §51), asserted structurally.
 *
 * The rule is easy to state and easy to erode: someone adds a "helpful" sweep that closes obvious
 * cases, or a timestamp comparison that pre-fills an outcome, and the platform starts accusing
 * people. These tests make that a build failure rather than a judgement call.
 */
const NO_SHOW_DIR = join(process.cwd(), 'lib', 'no-show');

function sourceFiles(dir: string): Array<{ path: string; source: string }> {
  const results: Array<{ path: string; source: string }> = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.includes('.test.') || entry.includes('test-support')) continue;
    results.push({ path: full, source: readFileSync(full, 'utf8') });
  }
  return results;
}

const FILES = sourceFiles(NO_SHOW_DIR);
const RESOLUTION = join(NO_SHOW_DIR, 'resolution.ts');

/**
 * Strips comments before matching. These guards are about what the CODE does; prose that mentions
 * a rule ("this sweep sets no outcome") must not be mistaken for breaking it.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('no automatic accusation (spec 023 AC-5)', () => {
  /**
   * `outcome` is the fault finding. Exactly one module may write it, and that module requires an
   * authenticated admin holding `no_show_reports/resolve`.
   */
  it('sets an outcome in resolution.ts and nowhere else', () => {
    // An UPDATE that ASSIGNS `outcome`. A SELECT that FILTERS on it — reliability's count, the admin
    // queue's filter — is a read, and is exactly what AC-6 expects to exist.
    const writes = /SET[\s\S]{0,400}?\boutcome\s*=\s*\$\{/;
    const writers = FILES.filter(({ path, source }) => path !== RESOLUTION && writes.test(code(source)));
    expect(writers.map((f) => f.path)).toEqual([]);

    // And the one permitted writer really does write it, so this guard cannot pass vacuously.
    expect(writes.test(code(readFileSync(RESOLUTION, 'utf8')))).toBe(true);
  });

  it('never sets an outcome from the response-timeout sweep', () => {
    const sweep = code(readFileSync(join(NO_SHOW_DIR, 'sweep.ts'), 'utf8'));
    expect(sweep).not.toMatch(/outcome/);
    expect(sweep).not.toMatch(/no_show_confirmed/);
    // Nor may it touch the booking or any money: silence changes nothing but the review queue.
    expect(sweep).not.toMatch(/applyBookingTransition|cancelBooking|refund/i);
  });

  /**
   * AC-5: the location signal is supporting context. `resolution.ts` must not read it at all — not
   * "must weigh it lightly", must not see it — so a fault finding cannot rest on it even in principle.
   */
  it('never branches on the location signal when resolving', () => {
    const resolution = code(readFileSync(RESOLUTION, 'utf8'));
    expect(resolution).not.toMatch(/location_signal|locationSignal/);
    expect(resolution).not.toMatch(/address_within_service_area|address_outside_service_area/);
  });

  /** The consequence map is a closed set an admin picks from — never a computation over timestamps. */
  it('derives no outcome from timestamps', () => {
    const resolution = code(readFileSync(RESOLUTION, 'utf8'));
    expect(resolution).not.toMatch(/minutesAfterScheduled|minutes_after_scheduled/);
  });
});

describe('the no-show transition graph (spec 023 §3)', () => {
  it('allows exactly the four transitions the migration seeds', () => {
    expect([...NO_SHOW_TRANSITIONS]).toEqual([
      ['reported', 'awaiting_response'],
      ['awaiting_response', 'under_review'],
      ['awaiting_response', 'withdrawn'],
      ['under_review', 'resolved'],
    ]);
  });

  it('rejects every other pair, including anything out of a terminal state', () => {
    for (const from of NO_SHOW_STATUSES) {
      for (const to of NO_SHOW_STATUSES) {
        const declared = NO_SHOW_TRANSITIONS.some(([f, t]) => f === from && t === to);
        expect(isAllowedNoShowTransition(from, to), `${from} -> ${to}`).toBe(declared);
      }
    }
  });

  /** A resolved report is never reopened here: escalation after resolution is spec 031's. */
  it('has no transition out of resolved or withdrawn', () => {
    expect(isTerminalNoShowStatus('resolved')).toBe(true);
    expect(isTerminalNoShowStatus('withdrawn')).toBe(true);
    for (const to of NO_SHOW_STATUSES) {
      expect(isAllowedNoShowTransition('resolved', to)).toBe(false);
      expect(isAllowedNoShowTransition('withdrawn', to)).toBe(false);
    }
  });

  /** Nothing may skip the response step: `reported` cannot reach `under_review` or `resolved`. */
  it('cannot reach review or resolution without passing through awaiting_response', () => {
    expect(isAllowedNoShowTransition('reported', 'under_review')).toBe(false);
    expect(isAllowedNoShowTransition('reported', 'resolved')).toBe(false);
    expect(isAllowedNoShowTransition('awaiting_response', 'resolved')).toBe(false);
  });
});
